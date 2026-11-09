// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';

import { planRequests, toEntries } from '../../src/batch/chunk.js';
import { doiKeys, indexWorks, isTruncated, pickWork } from '../../src/batch/match.js';
import type { OpenAlexWork } from '../../src/work/api-types.js';
import { asWork } from '../helpers.js';

describe('toEntries', () => {
    test('normalizes DOIs and keeps the input label', () => {
        expect(toEntries(['https://doi.org/10.1000/A', 'nope', 42], 'doi')).toEqual([
            { input: 'https://doi.org/10.1000/A', key: '10.1000/a' },
            { input: 'nope', key: null },
            { input: '42', key: null },
        ]);
    });

    test('normalizes work ids', () => {
        expect(toEntries(['https://openalex.org/w123', 'W9', 'A1'], 'id').map((entry) => entry.key)).toEqual([
            'W123',
            'W9',
            null,
        ]);
    });

    test('yields one entry per index of a sparse array, a hole as input undefined', () => {
        const inputs: string[] = [];
        inputs[1] = '10.1000/a';
        expect(toEntries(inputs, 'doi')).toEqual([
            { input: 'undefined', key: null },
            { input: '10.1000/a', key: '10.1000/a' },
        ]);
    });
});

describe('planRequests', () => {
    test('dedupes keys and drops invalid entries', () => {
        const entries = toEntries(['10.1000/a', 'DOI:10.1000/A', 'bad', '10.1000/b'], 'doi');
        expect(planRequests(entries, 'doi', 'batch')).toEqual({ lists: [['10.1000/a', '10.1000/b']], singles: [] });
    });

    test('splits 150 keys into lists of 100 and 50', () => {
        const entries = toEntries(
            Array.from({ length: 150 }, (_, i) => `10.1000/n${i}`),
            'doi',
        );
        expect(planRequests(entries, 'doi', 'batch').lists.map((list) => list.length)).toEqual([100, 50]);
    });

    test('sends DOIs with a comma, pipe or whitespace to single lookup', () => {
        const entries = toEntries(['10.1000/a', '10.9999/a,b', '10.1000/x|y', '10.1000/x y'], 'doi');
        expect(planRequests(entries, 'doi', 'batch')).toEqual({
            lists: [['10.1000/a']],
            singles: ['10.9999/a,b', '10.1000/x|y', '10.1000/x y'],
        });
    });

    test('the single strategy sends every distinct key to single lookup', () => {
        const entries = toEntries(['W1', 'w1', 'W2'], 'id');
        expect(planRequests(entries, 'id', 'single')).toEqual({ lists: [], singles: ['W1', 'W2'] });
    });

    test('singleBelow sends a chunk with fewer keys to single lookup, per chunk', () => {
        const dois = (n: number) =>
            toEntries(
                Array.from({ length: n }, (_, i) => `10.1000/n${i}`),
                'doi',
            );
        expect(planRequests(dois(29), 'doi', 'batch', 30)).toEqual({
            lists: [],
            singles: Array.from({ length: 29 }, (_, i) => `10.1000/n${i}`),
        });
        expect(planRequests(dois(30), 'doi', 'batch', 30).lists.map((list) => list.length)).toEqual([30]);
        const large = planRequests(dois(130), 'doi', 'batch', 30);
        expect(large.lists.map((list) => list.length)).toEqual([100, 30]);
        expect(large.singles).toEqual([]);
        const tail = planRequests(dois(110), 'doi', 'batch', 30);
        expect(tail.lists.map((list) => list.length)).toEqual([100]);
        expect(tail.singles).toEqual(Array.from({ length: 10 }, (_, i) => `10.1000/n${100 + i}`));
    });

    test('singleBelow 0 or omitted keeps every chunk a list', () => {
        const entries = toEntries(['10.1000/a', '10.1000/b'], 'doi');
        const plan = { lists: [['10.1000/a', '10.1000/b']], singles: [] };
        expect(planRequests(entries, 'doi', 'batch', 0)).toEqual(plan);
        expect(planRequests(entries, 'doi', 'batch')).toEqual(plan);
    });

    test('the single strategy wins over singleBelow', () => {
        const entries = toEntries(
            Array.from({ length: 50 }, (_, i) => `W${i + 1}`),
            'id',
        );
        expect(planRequests(entries, 'id', 'single', 30)).toEqual({
            lists: [],
            singles: Array.from({ length: 50 }, (_, i) => `W${i + 1}`),
        });
    });

    test('an unsafe DOI and a small remainder both go to single lookup once each', () => {
        const entries = toEntries(['10.1000/a', '10.9999/a,b', '10.1000/b', '10.1000/a'], 'doi');
        expect(planRequests(entries, 'doi', 'batch', 30)).toEqual({
            lists: [],
            singles: ['10.9999/a,b', '10.1000/a', '10.1000/b'],
        });
    });

    test('no valid keys gives an empty plan', () => {
        expect(planRequests(toEntries(['x'], 'doi'), 'doi', 'batch')).toEqual({ lists: [], singles: [] });
    });
});

function work(fields: Record<string, unknown>): OpenAlexWork {
    return asWork({ id: 'https://openalex.org/W1', ...fields });
}

describe('doiKeys', () => {
    test('collects the DOI from every source a filter can match', () => {
        const keys = doiKeys(
            work({
                doi: 'https://doi.org/10.1000/Main',
                ids: { doi: 'https://doi.org/10.1000/ids' },
                locations: [
                    { id: 'doi:10.5555/epsilon.0000.00005' },
                    { doi: '10.1000/loc' },
                    { landing_page_url: 'https://doi.org/10.1000/landing' },
                    { pdf_url: 'https://dx.doi.org/10.1000/pdf' },
                    { id: 'pmh:oai:x', landing_page_url: 'https://example.org/paper' },
                    null,
                ],
            }),
        );
        expect([...keys].sort()).toEqual([
            '10.1000/ids',
            '10.1000/landing',
            '10.1000/loc',
            '10.1000/main',
            '10.1000/pdf',
            '10.5555/epsilon.0000.00005',
        ]);
    });

    test('drops the query string and fragment of landing-page and PDF URLs', () => {
        const keys = doiKeys(
            work({
                doi: null,
                locations: [
                    { landing_page_url: 'https://doi.org/10.1000/landing?utm_source=x' },
                    { pdf_url: 'https://doi.org/10.1000/pdf#page=2' },
                ],
            }),
        );
        expect([...keys].sort()).toEqual(['10.1000/landing', '10.1000/pdf']);
    });

    test('reads primary_location and best_oa_location, which list responses keep when they cut locations', () => {
        const keys = doiKeys(
            work({
                doi: null,
                locations: [],
                primary_location: { id: 'doi:10.1000/primary' },
                best_oa_location: { landing_page_url: 'https://doi.org/10.1000/oa' },
            }),
        );
        expect([...keys].sort()).toEqual(['10.1000/oa', '10.1000/primary']);
    });

    test('a work without DOIs has no keys', () => {
        expect(doiKeys(work({ doi: null, locations: [] })).size).toBe(0);
    });
});

describe('indexWorks', () => {
    test('maps each DOI to every work that holds it', () => {
        const a = work({ id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1000/x' });
        const b = work({ id: 'https://openalex.org/W2', locations: [{ id: 'doi:10.1000/x' }] });
        const index = indexWorks([a, b], 'doi');
        expect(index.get('10.1000/x')).toEqual([a, b]);
    });

    test('maps works by short W id for id lookups', () => {
        const a = work({ id: 'https://openalex.org/W77' });
        expect([...indexWorks([a], 'id').keys()]).toEqual(['W77']);
    });

    test('skips null and non-object results', () => {
        const a = work({ id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1000/x' });
        const results = [null, 'x', a] as unknown as OpenAlexWork[];
        expect(indexWorks(results, 'doi').get('10.1000/x')).toEqual([a]);
        expect([...indexWorks(results, 'id').keys()]).toEqual(['W1']);
    });
});

describe('pickWork', () => {
    test('prefers the highest cited_by_count', () => {
        const low = work({ id: 'https://openalex.org/W1', cited_by_count: 1 });
        const high = work({ id: 'https://openalex.org/W2', cited_by_count: 5 });
        expect(pickWork([low, high])).toBe(high);
    });

    test('breaks ties with the lowest W number', () => {
        const newer = work({ id: 'https://openalex.org/W9000000022', cited_by_count: 3 });
        const older = work({ id: 'https://openalex.org/W9000000021', cited_by_count: 3 });
        expect(pickWork([newer, older])).toBe(older);
    });

    test('returns null for no candidates', () => {
        expect(pickWork([])).toBeNull();
    });

    test('prefers the work whose own DOI is the key over a more cited location match', () => {
        const owner = work({ id: 'https://openalex.org/W9', doi: 'https://doi.org/10.1000/x', cited_by_count: 1 });
        const holder = work({
            id: 'https://openalex.org/W1',
            locations: [{ id: 'doi:10.1000/x' }],
            cited_by_count: 50,
        });
        expect(pickWork([holder, owner], '10.1000/x')).toBe(owner);
        expect(pickWork([holder, owner])).toBe(holder);
    });

    test('compares W numbers beyond safe integers and puts works without an id last', () => {
        const big = work({ id: 'https://openalex.org/W90071992547409931', cited_by_count: 0 });
        const bigger = work({ id: 'https://openalex.org/W90071992547409932', cited_by_count: 0 });
        const none = work({ id: null, cited_by_count: 0 });
        expect(pickWork([none, bigger, big])).toBe(big);
        expect(pickWork([none, work({ id: null, cited_by_count: 0 })])).toBe(none);
    });
});

describe('isTruncated', () => {
    test('is true at 100 authorships or locations', () => {
        expect(isTruncated(work({ authorships: Array(100).fill({}) }))).toBe(true);
        expect(isTruncated(work({ locations: Array(100).fill({}) }))).toBe(true);
    });

    test('is false below 100 and for missing arrays', () => {
        expect(isTruncated(work({ authorships: Array(99).fill({}), locations: [] }))).toBe(false);
        expect(isTruncated(work({}))).toBe(false);
    });
});
