// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createOpenAlex, type OpenAlex, type OpenAlexOptions } from '../../src/client.js';
import type { OpenAlexWork } from '../../src/work/api-types.js';
import {
    batchOf,
    errorOf,
    type FetchTrap,
    installGlobalFetchTrap,
    jsonResponse,
    loadWork,
    makeFetch,
    type RecordedCall,
} from '../helpers.js';

type WorkSpec = {
    readonly id: string;
    readonly doi?: string;
    readonly locationDois?: readonly string[];
    readonly cited?: number;
    readonly authorships?: number;
};

type Server = {
    readonly works: OpenAlexWork[];
    readonly hiddenFromList: Set<string>;
    readonly merged: Map<string, string>;
};

type BatchView = {
    readonly works: Readonly<Record<string, { readonly record: { readonly id?: unknown } } | null>>;
    readonly errors: Readonly<Record<string, { readonly code: string }>>;
};

const LIMITS = { rps: 10_000 } as const;
const NO_RETRY = { maxRetries: 0, retryDelayMs: 0 } as const;

let base: OpenAlexWork;
let trap: FetchTrap;

beforeEach(async () => {
    base = await loadWork('work-article');
    trap = installGlobalFetchTrap();
});

afterEach(() => {
    trap.assertUntouched();
    trap.restore();
});

function client(fetchFn: typeof fetch, opts: OpenAlexOptions = {}): OpenAlex {
    return createOpenAlex({ fetchFn, limits: LIMITS, ...opts });
}

function makeWork(spec: WorkSpec): OpenAlexWork {
    const doiUrl = spec.doi === undefined ? null : `https://doi.org/${spec.doi}`;
    const locations = [
        ...(spec.doi === undefined ? [] : [{ id: `doi:${spec.doi}`, landing_page_url: doiUrl }]),
        ...(spec.locationDois ?? []).map((doi) => ({ id: `doi:${doi}`, landing_page_url: `https://doi.org/${doi}` })),
    ];
    const authorship = base.authorships?.[0];
    return {
        ...base,
        id: `https://openalex.org/${spec.id}`,
        doi: doiUrl,
        ids: { openalex: `https://openalex.org/${spec.id}`, ...(doiUrl === null ? {} : { doi: doiUrl }) },
        cited_by_count: spec.cited ?? 0,
        locations,
        authorships: Array.from({ length: spec.authorships ?? 1 }, () => authorship),
    } as unknown as OpenAlexWork;
}

function makeServer(specs: readonly WorkSpec[]): Server {
    return { works: specs.map(makeWork), hiddenFromList: new Set(), merged: new Map() };
}

function shortId(work: OpenAlexWork): string {
    return String(work.id).replace('https://openalex.org/', '');
}

function workNumber(work: OpenAlexWork): number {
    return Number(shortId(work).slice(1));
}

function hasDoi(work: OpenAlexWork, doi: string): boolean {
    const wanted = doi.toLowerCase();
    if (String(work.doi).toLowerCase() === `https://doi.org/${wanted}`) {
        return true;
    }
    return (work.locations ?? []).some((location) => String(location.id).toLowerCase() === `doi:${wanted}`);
}

function notFound(): Response {
    return jsonResponse({ error: 'not found' }, { status: 404 });
}

function failing(status: number): Response {
    return jsonResponse({ error: 'boom' }, { status });
}

function listView(work: OpenAlexWork): OpenAlexWork {
    return {
        ...work,
        authorships: (work.authorships ?? []).slice(0, 100),
        locations: (work.locations ?? []).slice(0, 100),
    } as OpenAlexWork;
}

function answer(server: Server, call: RecordedCall): Response {
    const url = new URL(call.url);
    const filter = url.searchParams.get('filter');
    if (url.pathname === '/works' && filter !== null) {
        const [field, ...rest] = filter.split(':');
        const values = rest.join(':').split('|');
        const listed = server.works.filter((work) => !server.hiddenFromList.has(shortId(work)));
        const results =
            field === 'doi'
                ? listed.filter((work) => values.some((doi) => hasDoi(work, doi)))
                : listed.filter((work) => values.includes(shortId(work)));
        // most cited first, ties by W number, then one page of per_page works, as OpenAlex does
        results.sort((a, b) => (b.cited_by_count ?? 0) - (a.cited_by_count ?? 0) || workNumber(a) - workNumber(b));
        const perPage = Number(url.searchParams.get('per_page'));
        const page = Number(url.searchParams.get('page'));
        const slice = results.slice((page - 1) * perPage, page * perPage);
        return jsonResponse({ meta: { count: results.length }, results: slice.map(listView) });
    }
    const path = decodeURIComponent(url.pathname.replace('/works/', ''));
    if (path.startsWith('doi:')) {
        const doi = path.slice('doi:'.length);
        const candidates = server.works.filter((work) => hasDoi(work, doi));
        // the work that owns the DOI first, then the most cited
        const owns = (work: OpenAlexWork) =>
            Number(String(work.doi).toLowerCase() === `https://doi.org/${doi.toLowerCase()}`);
        candidates.sort((a, b) => owns(b) - owns(a) || (b.cited_by_count ?? 0) - (a.cited_by_count ?? 0));
        return candidates[0] === undefined ? notFound() : jsonResponse(candidates[0]);
    }
    const id = server.merged.get(path) ?? path;
    const work = server.works.find((candidate) => shortId(candidate) === id);
    return work === undefined ? notFound() : jsonResponse(work);
}

function serve(server: Server) {
    return makeFetch((call: RecordedCall) => answer(server, call));
}

function isList(call: RecordedCall): boolean {
    return new URL(call.url).searchParams.has('filter');
}

function filterValues(call: RecordedCall): string[] {
    const filter = new URL(call.url).searchParams.get('filter') ?? '';
    return filter.slice(filter.indexOf(':') + 1).split('|');
}

function urlHas(call: RecordedCall, text: string): boolean {
    return decodeURIComponent(call.url).includes(text);
}

function outcomes(batch: BatchView): Record<string, string | null> {
    expect(Object.keys(batch.errors).filter((input) => Object.hasOwn(batch.works, input))).toEqual([]);
    return Object.fromEntries([
        ...Object.entries(batch.works).map(([input, work]) => [input, work === null ? null : String(work.record.id)]),
        ...Object.entries(batch.errors).map(([input, error]) => [input, error.code]),
    ]);
}

describe('fetchDoi with a string or an array', () => {
    test('a string returns one Result from a single lookup', async () => {
        const { fn, calls } = serve(makeServer([{ id: 'W1', doi: '10.1000/a' }]));
        const result = await client(fn).fetchDoi('10.1000/a');
        expect(result.ok && result.data.record.id).toBe('W1');
        expect(result.ok && 'works' in result.data).toBe(false);
        expect(calls).toHaveLength(1);
        expect(isList(calls[0] as RecordedCall)).toBe(false);
    });

    test('an array returns works keyed by input as given, in input order, from one list request', async () => {
        const { fn, calls } = serve(
            makeServer([
                { id: 'W1', doi: '10.1000/a' },
                { id: 'W2', doi: '10.1000/b' },
                { id: 'W3', doi: '10.1000/c' },
            ]),
        );
        const inputs = ['10.1000/c', 'https://doi.org/10.1000/A', '10.1000/b'];
        const result = batchOf(await client(fn).fetchDoi(inputs));
        expect(Object.keys(result.works)).toEqual(inputs);
        expect(Object.keys(result.errors)).toEqual([]);
        expect(outcomes(result)).toEqual({ '10.1000/c': 'W3', 'https://doi.org/10.1000/A': 'W1', '10.1000/b': 'W2' });
        expect(result.requests).toEqual({ list: 1, single: 0 });
        expect(calls).toHaveLength(1);
        expect(filterValues(calls[0] as RecordedCall).sort()).toEqual(['10.1000/a', '10.1000/b', '10.1000/c']);
        expect(new URL((calls[0] as RecordedCall).url).searchParams.get('sort')).toBe('cited_by_count:desc');
    });

    test('requestedDoi is the normalized DOI of each input', async () => {
        const { fn } = serve(makeServer([{ id: 'W1', doi: '10.1000/a' }]));
        const result = batchOf(await client(fn).fetchDoi(['DOI:10.1000/A']));
        expect(result.works['DOI:10.1000/A']?.requestedDoi).toBe('10.1000/a');
    });

    test('an empty array returns no works or errors and sends nothing', async () => {
        const { fn, calls } = serve(makeServer([]));
        const result = await client(fn).fetchDoi([]);
        expect(result).toEqual({
            ok: true,
            data: { works: {}, errors: {}, budget: null, requests: { list: 0, single: 0 } },
        });
        expect(calls).toHaveLength(0);
    });
});

describe('array lookup matching', () => {
    test('inputs with the same DOI share one filter value but keep an entry each', async () => {
        const { fn, calls } = serve(makeServer([{ id: 'W1', doi: '10.1000/a' }]));
        const result = batchOf(await client(fn).fetchDoi(['10.1000/a', 'https://doi.org/10.1000/A', 'doi:10.1000/a']));
        expect(outcomes(result)).toEqual({
            '10.1000/a': 'W1',
            'https://doi.org/10.1000/A': 'W1',
            'doi:10.1000/a': 'W1',
        });
        expect(filterValues(calls[0] as RecordedCall)).toEqual(['10.1000/a']);
    });

    test('a repeated input string appears once, and "__proto__" is an ordinary key', async () => {
        const { fn, calls } = serve(makeServer([{ id: 'W1', doi: '10.1000/a' }]));
        const proto = '__proto__';
        const result = batchOf(await client(fn).fetchDoi([proto, '10.1000/a', proto, '10.1000/a']));
        expect(Object.keys(result.works)).toEqual(['10.1000/a']);
        expect(Object.keys(result.errors)).toEqual([proto]);
        expect(Object.hasOwn(result.errors, proto)).toBe(true);
        expect(result.errors[proto]?.code).toBe('INVALID_DOI');
        expect(Object.getPrototypeOf(result.works)).toBeNull();
        expect(Object.getPrototypeOf(result.errors)).toBeNull();
        expect(({} as Record<string, unknown>).code).toBeUndefined();
        expect(calls).toHaveLength(1);
        expect(filterValues(calls[0] as RecordedCall)).toEqual(['10.1000/a']);
    });

    test('a cut list page does not settle a DOI found only in a location; single lookup does', async () => {
        const server = makeServer([
            { id: 'W1', doi: '10.1000/holder', locationDois: ['10.1000/owned'], cited: 100 },
            { id: 'W2', doi: '10.1000/owned', cited: 1 },
        ]);
        const holder = server.works[0] as OpenAlexWork;
        const owner = server.works[1] as OpenAlexWork;
        // the owner is less cited and on page 2: page 1 holds only the holder, of 2 matches
        const { fn, calls } = makeFetch((call: RecordedCall) =>
            isList(call)
                ? jsonResponse({ meta: { count: 2 }, results: [holder] })
                : jsonResponse(urlHas(call, 'owned') ? owner : holder),
        );
        const result = batchOf(await client(fn).fetchDoi(['10.1000/owned', '10.1000/holder']));
        expect(outcomes(result)).toEqual({ '10.1000/owned': 'W2', '10.1000/holder': 'W1' });
        // the holder owns its own DOI, so the cut page settles it
        expect(result.requests).toEqual({ list: 1, single: 1 });
        expect(calls).toHaveLength(2);
    });

    test('a preprint DOI found only in locations maps to the work that holds it', async () => {
        const { fn, calls } = serve(
            makeServer([{ id: 'W9', doi: '10.1000/journal', locationDois: ['10.5555/preprint.1'] }]),
        );
        const result = batchOf(await client(fn).fetchDoi(['10.5555/preprint.1', '10.1000/journal']));
        expect(outcomes(result)).toEqual({ '10.5555/preprint.1': 'W9', '10.1000/journal': 'W9' });
        expect(result.works['10.5555/preprint.1']?.requestedDoi).toBe('10.5555/preprint.1');
        expect(calls).toHaveLength(1);
    });

    test('a DOI matching several works picks the most cited one, as single lookup does', async () => {
        const { fn } = serve(
            makeServer([
                { id: 'W5', doi: '10.1000/shared', cited: 3 },
                { id: 'W6', doi: '10.1000/shared', cited: 90 },
                { id: 'W7', doi: '10.1000/other' },
            ]),
        );
        const result = batchOf(await client(fn).fetchDoi(['10.1000/shared', '10.1000/other']));
        expect(outcomes(result)).toEqual({ '10.1000/shared': 'W6', '10.1000/other': 'W7' });
    });

    test('a DOI absent from the list falls back to single lookup and is null in works on 404', async () => {
        const { fn, calls } = serve(makeServer([{ id: 'W1', doi: '10.1000/a' }]));
        const result = batchOf(await client(fn).fetchDoi(['10.1000/a', '10.1000/missing']));
        expect(outcomes(result)).toEqual({ '10.1000/a': 'W1', '10.1000/missing': null });
        expect(Object.keys(result.errors)).toEqual([]);
        expect(result.requests).toEqual({ list: 1, single: 1 });
        expect(calls.filter((call) => !isList(call)).map((call) => decodeURIComponent(call.url))).toEqual([
            'https://api.openalex.org/works/doi:10.1000/missing',
        ]);
    });

    test('a DOI the list misses but single lookup finds resolves through the fallback', async () => {
        const server = makeServer([
            { id: 'W1', doi: '10.1000/a' },
            { id: 'W2', doi: '10.1000/lagging' },
        ]);
        server.hiddenFromList.add('W2');
        const { fn } = serve(server);
        const result = batchOf(await client(fn).fetchDoi(['10.1000/lagging', '10.1000/a']));
        expect(outcomes(result)).toEqual({ '10.1000/lagging': 'W2', '10.1000/a': 'W1' });
        expect(result.requests).toEqual({ list: 1, single: 1 });
    });

    test('a DOI with a comma or inner whitespace skips the filter and uses single lookup', async () => {
        const { fn, calls } = serve(
            makeServer([
                { id: 'W1', doi: '10.1000/a' },
                { id: 'W2', doi: '10.9999/a,b' },
            ]),
        );
        const result = batchOf(await client(fn).fetchDoi(['10.1000/a', '10.9999/a,b', '10.1000/x y']));
        expect(outcomes(result)).toEqual({ '10.1000/a': 'W1', '10.9999/a,b': 'W2', '10.1000/x y': null });
        const lists = calls.filter(isList);
        expect(lists).toHaveLength(1);
        expect(filterValues(lists[0] as RecordedCall)).toEqual(['10.1000/a']);
        expect(result.requests).toEqual({ list: 1, single: 2 });
    });

    test('invalid inputs next to valid ones are INVALID_DOI errors without a request, with ok: true', async () => {
        const { fn, calls } = serve(makeServer([{ id: 'W1', doi: '10.1000/a' }]));
        const result = batchOf(await client(fn).fetchDoi(['nope', '10.1000/a', '']));
        expect(outcomes(result)).toEqual({ nope: 'INVALID_DOI', '10.1000/a': 'W1', '': 'INVALID_DOI' });
        expect(Object.keys(result.errors)).toEqual(['nope', '']);
        expect(calls).toHaveLength(1);
        expect(filterValues(calls[0] as RecordedCall)).toEqual(['10.1000/a']);
    });

    test('non-string array members become INVALID_DOI errors keyed by their string form', async () => {
        const { fn } = serve(makeServer([{ id: 'W1', doi: '10.1000/a' }]));
        const result = batchOf(await client(fn).fetchDoi([42, null, '10.1000/a'] as unknown as string[]));
        expect(outcomes(result)).toEqual({ '42': 'INVALID_DOI', null: 'INVALID_DOI', '10.1000/a': 'W1' });
    });

    test('a non-string member whose string form equals a valid DOI does not drop the valid input', async () => {
        for (const twin of [new String('10.1000/a'), { toString: () => '10.1000/a' }]) {
            const { fn, calls } = serve(makeServer([{ id: 'W1', doi: '10.1000/a' }]));
            const result = batchOf(await client(fn).fetchDoi([twin, '10.1000/a'] as unknown as string[]));
            expect(outcomes(result)).toEqual({ '10.1000/a': 'W1' });
            expect(Object.keys(result.errors)).toEqual([]);
            expect(calls).toHaveLength(1);
        }
    });

    test('a non-string twin of a valid DOI keeps the valid input at its own position', async () => {
        const server = makeServer([{ id: 'W2', doi: '10.1000/b' }]);
        const { fn } = makeFetch((call: RecordedCall) =>
            urlHas(call, '10.1000/a') ? failing(500) : answer(server, call),
        );
        const inputs = ['x', new String('10.1000/a'), '10.1000/a', '10.1000/b'] as unknown as string[];
        const result = batchOf(await client(fn, { limiterOptions: NO_RETRY }).fetchDoi(inputs, { strategy: 'single' }));
        expect(Object.keys(result.errors)).toEqual(['x', '10.1000/a']);
        expect(outcomes(result)).toEqual({ x: 'INVALID_DOI', '10.1000/a': 'HTTP', '10.1000/b': 'W2' });
    });

    test('a non-string member whose string form equals a valid W id does not drop the valid input', async () => {
        const { fn } = serve(makeServer([{ id: 'W1' }, { id: 'W2' }]));
        const result = batchOf(await client(fn).fetchWorkById([new String('W1'), 'W1', 'W2'] as unknown as string[]));
        expect(outcomes(result)).toEqual({ W1: 'W1', W2: 'W2' });
        expect(Object.keys(result.errors)).toEqual([]);
    });

    test('a hole in a sparse DOI array becomes an INVALID_DOI error keyed undefined', async () => {
        const inputs: string[] = [];
        inputs[1] = '10.1000/a';
        const { fn, calls } = serve(makeServer([{ id: 'W1', doi: '10.1000/a' }]));
        const result = batchOf(await client(fn).fetchDoi(inputs));
        expect(outcomes(result)).toEqual({ undefined: 'INVALID_DOI', '10.1000/a': 'W1' });
        expect(Object.keys(result.works)).toEqual(['10.1000/a']);
        expect(Object.keys(result.errors)).toEqual(['undefined']);
        expect(calls).toHaveLength(1);
    });

    test('a hole in a sparse W id array becomes an INVALID_ID error keyed undefined', async () => {
        const inputs: string[] = [];
        inputs[0] = 'W1';
        inputs[2] = 'W2';
        const { fn } = serve(makeServer([{ id: 'W1' }, { id: 'W2' }]));
        const result = batchOf(await client(fn).fetchWorkById(inputs));
        expect(outcomes(result)).toEqual({ W1: 'W1', undefined: 'INVALID_ID', W2: 'W2' });
        expect(Object.keys(result.works)).toEqual(['W1', 'W2']);
        expect(Object.keys(result.errors)).toEqual(['undefined']);
    });

    test('more than 100 distinct DOIs are split into chunks of 100', async () => {
        const specs = Array.from({ length: 150 }, (_, i) => ({ id: `W${i + 1}`, doi: `10.1000/n${i}` }));
        const { fn, calls } = serve(makeServer(specs));
        const result = batchOf(await client(fn).fetchDoi(specs.map((spec) => spec.doi)));
        expect(calls.map((call) => filterValues(call).length)).toEqual([100, 50]);
        expect(result.requests).toEqual({ list: 2, single: 0 });
        expect(outcomes(result)).toEqual(Object.fromEntries(specs.map((spec) => [spec.doi, spec.id])));
    });

    test('a work truncated at 100 authorships is refetched once by W id', async () => {
        const { fn, calls } = serve(
            makeServer([{ id: 'W8', doi: '10.1000/big', locationDois: ['10.1000/big-preprint'], authorships: 181 }]),
        );
        const result = batchOf(await client(fn).fetchDoi(['10.1000/big', '10.1000/big-preprint']));
        expect(Object.keys(result.works)).toEqual(['10.1000/big', '10.1000/big-preprint']);
        for (const work of Object.values(result.works)) {
            expect(work?.raw.authorships).toHaveLength(181);
        }
        expect(result.requests).toEqual({ list: 1, single: 1 });
        expect(calls.filter((call) => !isList(call)).map((call) => call.url)).toEqual([
            'https://api.openalex.org/works/W8',
        ]);
    });

    test('a DOI held only in a location past the cut of 100 is matched through the refetched work', async () => {
        const filler = Array.from({ length: 109 }, (_, i) => `10.1000/v${i}`);
        const { fn, calls } = serve(
            makeServer([
                { id: 'W5', doi: '10.1000/big', locationDois: [...filler, '10.1000/x'], cited: 50 },
                { id: 'W6', doi: '10.1000/small', locationDois: ['10.1000/x'], cited: 1 },
            ]),
        );
        const result = batchOf(await client(fn).fetchDoi(['10.1000/x']));
        // W5 is more cited; its list view cut the location with 10.1000/x, the refetch shows it
        expect(outcomes(result)).toEqual({ '10.1000/x': 'W5' });
        expect(result.works['10.1000/x']?.raw.locations).toHaveLength(111);
        expect(result.requests).toEqual({ list: 1, single: 1 });
        expect(calls.filter((call) => !isList(call)).map((call) => call.url)).toEqual([
            'https://api.openalex.org/works/W5',
        ]);
    });

    test('list entries that are not objects or have no W id are skipped; their keys use single lookup', async () => {
        const server = makeServer([
            { id: 'W1', doi: '10.1000/a' },
            { id: 'W2', doi: '10.1000/b' },
        ]);
        const idless = { ...makeWork({ id: 'W9', doi: '10.1000/b', cited: 50 }), id: null };
        const { fn, calls } = makeFetch((call: RecordedCall) =>
            isList(call)
                ? jsonResponse({ meta: { count: 5 }, results: [null, 42, 'x', idless, server.works[0]] })
                : answer(server, call),
        );
        const result = batchOf(await client(fn).fetchDoi(['10.1000/a', '10.1000/b']));
        expect(outcomes(result)).toEqual({ '10.1000/a': 'W1', '10.1000/b': 'W2' });
        expect(result.requests).toEqual({ list: 1, single: 1 });
        expect(calls.filter((call) => !isList(call)).map((call) => urlHas(call, '10.1000/b'))).toEqual([true]);
    });

    test('strategy single sends one free lookup per distinct DOI and no list request', async () => {
        const { fn, calls } = serve(
            makeServer([
                { id: 'W1', doi: '10.1000/a' },
                { id: 'W2', doi: '10.1000/b' },
            ]),
        );
        const result = batchOf(
            await client(fn).fetchDoi(['10.1000/a', '10.1000/b', '10.1000/a'], { strategy: 'single' }),
        );
        expect(outcomes(result)).toEqual({ '10.1000/a': 'W1', '10.1000/b': 'W2' });
        expect(calls.some(isList)).toBe(false);
        expect(result.requests).toEqual({ list: 0, single: 2 });
    });
});

function overfullServer(): { server: Server; dois: string[] } {
    const owners = Array.from({ length: 100 }, (_, i) => ({ id: `W${i + 1}`, doi: `10.1000/n${i}`, cited: 10 }));
    const holders = [
        { id: 'W201', doi: '10.1000/holder-a', locationDois: ['10.1000/n0'], cited: 1000 },
        { id: 'W202', doi: '10.1000/holder-b', locationDois: ['10.1000/n1'], cited: 1000 },
    ];
    return { server: makeServer([...owners, ...holders]), dois: owners.map((owner) => owner.doi) };
}

function pageOf(call: RecordedCall): number {
    return Number(new URL(call.url).searchParams.get('page'));
}

function costed(server: Server, failPage?: (page: number) => Response | null) {
    return makeFetch((call: RecordedCall) => {
        const failure = isList(call) ? (failPage?.(pageOf(call)) ?? null) : null;
        const response = failure ?? answer(server, call);
        response.headers.set('X-RateLimit-Cost-USD', isList(call) ? '0.0001' : '0');
        return response;
    });
}

describe('list paging', () => {
    test('list requests ask for 100 works per page, page 1, most cited first', async () => {
        const { fn, calls } = serve(makeServer([{ id: 'W1', doi: '10.1000/a' }]));
        await client(fn).fetchDoi(['10.1000/a']);
        const params = new URL(calls[0]?.url ?? '').searchParams;
        expect(params.get('per_page')).toBe('100');
        expect(params.get('page')).toBe('1');
        expect(params.get('sort')).toBe('cited_by_count:desc');
    });

    test('102 matches for 100 DOIs read page 2; every page is counted and paid', async () => {
        const { server, dois } = overfullServer();
        const { fn, calls } = costed(server);
        const result = batchOf(await client(fn).fetchDoi(dois));
        expect(calls.filter(isList).map(pageOf)).toEqual([1, 2]);
        // the two owners on page 2 are the least cited after the holders; each DOI resolves to its owner
        expect(outcomes(result)).toEqual(Object.fromEntries(dois.map((doi, i) => [doi, `W${i + 1}`])));
        expect(result.requests).toEqual({ list: 2, single: 0 });
        expect(result.budget?.cost_usd).toBeCloseTo(0.0002);
    });

    test('a full page that reaches meta.count sends no page 2', async () => {
        const specs = Array.from({ length: 100 }, (_, i) => ({ id: `W${i + 1}`, doi: `10.1000/n${i}` }));
        const { fn, calls } = serve(makeServer(specs));
        const result = batchOf(await client(fn).fetchDoi(specs.map((spec) => spec.doi)));
        expect(calls.filter(isList).map(pageOf)).toEqual([1]);
        expect(result.requests).toEqual({ list: 1, single: 0 });
    });

    test('a shared failure on page 2 keeps the works settled by page 1 and fails the other keys', async () => {
        const { server, dois } = overfullServer();
        const { fn } = costed(server, (page) => (page === 2 ? failing(500) : null));
        const result = batchOf(await client(fn, { limiterOptions: NO_RETRY }).fetchDoi(dois));
        const seen = outcomes(result);
        // page 1: holders W201, W202, then owners W1..W98 by W number; n98 and n99 are on page 2
        expect(seen['10.1000/n2']).toBe('W3');
        expect(seen['10.1000/n97']).toBe('W98');
        expect(seen['10.1000/n98']).toBe('HTTP');
        expect(seen['10.1000/n99']).toBe('HTTP');
        // n0 and n1 are owned by W1 and W2, which page 1 has: settled despite the holders
        expect(seen['10.1000/n0']).toBe('W1');
        expect(Object.keys(result.errors)).toEqual(['10.1000/n98', '10.1000/n99']);
        expect(result.requests).toEqual({ list: 2, single: 0 });
        expect(result.budget?.cost_usd).toBeCloseTo(0.0002);
    });

    test('a DOI held only by a location on page 1 is not settled when page 2 fails', async () => {
        // the holder is most cited; the owner of 10.1000/owned is the least cited, on page 2
        const owners = Array.from({ length: 99 }, (_, i) => ({ id: `W${i + 1}`, doi: `10.1000/n${i}`, cited: 10 }));
        const server = makeServer([
            ...owners,
            { id: 'W200', doi: '10.1000/holder', locationDois: ['10.1000/owned'], cited: 1000 },
            { id: 'W300', doi: '10.1000/owned', cited: 1 },
        ]);
        const dois = [...owners.map((owner) => owner.doi), '10.1000/owned'];
        const shared = costed(server, (page) => (page === 2 ? failing(500) : null));
        const failed = batchOf(await client(shared.fn, { limiterOptions: NO_RETRY }).fetchDoi(dois));
        expect(Object.keys(failed.errors)).toEqual(['10.1000/owned']);

        // a 400 on page 2 is not shared: the key falls back to single lookup, which finds the owner
        const rejected = costed(server, (page) => (page === 2 ? failing(400) : null));
        const result = batchOf(await client(rejected.fn, { limiterOptions: NO_RETRY }).fetchDoi(dois));
        expect(outcomes(result)['10.1000/owned']).toBe('W300');
        expect(result.requests).toEqual({ list: 2, single: 1 });
    });

    test('a rate-limited page 2 falls back to single lookup with fallbackOnRateLimit', async () => {
        const { server, dois } = overfullServer();
        const limited = () => jsonResponse({ error: 'budget' }, { status: 429, headers: { 'Retry-After': '3600' } });
        const limiterOptions = { ...NO_RETRY, maxWaitMs: 1000 };

        const plain = costed(server, (page) => (page === 2 ? limited() : null));
        const failed = batchOf(await client(plain.fn, { limiterOptions }).fetchDoi(dois));
        expect(Object.values(failed.errors).map((error) => error.code)).toEqual(['RATE_LIMITED', 'RATE_LIMITED']);

        const falling = costed(server, (page) => (page === 2 ? limited() : null));
        const result = batchOf(await client(falling.fn, { limiterOptions, fallbackOnRateLimit: true }).fetchDoi(dois));
        expect(result.errors).toEqual({});
        expect(outcomes(result)['10.1000/n99']).toBe('W100');
        expect(result.requests).toEqual({ list: 2, single: 2 });
    });

    test('an unknown DOI absent from every page is confirmed by one single lookup and is null', async () => {
        const { server, dois } = overfullServer();
        const { fn, calls } = costed(server);
        const input = [...dois.slice(0, 99), '10.1000/unknown'];
        const result = batchOf(await client(fn).fetchDoi(input));
        expect(result.works['10.1000/unknown']).toBeNull();
        expect(result.requests).toEqual({ list: 2, single: 1 });
        expect(calls.filter((call) => !isList(call))).toHaveLength(1);
    });

    test('paging stops at 10,000 results; keys not settled by then use single lookup', async () => {
        const server = makeServer([
            { id: 'W1', doi: '10.1000/a', cited: 5 },
            { id: 'W2', doi: '10.1000/b', cited: 5 },
        ]);
        const filler = server.works[0] as OpenAlexWork;
        const { fn, calls } = makeFetch((call: RecordedCall) => {
            if (!isList(call)) {
                return answer(server, call);
            }
            // a list that never ends: W1 on page 1, the rest of every page holds new works with no requested DOI
            const page = pageOf(call);
            const other = (i: number) => makeWork({ id: `W${page * 1000 + i}`, doi: `10.1000/other-${page}-${i}` });
            const results = Array.from({ length: 100 }, (_, i) => (page === 1 && i === 0 ? filler : other(i)));
            return jsonResponse({ meta: { count: 1_000_000 }, results });
        });
        const result = batchOf(await client(fn).fetchDoi(['10.1000/a', '10.1000/b']));
        expect(calls.filter(isList).map(pageOf)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
        expect(outcomes(result)).toEqual({ '10.1000/a': 'W1', '10.1000/b': 'W2' });
        expect(result.requests).toEqual({ list: 100, single: 1 });
    });

    test('without meta.count a full page reads the next page until a page is short', async () => {
        const { server, dois } = overfullServer();
        const { fn, calls } = makeFetch(async (call: RecordedCall) => {
            const response = answer(server, call);
            if (!isList(call)) {
                return response;
            }
            const list = (await response.json()) as { results: unknown[] };
            return jsonResponse({ results: list.results });
        });
        const result = batchOf(await client(fn).fetchDoi(dois));
        expect(calls.filter(isList).map(pageOf)).toEqual([1, 2]);
        expect(outcomes(result)).toEqual(Object.fromEntries(dois.map((doi, i) => [doi, `W${i + 1}`])));
        expect(result.requests).toEqual({ list: 2, single: 0 });
    });

    test('a work repeated on page 2 is counted once: the list is incomplete and single lookup finds the owner', async () => {
        // page 1: the holder of 10.1000/owned (most cited) and 99 owners; page 2 repeats an owner instead of
        // returning W300, the owner of 10.1000/owned, so 101 results hold only 100 distinct works
        const owners = Array.from({ length: 99 }, (_, i) => ({ id: `W${i + 1}`, doi: `10.1000/n${i}`, cited: 10 }));
        const server = makeServer([
            ...owners,
            { id: 'W200', doi: '10.1000/holder', locationDois: ['10.1000/owned'], cited: 1000 },
            { id: 'W300', doi: '10.1000/owned', cited: 1 },
        ]);
        const pageOne = [server.works[99], ...server.works.slice(0, 99)] as OpenAlexWork[];
        const { fn, calls } = makeFetch((call: RecordedCall) => {
            if (!isList(call)) {
                return answer(server, call);
            }
            const results = pageOf(call) === 1 ? pageOne : [server.works[98] as OpenAlexWork];
            return jsonResponse({ meta: { count: 101 }, results });
        });
        const dois = [...owners.map((owner) => owner.doi), '10.1000/owned'];
        const result = batchOf(await client(fn).fetchDoi(dois));
        expect(calls.filter(isList).map(pageOf)).toEqual([1, 2]);
        expect(outcomes(result)['10.1000/owned']).toBe('W300');
        expect(outcomes(result)['10.1000/n98']).toBe('W99');
        expect(result.requests).toEqual({ list: 2, single: 1 });
    });

    test('an id-less entry counts toward meta.count: a full page 1 of count 100 sends no page 2', async () => {
        // page 1: one id-less entry and the owners of n0..n98; n99 (owned by W100) is not listed
        const owners = Array.from({ length: 100 }, (_, i) => ({ id: `W${i + 1}`, doi: `10.1000/n${i}` }));
        const server = makeServer(owners);
        const idless = { ...makeWork({ id: 'W999', doi: '10.1000/idless' }), id: null };
        const { fn, calls } = makeFetch((call: RecordedCall) => {
            if (!isList(call)) {
                return answer(server, call);
            }
            const results = pageOf(call) === 1 ? [idless, ...server.works.slice(0, 99)] : [];
            return jsonResponse({ meta: { count: 100 }, results });
        });
        const result = batchOf(await client(fn).fetchDoi(owners.map((owner) => owner.doi)));
        expect(calls.filter(isList).map(pageOf)).toEqual([1]);
        expect(outcomes(result)).toEqual(Object.fromEntries(owners.map((owner) => [owner.doi, owner.id])));
        expect(result.requests).toEqual({ list: 1, single: 1 });
    });

    test('a dropped entry leaves the list incomplete: a location holder does not settle the key', async () => {
        // page 1 reaches meta.count with an id-less entry, so only 99 works are read; the holder of
        // 10.1000/owned is on page 1 but its owner W300 is not, so the key falls back to single lookup
        const owners = Array.from({ length: 98 }, (_, i) => ({ id: `W${i + 1}`, doi: `10.1000/n${i}` }));
        const server = makeServer([
            ...owners,
            { id: 'W200', doi: '10.1000/holder', locationDois: ['10.1000/owned'], cited: 1000 },
            { id: 'W300', doi: '10.1000/owned', cited: 1 },
        ]);
        const idless = { ...makeWork({ id: 'W999', doi: '10.1000/idless' }), id: null };
        const { fn, calls } = makeFetch((call: RecordedCall) => {
            if (!isList(call)) {
                return answer(server, call);
            }
            const results = pageOf(call) === 1 ? [idless, ...server.works.slice(0, 99)] : [];
            return jsonResponse({ meta: { count: 100 }, results });
        });
        const result = batchOf(await client(fn).fetchDoi([...owners.map((owner) => owner.doi), '10.1000/owned']));
        expect(calls.filter(isList).map(pageOf)).toEqual([1]);
        expect(outcomes(result)['10.1000/owned']).toBe('W300');
        expect(result.requests).toEqual({ list: 1, single: 1 });
        expect(calls.filter((call) => !isList(call)).map((call) => urlHas(call, '10.1000/owned'))).toEqual([true]);
    });

    test('a work repeated on page 2 of count 200 counts toward meta.count: no page 3', async () => {
        // page 1: owners of n0..n99; page 2: 99 new works with no requested DOI and W1 again
        const owners = Array.from({ length: 100 }, (_, i) => ({ id: `W${i + 1}`, doi: `10.1000/n${i}` }));
        const server = makeServer(owners);
        const others = Array.from({ length: 99 }, (_, i) => makeWork({ id: `W${i + 101}`, doi: `10.1000/x${i}` }));
        const pages: Record<number, OpenAlexWork[]> = {
            1: server.works,
            2: [...others, server.works[0] as OpenAlexWork],
        };
        const { fn, calls } = makeFetch((call: RecordedCall) =>
            isList(call)
                ? jsonResponse({ meta: { count: 200 }, results: pages[pageOf(call)] ?? [] })
                : answer(server, call),
        );
        const result = batchOf(await client(fn).fetchDoi(owners.map((owner) => owner.doi)));
        expect(calls.filter(isList).map(pageOf)).toEqual([1, 2]);
        expect(outcomes(result)).toEqual(Object.fromEntries(owners.map((owner) => [owner.doi, owner.id])));
        expect(result.requests).toEqual({ list: 2, single: 0 });
    });

    test('a server returning the same full page every time is read for 2 pages, not 100', async () => {
        const owners = Array.from({ length: 100 }, (_, i) => ({ id: `W${i + 1}`, doi: `10.1000/n${i}` }));
        const server = makeServer(owners);
        const { fn, calls } = makeFetch((call: RecordedCall) =>
            isList(call) ? jsonResponse({ meta: { count: 1_000_000 }, results: server.works }) : answer(server, call),
        );
        const result = batchOf(await client(fn).fetchDoi(owners.map((owner) => owner.doi)));
        // page 2 adds no new work, so paging stops there
        expect(calls.filter(isList).map(pageOf)).toEqual([1, 2]);
        expect(outcomes(result)).toEqual(Object.fromEntries(owners.map((owner) => [owner.doi, owner.id])));
        expect(result.requests).toEqual({ list: 2, single: 0 });
    });
});

describe('singleBelow', () => {
    test('a chunk below the threshold sends free single lookups and no list request', async () => {
        const specs = Array.from({ length: 29 }, (_, i) => ({ id: `W${i + 1}`, doi: `10.1000/n${i}` }));
        const { fn, calls } = costed(makeServer(specs));
        const result = batchOf(
            await client(fn).fetchDoi(
                specs.map((spec) => spec.doi),
                { singleBelow: 30 },
            ),
        );
        expect(calls.some(isList)).toBe(false);
        expect(result.requests).toEqual({ list: 0, single: 29 });
        expect(result.budget?.cost_usd).toBe(0);
        expect(outcomes(result)).toEqual(Object.fromEntries(specs.map((spec) => [spec.doi, spec.id])));
    });

    test('110 DOIs with 30: one list request of 100 and 10 single lookups', async () => {
        const specs = Array.from({ length: 110 }, (_, i) => ({ id: `W${i + 1}`, doi: `10.1000/n${i}` }));
        const { fn, calls } = serve(makeServer(specs));
        const result = batchOf(await client(fn, { singleBelow: 30 }).fetchDoi(specs.map((spec) => spec.doi)));
        expect(calls.filter(isList).map((call) => filterValues(call).length)).toEqual([100]);
        expect(result.requests).toEqual({ list: 1, single: 10 });
    });

    test('an unknown W id below the threshold is null after its single 404', async () => {
        const { fn, calls } = serve(makeServer([{ id: 'W1', doi: '10.1000/a' }]));
        const result = batchOf(await client(fn).fetchWorkById(['W1', 'W77'], { singleBelow: 30 }));
        expect(outcomes(result)).toEqual({ W1: 'W1', W77: null });
        expect(calls.some(isList)).toBe(false);
        expect(result.requests).toEqual({ list: 0, single: 2 });
    });

    test('0 keeps list requests; a per-call value overrides the factory value', async () => {
        const { fn, calls } = serve(makeServer([{ id: 'W1', doi: '10.1000/a' }]));
        const oa = client(fn, { singleBelow: 30 });
        expect(batchOf(await oa.fetchDoi(['10.1000/a'], { singleBelow: 0 })).requests).toEqual({ list: 1, single: 0 });
        expect(batchOf(await oa.fetchDoi(['10.1000/a'])).requests).toEqual({ list: 0, single: 1 });
        expect(calls).toHaveLength(2);
    });

    test.each([-1, 1.5, '30', Number.NaN, Number.POSITIVE_INFINITY, null])(
        'invalid value %p: createOpenAlex throws, a call is INVALID_OPTIONS without a request',
        async (value) => {
            const { fn, calls } = serve(makeServer([]));
            const singleBelow = value as unknown as number;
            expect(() => client(fn, { singleBelow })).toThrow(TypeError);
            for (const result of [
                await client(fn).fetchDoi(['10.1000/a'], { singleBelow }),
                await client(fn).fetchWorkById(['W1'], { singleBelow }),
            ]) {
                const error = errorOf(result);
                expect(error.code).toBe('INVALID_OPTIONS');
                expect(error.message).toContain('singleBelow');
            }
            expect(calls).toHaveLength(0);
        },
    );
});

describe('array lookup failures', () => {
    test('a list request rejected with 400 falls back to single lookups', async () => {
        const server = makeServer([
            { id: 'W1', doi: '10.1000/a' },
            { id: 'W2', doi: '10.1000/b' },
        ]);
        const { fn, calls } = makeFetch((call: RecordedCall) =>
            isList(call) ? jsonResponse({ error: 'bad filter' }, { status: 400 }) : answer(server, call),
        );
        const result = batchOf(await client(fn, { limiterOptions: NO_RETRY }).fetchDoi(['10.1000/a', '10.1000/b']));
        expect(outcomes(result)).toEqual({ '10.1000/a': 'W1', '10.1000/b': 'W2' });
        expect(result.requests).toEqual({ list: 1, single: 2 });
        expect(calls).toHaveLength(3);
    });

    test.each([
        ['HTTP', 500],
        ['AUTH', 401],
    ])('a list request failing with %s fails every input: ok: false, without single lookups', async (code, status) => {
        const { fn, calls } = makeFetch(() => {
            const response = failing(status);
            response.headers.set('X-RateLimit-Cost-USD', '0.0001');
            response.headers.set('X-RateLimit-Remaining-USD', '0.9');
            return response;
        });
        const result = await client(fn, { limiterOptions: NO_RETRY }).fetchDoi(['10.1000/a', '10.1000/b']);
        const error = errorOf(result);
        expect<string>(error.code).toBe(code);
        expect(error.status).toBe(status);
        expect(error.budget?.cost_usd).toBe(0.0001);
        expect(error.budget?.daily_remaining_usd).toBe(0.9);
        expect(calls).toHaveLength(1);
    });

    test('a list page without a results array keeps its cost in the batch budget', async () => {
        const server = makeServer([{ id: 'W1', doi: '10.1000/a' }]);
        const { fn } = makeFetch((call: RecordedCall) => {
            const response = isList(call) ? jsonResponse({ meta: { count: 1 } }) : answer(server, call);
            response.headers.set('X-RateLimit-Cost-USD', isList(call) ? '0.0001' : '0');
            return response;
        });
        const result = batchOf(await client(fn).fetchDoi(['10.1000/a']));
        expect(outcomes(result)).toEqual({ '10.1000/a': 'W1' });
        expect(result.requests).toEqual({ list: 1, single: 1 });
        expect(result.budget?.cost_usd).toBe(0.0001);
    });

    test('a partial failure keeps the found works and puts the failed inputs in errors', async () => {
        const server = makeServer([{ id: 'W1', doi: '10.1000/a' }]);
        const { fn, calls } = makeFetch((call: RecordedCall) =>
            urlHas(call, '10.1000/b') ? failing(500) : answer(server, call),
        );
        const result = batchOf(
            await client(fn, { limiterOptions: NO_RETRY }).fetchDoi(['10.1000/a', '10.1000/b'], {
                strategy: 'single',
            }),
        );
        expect(outcomes(result)).toEqual({ '10.1000/a': 'W1', '10.1000/b': 'HTTP' });
        expect(result.errors['10.1000/b']?.status).toBe(500);
        expect(result.requests).toEqual({ list: 0, single: 2 });
        expect(calls).toHaveLength(2);
    });

    test('a 404 counts as an answer: a null work next to failed inputs keeps ok: true', async () => {
        const { fn } = makeFetch((call: RecordedCall) => (urlHas(call, '10.1000/a') ? notFound() : failing(500)));
        const result = batchOf(
            await client(fn, { limiterOptions: NO_RETRY }).fetchDoi(['10.1000/a', '10.1000/b', '10.1000/c'], {
                strategy: 'single',
            }),
        );
        expect(outcomes(result)).toEqual({ '10.1000/a': null, '10.1000/b': 'HTTP', '10.1000/c': 'HTTP' });
    });

    test('every input failing with different statuses is ok: false with the first error on a tie', async () => {
        const { fn } = makeFetch((call: RecordedCall) => failing(urlHas(call, '10.1000/b') ? 501 : 500));
        const result = await client(fn, { limiterOptions: NO_RETRY }).fetchDoi(['10.1000/a', '10.1000/b'], {
            strategy: 'single',
        });
        const error = errorOf(result);
        expect<string>(error.code).toBe('HTTP');
        expect(error.status).toBe(500);
    });

    test('the first error on a tie follows input order, also before an integer-like input', async () => {
        const { fn } = serve(makeServer([]));
        const error = errorOf(await client(fn).fetchDoi(['not-a-doi', '42']));
        expect(error.message).toContain('not-a-doi');
    });

    test('the whole-result error is the one most inputs share; request errors win over INVALID_DOI', async () => {
        const { fn, calls } = makeFetch((call: RecordedCall) => {
            const response = failing(urlHas(call, '10.1000/a') ? 500 : 501);
            response.headers.set('X-RateLimit-Cost-USD', '0.0001');
            response.headers.set('X-RateLimit-Remaining-USD', '0.9');
            return response;
        });
        const inputs = ['bad', 'worse', 'awful', '10.1000/a', '10.1000/b', '10.1000/c'];
        const result = await client(fn, { limiterOptions: NO_RETRY }).fetchDoi(inputs, { strategy: 'single' });
        const error = errorOf(result);
        expect<string>(error.code).toBe('HTTP');
        expect(error.status).toBe(501);
        expect(error.budget?.cost_usd).toBe(0.0003);
        expect(calls).toHaveLength(3);
    });

    test('a failed refetch of a truncated work is an error for its input, never the cut list work', async () => {
        const server = makeServer([
            { id: 'W8', doi: '10.1000/big', authorships: 181 },
            { id: 'W1', doi: '10.1000/a' },
        ]);
        const { fn, calls } = makeFetch((call: RecordedCall) => (isList(call) ? answer(server, call) : failing(500)));
        const result = batchOf(await client(fn, { limiterOptions: NO_RETRY }).fetchDoi(['10.1000/big', '10.1000/a']));
        expect(outcomes(result)).toEqual({ '10.1000/big': 'HTTP', '10.1000/a': 'W1' });
        expect(result.errors['10.1000/big']?.status).toBe(500);
        expect(result.requests).toEqual({ list: 1, single: 1 });
        expect(calls).toHaveLength(2);
    });

    test.each([
        ['an empty object', {}],
        ['null', null],
    ])('a 2xx refetch body of %s is PARSE for its input, without an extra single lookup', async (_label, body) => {
        const server = makeServer([
            { id: 'W8', doi: '10.1000/big', authorships: 181 },
            { id: 'W1', doi: '10.1000/a' },
        ]);
        const { fn } = makeFetch((call: RecordedCall) => (isList(call) ? answer(server, call) : jsonResponse(body)));
        const result = batchOf(await client(fn).fetchDoi(['10.1000/big', '10.1000/a']));
        expect(outcomes(result)).toEqual({ '10.1000/big': 'PARSE', '10.1000/a': 'W1' });
        expect(result.requests).toEqual({ list: 1, single: 1 });
    });

    test("a refetch that returns a merged work keeps the cut work's keys", async () => {
        const server = makeServer([
            { id: 'W8', doi: '10.1000/big', authorships: 181 },
            { id: 'W9', doi: '10.1000/merged', authorships: 181 },
        ]);
        server.merged.set('W8', 'W9');
        const { fn } = serve(server);
        const byDoi = batchOf(await client(fn).fetchDoi(['10.1000/big']));
        expect(outcomes(byDoi)).toEqual({ '10.1000/big': 'W9' });
        expect(byDoi.requests).toEqual({ list: 1, single: 1 });
        const byId = batchOf(await client(fn).fetchWorkById(['W8']));
        expect(outcomes(byId)).toEqual({ W8: 'W9' });
        expect(byId.requests).toEqual({ list: 1, single: 1 });
    });

    test('a refetch 404 of a truncated work is an HTTP 404 error, not a null work', async () => {
        const server = makeServer([
            { id: 'W8', doi: '10.1000/big', authorships: 181 },
            { id: 'W1', doi: '10.1000/a' },
        ]);
        const { fn, calls } = makeFetch((call: RecordedCall) => (isList(call) ? answer(server, call) : notFound()));
        const result = batchOf(await client(fn, { limiterOptions: NO_RETRY }).fetchDoi(['10.1000/big', '10.1000/a']));
        expect(outcomes(result)).toEqual({ '10.1000/big': 'HTTP', '10.1000/a': 'W1' });
        expect(result.errors['10.1000/big']?.status).toBe(404);
        expect(calls.filter((call) => !isList(call)).map((call) => call.url)).toEqual([
            'https://api.openalex.org/works/W8',
        ]);
    });

    test('a 429 is retried by the queue after Retry-After', async () => {
        const server = makeServer([{ id: 'W1', doi: '10.1000/a' }]);
        const { fn, calls } = makeFetch((call: RecordedCall, index: number) =>
            index === 0
                ? jsonResponse({ error: 'slow down' }, { status: 429, headers: { 'Retry-After': '0' } })
                : answer(server, call),
        );
        const result = batchOf(await client(fn, { limiterOptions: { retryDelayMs: 0 } }).fetchDoi(['10.1000/a']));
        expect(outcomes(result)).toEqual({ '10.1000/a': 'W1' });
        expect(calls).toHaveLength(2);
        expect(result.requests).toEqual({ list: 1, single: 0 });
    });

    test('a rate-limited list request fails every input as RATE_LIMITED unless fallbackOnRateLimit is set', async () => {
        const server = makeServer([
            { id: 'W1', doi: '10.1000/a' },
            { id: 'W2', doi: '10.1000/b' },
        ]);
        const spent = () =>
            makeFetch((call: RecordedCall) =>
                isList(call)
                    ? jsonResponse({ error: 'budget' }, { status: 429, headers: { 'Retry-After': '3600' } })
                    : answer(server, call),
            );
        const limiterOptions = { ...NO_RETRY, maxWaitMs: 1000 };

        const plain = spent();
        const failed = await client(plain.fn, { limiterOptions }).fetchDoi(['10.1000/a', '10.1000/b']);
        expect(errorOf(failed).code).toBe('RATE_LIMITED');
        expect(plain.calls).toHaveLength(1);

        const falling = spent();
        const result = batchOf(
            await client(falling.fn, { limiterOptions }).fetchDoi(['10.1000/a', '10.1000/b'], {
                fallbackOnRateLimit: true,
            }),
        );
        expect(outcomes(result)).toEqual({ '10.1000/a': 'W1', '10.1000/b': 'W2' });
        expect(result.requests).toEqual({ list: 1, single: 2 });
        expect(falling.calls).toHaveLength(3);
    });

    test('a list request refused unsent by a paused lane is not counted', async () => {
        const server = makeServer([{ id: 'W1', doi: '10.1000/a' }]);
        const spent = makeFetch((call: RecordedCall) =>
            isList(call)
                ? jsonResponse({ error: 'budget' }, { status: 429, headers: { 'Retry-After': '3600' } })
                : answer(server, call),
        );
        const oa = client(spent.fn, { fallbackOnRateLimit: true, limiterOptions: { ...NO_RETRY, maxWaitMs: 1000 } });
        expect(batchOf(await oa.fetchDoi(['10.1000/a'])).requests).toEqual({ list: 1, single: 1 });
        // the paid lane is paused for an hour: the next list request is refused before it is sent
        const again = batchOf(await oa.fetchDoi(['10.1000/a']));
        expect(outcomes(again)).toEqual({ '10.1000/a': 'W1' });
        expect(again.requests).toEqual({ list: 0, single: 1 });
        expect(spent.calls).toHaveLength(3);
    });

    test('the cost of a 429 is counted once, not once per list request refused or released unsent', async () => {
        const specs = Array.from({ length: 150 }, (_, i) => ({ id: `W${i + 1}`, doi: `10.1000/n${i}` }));
        const server = makeServer(specs);
        const spent = () =>
            makeFetch((call: RecordedCall) =>
                isList(call)
                    ? jsonResponse(
                          { error: 'budget' },
                          {
                              status: 429,
                              headers: {
                                  'Retry-After': '3600',
                                  'X-RateLimit-Cost-USD': '0.0001',
                                  'X-RateLimit-Remaining-USD': '0',
                              },
                          },
                      )
                    : answer(server, call),
            );
        const options = {
            limits: { concurrency: 1, rps: 10_000 },
            limiterOptions: { ...NO_RETRY, maxWaitMs: 1000 },
        } as const;
        const dois = specs.map((spec) => spec.doi);

        // whole-result error: two chunks, only the first list request is sent
        const plain = spent();
        const failed = errorOf(await client(plain.fn, options).fetchDoi(dois));
        expect(failed.code).toBe('RATE_LIMITED');
        expect(plain.calls.filter(isList)).toHaveLength(1);
        expect(failed.budget?.cost_usd).toBe(0.0001);
        expect(failed.budget?.daily_remaining_usd).toBe(0);

        // fallback: same single 429 cost, the singles carry no budget headers
        const falling = spent();
        const oa = client(falling.fn, { ...options, fallbackOnRateLimit: true });
        const first = batchOf(await oa.fetchDoi(dois));
        expect(first.requests).toEqual({ list: 1, single: 150 });
        expect(first.budget?.cost_usd).toBe(0.0001);

        // the paused lane refuses the next list request unsent: headers kept, no cost
        const again = batchOf(await oa.fetchDoi(['10.1000/n0']));
        expect(again.requests).toEqual({ list: 0, single: 1 });
        expect(again.budget?.cost_usd).toBeNull();
        expect(again.budget?.daily_remaining_usd).toBe(0);
    });

    test('fallbackOnRateLimit is validated and inherited from the factory', async () => {
        const { fn, calls } = serve(makeServer([]));
        const invalid = await client(fn).fetchDoi(['10.1000/a'], { fallbackOnRateLimit: 'yes' as unknown as boolean });
        expect(errorOf(invalid).message).toContain('fallbackOnRateLimit');
        expect(calls).toHaveLength(0);

        const server = makeServer([{ id: 'W1', doi: '10.1000/a' }]);
        const spent = makeFetch((call: RecordedCall) =>
            isList(call)
                ? jsonResponse({ error: 'budget' }, { status: 429, headers: { 'Retry-After': '3600' } })
                : answer(server, call),
        );
        const oa = client(spent.fn, { fallbackOnRateLimit: true, limiterOptions: { ...NO_RETRY, maxWaitMs: 1000 } });
        expect(outcomes(batchOf(await oa.fetchDoi(['10.1000/a'])))).toEqual({ '10.1000/a': 'W1' });
    });

    test('an aborted signal is the whole result as ABORTED', async () => {
        const { fn, calls } = serve(makeServer([{ id: 'W1', doi: '10.1000/a' }]));
        const controller = new AbortController();
        controller.abort();
        const result = await client(fn).fetchDoi(['10.1000/a', 'bad'], { signal: controller.signal });
        expect(errorOf(result).code).toBe('ABORTED');
        expect(calls).toHaveLength(0);
    });

    test('invalid inputs alone are ok: false with INVALID_DOI and send nothing', async () => {
        const { fn, calls } = serve(makeServer([]));
        const error = errorOf(await client(fn).fetchDoi(['bad', 'worse']));
        expect<string>(error.code).toBe('INVALID_DOI');
        expect(error.budget).toBeNull();
        expect(calls).toHaveLength(0);
    });

    test('invalid options are the whole result as INVALID_OPTIONS', async () => {
        const { fn, calls } = serve(makeServer([]));
        const result = await client(fn).fetchDoi(['10.1000/a', 'bad'], { timeoutMs: -1 });
        expect(errorOf(result).code).toBe('INVALID_OPTIONS');
        expect(calls).toHaveLength(0);
    });

    test('an invalid rename map is the whole result as INVALID_RENAME', async () => {
        const { fn, calls } = serve(makeServer([{ id: 'W1', doi: '10.1000/a' }]));
        const rename = { x: 'not_a_field' } as unknown as { x: 'title' };
        const result = await client(fn).fetchDoi(['10.1000/a'], { rename });
        expect(errorOf(result).code).toBe('INVALID_RENAME');
        expect(calls).toHaveLength(0);
    });
});

describe('array lookup extras', () => {
    test('the rename map applies to every work', async () => {
        const { fn } = serve(makeServer([{ id: 'W1', doi: '10.1000/a' }]));
        const result = batchOf(await client(fn).fetchDoi(['10.1000/a'], { rename: { ref_id: 'id' } }));
        expect(result.works['10.1000/a']?.record.ref_id).toBe('W1');
    });

    test('budget sums cost and keeps the lowest remaining budget', async () => {
        const server = makeServer([{ id: 'W1', doi: '10.1000/a' }]);
        const { fn } = makeFetch((call: RecordedCall) => {
            const response = answer(server, call);
            const list = isList(call);
            response.headers.set('X-RateLimit-Cost-USD', list ? '0.0001' : '0');
            response.headers.set('X-RateLimit-Remaining-USD', list ? '0.9' : '0.95');
            return response;
        });
        const result = batchOf(await client(fn).fetchDoi(['10.1000/a', '10.1000/missing']));
        expect(result.budget?.cost_usd).toBeCloseTo(0.0001);
        expect(result.budget?.daily_remaining_usd).toBe(0.9);
    });

    test('budget includes the cost of failed lookups, and each error carries its own budget', async () => {
        const server = makeServer([{ id: 'W1', doi: '10.1000/a' }]);
        const { fn } = makeFetch((call: RecordedCall) => {
            const list = isList(call);
            const response = list ? answer(server, call) : failing(500);
            response.headers.set('X-RateLimit-Cost-USD', list ? '0.0001' : '0.0002');
            response.headers.set('X-RateLimit-Remaining-USD', list ? '0.9' : '0.8');
            return response;
        });
        const result = batchOf(
            await client(fn, { limiterOptions: NO_RETRY }).fetchDoi(['10.1000/a', '10.1000/failing']),
        );
        expect(result.budget?.cost_usd).toBe(0.0003);
        expect(result.budget?.daily_remaining_usd).toBe(0.8);
        expect(outcomes(result)).toEqual({ '10.1000/a': 'W1', '10.1000/failing': 'HTTP' });
        expect(result.errors['10.1000/failing']?.budget?.cost_usd).toBe(0.0002);
    });

    test('budget rounds the summed cost and takes the last response on a remaining-budget tie', async () => {
        const server = makeServer([
            { id: 'W1', doi: '10.1000/a' },
            { id: 'W2', doi: '10.1000/b' },
        ]);
        let calls = 0;
        const { fn } = makeFetch((call: RecordedCall) => {
            const response = answer(server, call);
            calls += 1;
            response.headers.set('X-RateLimit-Cost-USD', calls === 1 ? '0.1' : '0.2');
            response.headers.set('X-RateLimit-Remaining-USD', '0.5');
            response.headers.set('X-RateLimit-Prepaid-Remaining-USD', calls === 1 ? '9' : '8');
            return response;
        });
        const result = batchOf(
            await client(fn, { limits: { concurrency: 1, rps: 10_000 } }).fetchDoi(['10.1000/a', '10.1000/b'], {
                strategy: 'single',
            }),
        );
        expect(result.budget?.cost_usd).toBe(0.3);
        expect(result.budget?.prepaid_remaining_usd).toBe(8);
    });

    test('fetchWorkById resolves W ids with the openalex filter and follows merged ids', async () => {
        const server = makeServer([
            { id: 'W1', doi: '10.1000/a' },
            { id: 'W2', doi: '10.1000/b' },
        ]);
        server.merged.set('W99', 'W2');
        const { fn, calls } = serve(server);
        const result = batchOf(await client(fn).fetchWorkById(['https://openalex.org/W1', 'w99', 'W404', 'nope']));
        expect(outcomes(result)).toEqual({
            'https://openalex.org/W1': 'W1',
            w99: 'W2',
            W404: null,
            nope: 'INVALID_ID',
        });
        expect(result.works.w99?.requestedId).toBe('W99');
        const list = calls.find(isList) as RecordedCall;
        expect(new URL(list.url).searchParams.get('filter')).toBe('openalex:W1|W99|W404');
        expect(result.requests).toEqual({ list: 1, single: 2 });
    });

    test('fetchWorkById with a string returns one Result', async () => {
        const { fn } = serve(makeServer([{ id: 'W1' }]));
        const result = await client(fn).fetchWorkById('W1');
        expect(result.ok && result.data.requestedId).toBe('W1');
    });

    test('client array lookups share the client queue and respect its concurrency', async () => {
        const server = makeServer(Array.from({ length: 6 }, (_, i) => ({ id: `W${i + 1}`, doi: `10.1000/n${i}` })));
        let inFlight = 0;
        let peak = 0;
        const { fn } = makeFetch(async (call: RecordedCall) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await Bun.sleep(5);
            inFlight -= 1;
            return answer(server, call);
        });
        const oa = createOpenAlex({ fetchFn: fn, strategy: 'single', limits: { concurrency: 2, rps: 10_000 } });
        const [first, second] = await Promise.all([
            oa.fetchDoi(['10.1000/n0', '10.1000/n1', '10.1000/n2']).then(batchOf),
            oa.fetchWorkById(['W4', 'W5', 'W6']).then(batchOf),
        ]);
        expect(outcomes(first)).toEqual({ '10.1000/n0': 'W1', '10.1000/n1': 'W2', '10.1000/n2': 'W3' });
        expect(outcomes(second)).toEqual({ W4: 'W4', W5: 'W5', W6: 'W6' });
        expect(peak).toBe(2);
    });

    test.each([
        ['limits.rps', { limits: { rps: 0 } }],
        ['limits.concurrency', { limits: { concurrency: 0 } }],
        ['limiterOptions.maxRetries', { limiterOptions: { maxRetries: -1 } }],
    ] as const)('createOpenAlex throws a TypeError on invalid %s', (_name, opts) => {
        let thrown: unknown;
        try {
            createOpenAlex(opts);
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(TypeError);
        expect((thrown as TypeError).cause).toMatchObject({ code: 'INVALID_OPTIONS' });
    });
});
