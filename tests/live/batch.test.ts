// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';

import { createOpenAlex, normalizeDoi, normalizeWorkId } from '../../src/index.js';
import { batchOf, errorOf } from '../helpers.js';
import inputs from './batch-inputs.json' with { type: 'json' };
import paging from './paging-inputs.json' with { type: 'json' };

const apiKey = Bun.env.OPENALEX_API_KEY;
const { fetchDoi, fetchWorkById } = createOpenAlex(apiKey ? { apiKey } : {});
const TIMEOUT = 120_000;

const MISSING = [
    '10.21071/edmetic.v14.i1.17395',
    '10.22937/ijcsns.2022.22.5.97',
    '10.26423/rcpi.v13i2.1379',
    '10.17083/ijsg.v10i3.603y',
];
const MULTI = ['10.1051/0004-6361/201833910', '10.1016/s0140-6736(20)30937-5'] as const;
const PREPRINT = '10.48550/arxiv.1706.03762';
const RECENT = ['10.1016/j.lmot.2025.102196', '10.1109/taffc.2025.3619161', '10.1016/j.ecolecon.2025.108805'];
const MANY_AUTHORS = 'W4288079944';

function workId(raw: { id?: unknown }): string {
    return String(raw.id).replace('https://openalex.org/', '');
}

function outcomes(data: {
    readonly works: Readonly<Record<string, { readonly raw: { id?: unknown } } | null>>;
    readonly errors: Readonly<Record<string, { readonly code: string }>>;
}): Record<string, string | null> {
    const found = Object.entries(data.works).map(([input, work]) => [input, work === null ? null : workId(work.raw)]);
    const failed = Object.entries(data.errors).map(([input, error]) => [input, error.code]);
    return Object.fromEntries([...found, ...failed]);
}

describe.skipIf(Bun.env.OPENALEX_LIVE !== '1')('live: batch lookup', () => {
    test(
        '150 DOIs: two list requests, input order, every hit holds its DOI',
        async () => {
            const result = batchOf(await fetchDoi(inputs.dois));
            expect(Object.keys(result.works)).toEqual([...new Set(inputs.dois)]);
            expect(result.errors).toEqual({});
            expect(result.requests.list).toBe(2);
            expect(result.budget).not.toBeNull();
            const found = Object.entries(result.works).filter(([, work]) => work !== null);
            expect(found.length).toBeGreaterThan(140);
            for (const [input, work] of found) {
                expect(work?.requestedDoi).toBe(normalizeDoi(input) as string);
            }
        },
        TIMEOUT,
    );

    test(
        'batch and single strategies pick the same works',
        async () => {
            const dois = [...inputs.dois.slice(0, 20), ...MULTI, PREPRINT, ...RECENT];
            const [batch, single] = await Promise.all([
                fetchDoi(dois).then(batchOf),
                fetchDoi(dois, { strategy: 'single' }).then(batchOf),
            ]);
            expect(single.requests).toEqual({ list: 0, single: dois.length });
            expect(outcomes(batch)).toEqual(outcomes(single));
        },
        TIMEOUT,
    );

    test(
        'unknown DOIs are null next to found ones',
        async () => {
            const first = inputs.dois[0] as string;
            const result = batchOf(await fetchDoi([first, ...MISSING]));
            expect(result.works[first]).not.toBeNull();
            for (const doi of MISSING) {
                expect(result.works[doi]).toBeNull();
            }
            expect(result.errors).toEqual({});
        },
        TIMEOUT,
    );

    test(
        'a DOI held by two works resolves to one work',
        async () => {
            const result = batchOf(await fetchDoi(MULTI));
            expect(outcomes(result)).toEqual({ [MULTI[0]]: 'W4288079944', [MULTI[1]]: 'W3017125154' });
        },
        TIMEOUT,
    );

    test(
        'a preprint DOI found only in locations',
        async () => {
            const result = batchOf(await fetchDoi([PREPRINT, inputs.dois[0] as string]));
            const work = result.works[PREPRINT];
            expect(work && workId(work.raw)).toBe('W2626778328');
            expect(work?.requestedDoi).toBe(PREPRINT);
        },
        TIMEOUT,
    );

    test(
        'recent DOIs missing from the list fall back to single lookup',
        async () => {
            const result = batchOf(await fetchDoi(RECENT));
            for (const doi of RECENT) {
                expect(result.works[doi]).toBeTruthy();
            }
        },
        TIMEOUT,
    );

    test(
        'duplicates in any spelling share one work and one list entry',
        async () => {
            const doi = inputs.dois[1] as string;
            const spellings = [doi, `https://doi.org/${doi.toUpperCase()}`, `doi:${doi}`, doi];
            const result = batchOf(await fetchDoi(spellings));
            // the repeated spelling appears once
            expect(Object.keys(result.works)).toEqual(spellings.slice(0, 3));
            const works = Object.values(result.works);
            expect(new Set(works.map((work) => work?.requestedDoi))).toEqual(new Set([doi]));
            expect(new Set(works.map((work) => work && workId(work.raw))).size).toBe(1);
            expect(result.requests).toEqual({ list: 1, single: 0 });
        },
        TIMEOUT,
    );

    test(
        'only invalid inputs fail the whole lookup without requests',
        async () => {
            expect(errorOf(await fetchDoi(['nope', '', '10.1/x'])).code).toBe('INVALID_DOI');
            const mixed = batchOf(await fetchDoi(['nope', inputs.dois[0] as string]));
            expect(mixed.errors.nope?.code).toBe('INVALID_DOI');
            expect(mixed.requests).toEqual({ list: 1, single: 0 });
        },
        TIMEOUT,
    );

    test(
        'a DOI with a comma or space goes to single lookup',
        async () => {
            const odd = ['10.9999/a,b', '10.1007/978-3-030-14227-8_3 10.1007/978-3-030-14227-8'];
            const listed = inputs.dois[2] as string;
            const result = batchOf(await fetchDoi([...odd, listed]));
            expect(result.requests).toEqual({ list: 1, single: 2 });
            expect(result.works[listed]).toBeTruthy();
            expect(result.errors).toEqual({});
            expect(Object.keys(result.works)).toHaveLength(3);
        },
        TIMEOUT,
    );

    test(
        '150 work ids: two list requests, every hit has its id or a merge target',
        async () => {
            const result = batchOf(await fetchWorkById(inputs.ids));
            expect(Object.keys(result.works)).toEqual([...new Set(inputs.ids)]);
            expect(result.requests.list).toBe(2);
            const found = Object.entries(result.works).filter(([, work]) => work !== null);
            expect(found.length).toBeGreaterThan(140);
            for (const [input, work] of found) {
                expect(work?.requestedId).toBe(normalizeWorkId(input) as string);
            }
        },
        TIMEOUT,
    );

    test(
        'a work with more than 100 authorships is refetched in full',
        async () => {
            const result = batchOf(await fetchWorkById([MANY_AUTHORS, inputs.ids[0] as string]));
            expect(result.works[MANY_AUTHORS]?.raw.authorships?.length).toBeGreaterThan(100);
            expect(result.requests).toEqual({ list: 1, single: 1 });
        },
        TIMEOUT,
    );

    test(
        'a string input still returns a single Result',
        async () => {
            const result = await fetchWorkById(inputs.ids[0] as string);
            expect(result.ok).toBe(true);
        },
        TIMEOUT,
    );
});

const PAGED_MULTI = ['10.5281/zenodo.7388437', '10.5281/zenodo.6913032'] as const;
const PER_PAGE = 100;

async function listAllPages(dois: readonly string[]): Promise<{ count: number; ids: string[]; pages: number }> {
    const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    const filter = dois.map(encodeURIComponent).join('|');
    const ids: string[] = [];
    let count = 0;
    let pages = 0;
    do {
        pages += 1;
        const url = `https://api.openalex.org/works?filter=doi:${filter}&per_page=${PER_PAGE}&page=${pages}&sort=cited_by_count:desc`;
        const body = (await (await fetch(url, { headers })).json()) as {
            meta: { count: number };
            results: { id: string }[];
        };
        count = body.meta.count;
        ids.push(...body.results.map(workId));
    } while (ids.length < count && pages * PER_PAGE < count);
    return { count, ids, pages };
}

describe.skipIf(Bun.env.OPENALEX_LIVE !== '1')('live: list paging', () => {
    test(
        '100 DOIs with 102 matching works: every page is read and counted, a duplicate DOI picks its owner',
        async () => {
            const [result, listed] = await Promise.all([
                fetchDoi(paging.dois).then(batchOf),
                listAllPages(paging.dois),
            ]);
            // the API side: more matches than keys, all of them across pages, no W id twice
            expect(listed.count).toBeGreaterThan(PER_PAGE);
            expect(listed.ids).toHaveLength(listed.count);
            expect(new Set(listed.ids).size).toBe(listed.count);
            expect(listed.pages).toBe(Math.ceil(listed.count / PER_PAGE));
            // the package read the same pages and needed no single lookup
            expect(result.requests).toEqual({ list: listed.pages, single: 0 });
            expect(result.budget?.cost_usd).toBeCloseTo(0.0001 * listed.pages);
            expect(result.errors).toEqual({});
            const found = Object.values(result.works).map((work) => work && workId(work.raw));
            expect(found).not.toContain(null);
            for (const id of found) {
                expect(listed.ids).toContain(id as string);
            }
            // the work that owns the DOI wins over a location holder, then the more cited owner; the owner
            // of zenodo.6913032 has 0 citations and may be on page 2
            const picked = outcomes(result);
            expect(Object.fromEntries(PAGED_MULTI.map((doi) => [doi, picked[doi]]))).toEqual({
                [PAGED_MULTI[0]]: 'W7215126492',
                [PAGED_MULTI[1]]: 'W4393519413',
            });
        },
        TIMEOUT,
    );

    test(
        'singleBelow sends a small chunk as free single lookups',
        async () => {
            const dois = inputs.dois.slice(0, 4);
            const result = batchOf(await fetchDoi(dois, { singleBelow: 10 }));
            expect(result.requests).toEqual({ list: 0, single: dois.length });
            expect(result.budget?.cost_usd ?? 0).toBe(0);
            expect(Object.values(result.works).filter((work) => work !== null).length).toBeGreaterThan(2);
        },
        TIMEOUT,
    );
});
