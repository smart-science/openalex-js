// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createOpenAlex, type OpenAlexOptions } from '../src/client.js';
import { DEFAULT_TIMEOUT_MS } from '../src/utils/constants.js';
import { FIELD_NAMES } from '../src/work/record-types.js';
import {
    abortableFetch,
    asDoi,
    asOptions,
    asRenameMap,
    ERROR_KEYS,
    errorOf,
    type FetchTrap,
    installGlobalFetchTrap,
    jsonResponse,
    loadFixtureText,
    loadWork,
    makeFetch,
    type RecordedCall,
    type RecordedTimer,
    recordTimers,
    SINGLE_ATTEMPT,
    stableJson,
    textResponse,
    typedOkOf,
    workOf,
} from './helpers.js';

const DOI = '10.5555/alpha00001';

let trap: FetchTrap;

beforeEach(() => {
    trap = installGlobalFetchTrap();
});

afterEach(() => {
    trap.assertUntouched();
    trap.restore();
});

async function workFetch() {
    const work = await loadWork('work-article');
    return makeFetch(() => jsonResponse(work));
}

function factoryCause(options: unknown): Record<string, unknown> {
    let thrown: unknown;
    try {
        createOpenAlex(asOptions(options));
    } catch (error) {
        thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    return (thrown as { cause: Record<string, unknown> }).cause;
}

describe('fetchDoi canonical result', () => {
    test('resolves a DOI with no key and no config', async () => {
        const { fn } = await workFetch();
        const result = workOf(await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI));
        const data = result.record as Record<string, unknown>;
        expect(data.title).toBe('Example Article Alpha: a made-up study');
        expect(data.doi).toBe(DOI);
        expect(data.publication_year).toBe(2013);
    });

    test('data is canonical WorkRecord without rename map', async () => {
        const { fn } = await workFetch();
        const result = workOf(await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI));
        expect(Object.keys(result.record as object).sort()).toEqual([...FIELD_NAMES].sort());
    });

    test('raw carries every returned field unmodified', async () => {
        const work = await loadWork('work-article');
        const { fn } = makeFetch(() => jsonResponse(work));
        const result = workOf(await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI));
        expect(Object.keys(result.raw as object)).toHaveLength(50);
        expect(result.raw).toEqual(work as unknown as Record<string, unknown>);
        expect(stableJson(result.raw)).toBe(stableJson(work));
    });

    test('shaping does not mutate raw', async () => {
        const work = await loadWork('work-article');
        const pristine = await loadWork('work-article');
        const { fn } = makeFetch(() => jsonResponse(work));
        const result = workOf(await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI));
        expect(stableJson(result.raw)).toBe(stableJson(pristine));
    });

    test('abstract is reconstructed automatically', async () => {
        const openAccess = await loadWork('work-open-access');
        const { fn } = makeFetch(() => jsonResponse(openAccess));
        const result = workOf(await createOpenAlex({ fetchFn: fn }).fetchDoi('10.5555/journal.beta.0000002'));
        const data = result.record as Record<string, unknown>;
        expect(typeof data.abstract).toBe('string');
        expect((data.abstract as string).startsWith('BACKGROUND: This made-up abstract')).toBe(true);
        expect((result.raw as { abstract_inverted_index: unknown }).abstract_inverted_index).toBeTruthy();
    });

    test('a work with no inverted index yields a null abstract', async () => {
        const { fn } = await workFetch();
        const result = workOf(await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI));
        expect((result.record as Record<string, unknown>).abstract).toBeNull();
    });

    test('all OA URLs are reachable via data.oa_locations and raw.locations', async () => {
        const { fn } = await workFetch();
        const result = workOf(await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI));
        expect((result.record as { oa_locations: unknown[] }).oa_locations).toHaveLength(4);
        expect((result.raw as { locations: unknown[] }).locations).toHaveLength(6);
    });

    test('record and raw are not frozen', async () => {
        const { fn } = await workFetch();
        const result = await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI);
        const work = workOf(result);
        expect(Object.isFrozen(result)).toBe(false);
        expect(Object.isFrozen(work)).toBe(false);
        expect(Object.isFrozen(work.record)).toBe(false);
        expect(Object.isFrozen(work.raw)).toBe(false);
    });

    test('success is a single-value envelope holding record, raw, and budget', async () => {
        const { fn } = await workFetch();
        const result = await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI);
        expect(Object.keys(result)).toEqual(['ok', 'data']);
        expect(Object.keys(workOf(result)).sort()).toEqual(['budget', 'raw', 'record', 'requestedDoi']);
    });

    test('every prefix form of a DOI produces the identical request', async () => {
        const forms = [
            '10.5555/alpha00001',
            '10.5555/ALPHA00001',
            'https://doi.org/10.5555/alpha00001',
            'http://dx.doi.org/10.5555/alpha00001',
            'doi:10.5555/alpha00001',
            'DOI: 10.5555/alpha00001',
            '  10.5555/alpha00001  ',
        ];
        const work = await loadWork('work-article');
        const urls: string[] = [];
        for (const form of forms) {
            const { fn, calls } = makeFetch(() => jsonResponse(work));
            const result = await createOpenAlex({ fetchFn: fn }).fetchDoi(form);
            expect(result.ok, form).toBe(true);
            urls.push(calls[0]?.url ?? '');
        }
        expect(new Set(urls).size).toBe(1);
        expect(urls[0]).toBe('https://api.openalex.org/works/doi:10.5555%2Falpha00001');
    });
});

describe('fetchDoi with rename map', () => {
    test('new names present, old names absent, types unchanged', async () => {
        const { fn } = await workFetch();
        const result = workOf(
            await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI, {
                rename: { ref_title: 'title', ref_year: 'publication_year' },
            }),
        );
        const data = result.record as Record<string, unknown>;
        expect(data.ref_title).toBe('Example Article Alpha: a made-up study');
        expect(data.ref_year).toBe(2013);
        expect(typeof data.ref_year).toBe('number');
        expect('title' in data).toBe(false);
        expect('publication_year' in data).toBe(false);
        expect(data.journal).toBe('Journal Alpha');
    });

    test('raw is unchanged by a rename map', async () => {
        const work = await loadWork('work-article');
        const { fn } = makeFetch(() => jsonResponse(work));
        const result = workOf(await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI, { rename: { ref_title: 'title' } }));
        expect(result.raw).toEqual(work as unknown as Record<string, unknown>);
        expect((result.raw as { title: string }).title).toBe('Example Article Alpha: a made-up study');
    });

    test('an empty rename map yields the canonical record', async () => {
        const { fn } = await workFetch();
        const result = workOf(await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI, { rename: {} }));
        expect(Object.keys(result.record as object).sort()).toEqual([...FIELD_NAMES].sort());
    });

    test('the failure envelope is identical with and without a map', async () => {
        const html = await loadFixtureText('error-404.html');
        const { fn } = makeFetch(() => textResponse(html, { status: 404 }));
        const client = createOpenAlex({ fetchFn: fn });
        const without = await client.fetchDoi(DOI);
        const withMap = await client.fetchDoi(DOI, { rename: { ref_title: 'title' } });
        expect(stableJson(without)).toBe(stableJson(withMap));
        expect(Object.keys(without)).toEqual(Object.keys(withMap));
    });
});

describe('validation happens before any network call', () => {
    test('invalid DOI yields INVALID_DOI without fetch call', async () => {
        const { fn, calls } = makeFetch(() => jsonResponse({}));
        const error = errorOf(await createOpenAlex({ fetchFn: fn }).fetchDoi('not-a-doi'));
        expect(error.code).toBe('INVALID_DOI');
        expect(error.message).toBe('"not-a-doi" is not a valid DOI');
        expect(calls).toHaveLength(0);
    });

    test('every invalid DOI form is rejected without a call', async () => {
        for (const bad of ['', '   ', '10.5555', 'not-a-doi', 'https://example.org/x', '10.5555/']) {
            const { fn, calls } = makeFetch(() => jsonResponse({}));
            const error = errorOf(await createOpenAlex({ fetchFn: fn }).fetchDoi(bad));
            expect(error.code, JSON.stringify(bad)).toBe('INVALID_DOI');
            expect(calls, JSON.stringify(bad)).toHaveLength(0);
        }
    });

    test('unknown rename field yields INVALID_RENAME without fetch call', async () => {
        const { fn, calls } = makeFetch(() => jsonResponse({}));
        const error = errorOf(
            await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI, { rename: asRenameMap({ x: 'titel', y: 'jahr' }) }),
        );
        expect(error.code).toBe('INVALID_RENAME');
        expect(error.message).toContain('titel');
        expect(error.message).toContain('jahr');
        expect(calls).toHaveLength(0);
    });

    test('colliding rename target yields RENAME_COLLISION without fetch call', async () => {
        const { fn, calls } = makeFetch(() => jsonResponse({}));
        const error = errorOf(await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI, { rename: { abstract: 'title' } }));
        expect(error.code).toBe('RENAME_COLLISION');
        expect(calls).toHaveLength(0);
    });

    test('options are validated before the DOI', async () => {
        const { fn, calls } = makeFetch(() => jsonResponse({}));
        const error = errorOf(
            await createOpenAlex({ fetchFn: fn }).fetchDoi('not-a-doi', asOptions({ timeoutMs: -1 })),
        );
        expect(error.code).toBe('INVALID_OPTIONS');
        expect(calls).toHaveLength(0);
    });

    test('DOI is validated before rename map', async () => {
        const { fn, calls } = makeFetch(() => jsonResponse({}));
        const error = errorOf(
            await createOpenAlex({ fetchFn: fn }).fetchDoi('not-a-doi', { rename: asRenameMap({ x: 'titel' }) }),
        );
        expect(error.code).toBe('INVALID_DOI');
        expect(calls).toHaveLength(0);
    });

    test('with multiple invalid parameters, options error takes precedence', async () => {
        const { fn, calls } = makeFetch(() => jsonResponse({}));
        const error = errorOf(
            await createOpenAlex({ fetchFn: fn }).fetchDoi(
                asDoi(undefined),
                asOptions({ timeoutMs: 0, rename: asRenameMap({ x: 'titel' }) }),
            ),
        );
        expect(error.code).toBe('INVALID_OPTIONS');
        expect(calls).toHaveLength(0);
    });
});

describe('INVALID_OPTIONS matrix', () => {
    async function reject(options: unknown): Promise<Record<string, unknown>> {
        const { fn, calls } = makeFetch(() => jsonResponse({}));
        const error = errorOf(await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI, asOptions(options)));
        expect(calls).toHaveLength(0);
        return error;
    }

    test('timeoutMs must be a finite number greater than 0', async () => {
        for (const timeoutMs of [0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, '5', null, {}]) {
            const error = await reject({ timeoutMs });
            expect(error.code, JSON.stringify(timeoutMs) ?? 'undefined').toBe('INVALID_OPTIONS');
            expect(error.message).toContain('timeoutMs');
        }
    });

    test('a valid timeoutMs is accepted', async () => {
        const { fn } = await workFetch();
        const client = createOpenAlex({ fetchFn: fn });
        expect((await client.fetchDoi(DOI, { timeoutMs: 1 })).ok).toBe(true);
        expect((await client.fetchDoi(DOI, { timeoutMs: DEFAULT_TIMEOUT_MS })).ok).toBe(true);
    });

    test('apiKey must be a non-blank string of printable characters', () => {
        for (const apiKey of ['', '   ', '\t\n', 42, null, {}, []]) {
            const cause = factoryCause({ apiKey });
            expect(cause.code, JSON.stringify(apiKey)).toBe('INVALID_OPTIONS');
            expect(cause.message).toContain('apiKey');
        }
    });

    test('an apiKey with a control or non-ASCII character is rejected, not turned into a NETWORK error', () => {
        // `new Headers()` throws on these, which used to surface as an unhelpful NETWORK failure.
        for (const apiKey of ['a\nb', 'a\rb', 'a\tb', 'key\u0000', 'kéy', '“key”']) {
            const cause = factoryCause({ apiKey });
            expect(cause.code, JSON.stringify(apiKey)).toBe('INVALID_OPTIONS');
            expect(cause.message).toBe('Invalid option "apiKey": must contain only printable ASCII characters');
        }
    });

    test('signal must be an AbortSignal', async () => {
        for (const signal of [42, 'abort', {}, [], null, new AbortController()]) {
            const error = await reject({ signal });
            expect(error.code, JSON.stringify(signal)).toBe('INVALID_OPTIONS');
            expect(error.message).toContain('signal');
        }
    });

    test('a valid signal that never aborts is accepted', async () => {
        const { fn } = await workFetch();
        const client = createOpenAlex({ fetchFn: fn });
        expect((await client.fetchDoi(DOI, { signal: new AbortController().signal })).ok).toBe(true);
    });

    test('fetchFn must be a function', async () => {
        for (const fetchFn of [42, null, {}, 'fetch', []]) {
            const error = errorOf(await createOpenAlex().fetchDoi(DOI, asOptions({ fetchFn })));
            expect(error.code, JSON.stringify(fetchFn)).toBe('INVALID_OPTIONS');
            expect(error.message).toContain('fetchFn');
        }
    });

    test('an invalid per-call fetchFn never falls through to the factory fetchFn', async () => {
        const factory = makeFetch(() => jsonResponse({}));
        const client = createOpenAlex({ fetchFn: factory.fn });
        const error = errorOf(await client.fetchDoi(DOI, asOptions({ fetchFn: 42 })));
        expect(error.code).toBe('INVALID_OPTIONS');
        expect(factory.calls).toHaveLength(0);
    });

    test('null options are INVALID_OPTIONS per call', async () => {
        const factory = makeFetch(() => jsonResponse({}));
        const client = createOpenAlex({ fetchFn: factory.fn });
        expect(errorOf(await client.fetchDoi(DOI, asOptions(null))).code).toBe('INVALID_OPTIONS');
        expect(factory.calls).toHaveLength(0);
    });

    test('rename must be a plain object', async () => {
        for (const rename of [null, [], 'title', 42, true]) {
            const error = await reject({ rename });
            expect(error.code, JSON.stringify(rename)).toBe('INVALID_OPTIONS');
        }
        expect(factoryCause({ rename: null }).code).toBe('INVALID_OPTIONS');
    });

    test('non-plain objects (Map, Date, AbortSignal) are not options or rename maps', async () => {
        for (const rename of [new Map([['ref_title', 'title']]), new Date(0)]) {
            expect((await reject({ rename })).code).toBe('INVALID_OPTIONS');
            expect(() => createOpenAlex(asOptions({ rename }))).toThrow(TypeError);
        }
        const signal = new AbortController().signal;
        expect((await reject(signal)).code).toBe('INVALID_OPTIONS');
        expect(() => createOpenAlex(asOptions(signal))).toThrow(TypeError);
    });

    test('a null-prototype options object is valid, for the factory and per call', async () => {
        const { fn } = await workFetch();
        const options = Object.assign(Object.create(null) as Record<string, unknown>, { fetchFn: fn });
        expect((await createOpenAlex(asOptions(options)).fetchDoi(DOI)).ok).toBe(true);
        expect((await createOpenAlex().fetchDoi(DOI, asOptions(options))).ok).toBe(true);
    });

    test('an entirely absent options object is valid', async () => {
        const { fn } = await workFetch();
        expect((await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI)).ok).toBe(true);
    });

    test('createOpenAlex throws TypeError with cause for invalid configuration', () => {
        const invalidConfigs: readonly [unknown, string][] = [
            [null, 'INVALID_OPTIONS'],
            [42, 'INVALID_OPTIONS'],
            [[], 'INVALID_OPTIONS'],
            [{ apiKey: '' }, 'INVALID_OPTIONS'],
            [{ apiKey: '   ' }, 'INVALID_OPTIONS'],
            [{ apiKey: null }, 'INVALID_OPTIONS'],
            [{ apiKey: false }, 'INVALID_OPTIONS'],
            [{ apiKey: 42 }, 'INVALID_OPTIONS'],
            [{ apiKey: 'a\nb' }, 'INVALID_OPTIONS'],
            [{ timeoutMs: 0 }, 'INVALID_OPTIONS'],
            [{ timeoutMs: -1 }, 'INVALID_OPTIONS'],
            [{ timeoutMs: Number.NaN }, 'INVALID_OPTIONS'],
            [{ timeoutMs: '5' }, 'INVALID_OPTIONS'],
            [{ signal: 42 }, 'INVALID_OPTIONS'],
            [{ fetchFn: 'not a fn' }, 'INVALID_OPTIONS'],
            [{ rename: 'not an object' }, 'INVALID_OPTIONS'],
            [{ rename: { x: 'not_a_work_field' } }, 'INVALID_RENAME'],
            [{ rename: { abstract: 'title' } }, 'RENAME_COLLISION'],
        ];

        for (const [config, expectedCode] of invalidConfigs) {
            expect(factoryCause(config).code, JSON.stringify(config)).toBe(expectedCode);
        }
    });

    test('createOpenAlex throws TypeError when an options getter throws', () => {
        const throwingConfig = {
            get timeoutMs(): number {
                throw new Error('getter exploded');
            },
        };
        expect(() => createOpenAlex(throwingConfig)).toThrow(TypeError);
    });

    test('createOpenAlex does not throw for benign configurations', () => {
        expect(() => createOpenAlex(undefined)).not.toThrow();
        expect(() => createOpenAlex({})).not.toThrow();
        expect(() => createOpenAlex({ apiKey: undefined })).not.toThrow();
        expect(() => createOpenAlex({ apiKey: '  KEY  ' })).not.toThrow();
        expect(() => createOpenAlex(asOptions({ unknownKey: 123 }))).not.toThrow();
    });

    test('snapshot: factory options and rename map mutations do not affect client', async () => {
        const renameMap = { ref_title: 'title' } as const;
        const rawOptions = { rename: renameMap, timeoutMs: 5000 };
        const { fn } = await workFetch();
        const client = createOpenAlex({ ...rawOptions, fetchFn: fn });

        // Mutate the original inputs after creation
        (renameMap as Record<string, string>).ref_title = 'doi';
        rawOptions.timeoutMs = 99999;

        const result = typedOkOf(await client.fetchDoi(DOI));
        expect(result.data.record.ref_title).toBe('Example Article Alpha: a made-up study');
    });

    test('snapshot: getter is evaluated once and stored', async () => {
        let reads = 0;
        const optionsWithGetter = {
            get timeoutMs() {
                reads++;
                return 4000;
            },
        };
        const { fn } = await workFetch();
        const client = createOpenAlex({ ...optionsWithGetter, fetchFn: fn });
        expect(reads).toBe(1);
        await client.fetchDoi(DOI);
        expect(reads).toBe(1);
    });
});

describe('createOpenAlex factory', () => {
    test('returns a frozen object exposing fetchDoi, fetchWorkById, fetchContent and fetchBudget', () => {
        const client = createOpenAlex();
        expect(Object.keys(client)).toEqual(['fetchDoi', 'fetchWorkById', 'fetchContent', 'fetchBudget']);
        expect(Object.isFrozen(client)).toBe(true);
        expect(typeof client.fetchDoi).toBe('function');
    });

    test('frozen client rejects mutation', () => {
        const client = createOpenAlex();
        expect(() => {
            (client as unknown as Record<string, unknown>).fetchDoi = () => undefined;
        }).toThrow();
        expect(() => {
            (client as unknown as Record<string, unknown>).extra = 1;
        }).toThrow();
    });

    test('destructured fetchDoi retains function context', async () => {
        const { fn } = await workFetch();
        const { fetchDoi: bound } = createOpenAlex({ fetchFn: fn });
        const result = await bound(DOI);
        expect(result.ok).toBe(true);
    });

    test('factory options are applied to every call', async () => {
        const { fn, calls } = await workFetch();
        const client = createOpenAlex({ fetchFn: fn, apiKey: 'FACTORY', timeoutMs: 1234 });
        await client.fetchDoi(DOI);
        expect(calls[0]?.headers.get('Authorization')).toBe('Bearer FACTORY');
        expect(calls[0]?.url.startsWith('https://api.openalex.org/')).toBe(true);
    });

    test('per-call options override factory options', async () => {
        const factory = makeFetch(() => jsonResponse({}));
        const perCall = await workFetch();
        const client = createOpenAlex({ fetchFn: factory.fn, apiKey: 'FACTORY' });
        await client.fetchDoi(DOI, { fetchFn: perCall.fn });
        expect(factory.calls).toHaveLength(0);
        expect(perCall.calls).toHaveLength(1);
        expect(perCall.calls[0]?.headers.get('Authorization')).toBe('Bearer FACTORY');
    });

    test('apiKey is ignored per call and the factory key is sent', async () => {
        const { fn, calls } = await workFetch();
        const client = createOpenAlex({ fetchFn: fn, apiKey: 'FACTORY' });
        await client.fetchDoi(DOI, asOptions({ apiKey: 'PERCALL' }));
        expect(calls[0]?.headers.get('Authorization')).toBe('Bearer FACTORY');
    });

    test('the endpoints are fixed: a smuggled baseUrl is ignored', async () => {
        const { fn, calls } = await workFetch();
        const client = createOpenAlex(asOptions({ fetchFn: fn, baseUrl: 'https://elsewhere.test' }));
        await client.fetchDoi(DOI, asOptions({ baseUrl: 'https://elsewhere.test' }));
        expect(calls[0]?.url.startsWith('https://api.openalex.org/works/')).toBe(true);
    });

    test('an explicit undefined per-call option does not wipe the factory value', async () => {
        const { fn, calls } = await workFetch();
        const client = createOpenAlex({ fetchFn: fn, apiKey: 'FACTORY' });
        await client.fetchDoi(DOI, { fetchFn: undefined });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.headers.get('Authorization')).toBe('Bearer FACTORY');
    });

    test('factory options are not mutated by a call', async () => {
        const { fn } = await workFetch();
        const options: OpenAlexOptions = { fetchFn: fn, apiKey: 'FACTORY' };
        const before = { ...options };
        const client = createOpenAlex(options);
        await client.fetchDoi(DOI, { timeoutMs: 1_000 });
        expect(options).toEqual(before);
    });

    test('factory rename applies at runtime', async () => {
        const { fn } = await workFetch();
        const client = createOpenAlex({ fetchFn: fn, rename: { ref_title: 'title' } });
        const result = typedOkOf(await client.fetchDoi(DOI));
        // Typed access, no cast: the factory map is tracked in the type and the runtime agrees.
        expect(result.data.record.ref_title).toBe('Example Article Alpha: a made-up study');
        expect('title' in result.data.record).toBe(false);
    });

    test('a factory rename survives per-call options without a map, and destructuring', async () => {
        const { fn } = await workFetch();
        const { fetchDoi: bound } = createOpenAlex({ fetchFn: fn, rename: { ref_title: 'title' } });
        const result = typedOkOf(await bound(DOI, { timeoutMs: 5_000 }));
        expect(result.data.record.ref_title).toBe('Example Article Alpha: a made-up study');
        expect('title' in result.data.record).toBe(false);
    });

    test('a per-call rename overrides the factory rename', async () => {
        const { fn } = await workFetch();
        const client = createOpenAlex({ fetchFn: fn, rename: { ref_title: 'title' } });
        const result = typedOkOf(await client.fetchDoi(DOI, { rename: { ref_doi: 'doi' } }));
        expect(result.data.record.ref_doi).toBe(DOI);
        expect(result.data.record.title).toBe('Example Article Alpha: a made-up study');
        expect('ref_title' in result.data.record).toBe(false);
    });

    test('options stored in an untyped variable rename at runtime exactly as typed', async () => {
        const { fn } = await workFetch();
        const options = { fetchFn: fn, rename: { ref_title: 'title' } } as const;
        const result = typedOkOf(await createOpenAlex().fetchDoi(DOI, options));
        expect(result.data.record.ref_title).toBe('Example Article Alpha: a made-up study');
        expect('title' in result.data.record).toBe(false);
    });

    test('createOpenAlex() with no arguments works', async () => {
        const { fn } = await workFetch();
        const client = createOpenAlex();
        expect((await client.fetchDoi(DOI, { fetchFn: fn })).ok).toBe(true);
    });

    test('two clients are independent', async () => {
        const a = makeFetch(() => jsonResponse({ id: 'a' }));
        const b = makeFetch(() => jsonResponse({ id: 'b' }));
        const clientA = createOpenAlex({ fetchFn: a.fn });
        const clientB = createOpenAlex({ fetchFn: b.fn });
        await clientA.fetchDoi(DOI);
        expect(a.calls).toHaveLength(1);
        expect(b.calls).toHaveLength(0);
        await clientB.fetchDoi(DOI);
        expect(a.calls).toHaveLength(1);
        expect(b.calls).toHaveLength(1);
    });
});

describe('transport failures surface through fetchDoi', () => {
    test('404 yields NOT_FOUND naming the normalized DOI', async () => {
        const html = await loadFixtureText('error-404.html');
        const { fn } = makeFetch(() => textResponse(html, { status: 404 }));
        const error = errorOf(await createOpenAlex({ fetchFn: fn }).fetchDoi('HTTPS://DOI.ORG/10.5555/ALPHA00001'));
        expect(error.code).toBe('NOT_FOUND');
        expect(error.message).toBe(`OpenAlex has no record for DOI "${DOI}"`);
        // There WAS a response, so the status is reported rather than left null.
        expect(error.status).toBe(404);
    });

    test('429 whose Retry-After exceeds maxWaitMs yields RATE_LIMITED immediately', async () => {
        const { fn, calls } = makeFetch(() => textResponse('{}', { status: 429, headers: { 'Retry-After': '30' } }));
        const error = errorOf(await createOpenAlex({ fetchFn: fn, limiterOptions: SINGLE_ATTEMPT }).fetchDoi(DOI));
        expect(error.code).toBe('RATE_LIMITED');
        expect(error.retryAfterSeconds).toBe(30);
        expect(calls).toHaveLength(1);
    });

    test('401 is AUTH, a broken body is PARSE, a dead socket is NETWORK', async () => {
        const auth = makeFetch(() => textResponse('{}', { status: 401 }));
        expect(errorOf(await createOpenAlex({ fetchFn: auth.fn, apiKey: 'bogus' }).fetchDoi(DOI)).code).toBe('AUTH');

        const broken = makeFetch(() => textResponse('not json'));
        expect(errorOf(await createOpenAlex({ fetchFn: broken.fn }).fetchDoi(DOI)).code).toBe('PARSE');

        const down = makeFetch(() => Promise.reject(new Error('down')));
        expect(
            errorOf(await createOpenAlex({ fetchFn: down.fn, limiterOptions: SINGLE_ATTEMPT }).fetchDoi(DOI)).code,
        ).toBe('NETWORK');
    });

    test('a timeout is TIMEOUT', async () => {
        const { fn } = abortableFetch();
        const error = errorOf(
            await createOpenAlex({ fetchFn: fn, limiterOptions: SINGLE_ATTEMPT }).fetchDoi(DOI, { timeoutMs: 10 }),
        );
        expect(error.code).toBe('TIMEOUT');
        expect(error.message).toBe('Request timed out after 10ms');
    });

    test('default timeout is 10s for JSON calls when omitted', async () => {
        // The request sets its timeout timer right before it calls fetchFn.
        const { timers, restore } = recordTimers();
        try {
            let timeout: RecordedTimer | undefined;
            let called: () => void = () => {};
            const fetched = new Promise<void>((resolve) => {
                called = resolve;
            });
            const { fn } = makeFetch(
                (call: { signal: AbortSignal | null }) =>
                    new Promise((_resolve, reject) => {
                        timeout = timers.at(-1);
                        called();
                        call.signal?.addEventListener('abort', () => {
                            const reason = call.signal?.reason;
                            reject(reason instanceof Error ? reason : new Error('aborted'));
                        });
                    }),
            );
            const pending = createOpenAlex({ fetchFn: fn, limiterOptions: SINGLE_ATTEMPT }).fetchDoi(DOI);
            await fetched;
            expect(timeout?.ms).toBe(10_000);

            timeout?.fire();
            const error = errorOf(await pending);
            expect(error.code).toBe('TIMEOUT');
            expect(error.message).toBe('Request timed out after 10000ms');
        } finally {
            restore();
        }
    });

    test('caller-aborted request yields ABORTED', async () => {
        const upfront = makeFetch(() => jsonResponse({}));
        const early = errorOf(
            await createOpenAlex({ fetchFn: upfront.fn }).fetchDoi(DOI, { signal: AbortSignal.abort() }),
        );
        expect(early.code).toBe('ABORTED');
        expect(upfront.calls).toHaveLength(0);

        const controller = new AbortController();
        const { fn } = abortableFetch(500);
        const pending = createOpenAlex({ fetchFn: fn }).fetchDoi(DOI, { signal: controller.signal, timeoutMs: 10_000 });
        controller.abort();
        expect(errorOf(await pending).code).toBe('ABORTED');
    });

    test('a factory signal cancels every call made through that client', async () => {
        const controller = new AbortController();
        const client = createOpenAlex({ signal: controller.signal, fetchFn: makeFetch(() => jsonResponse({})).fn });
        controller.abort();
        expect(errorOf(await client.fetchDoi(DOI)).code).toBe('ABORTED');
    });

    test('factory abort mid-flight with per-call signal present yields ABORTED with factory reason', async () => {
        const factoryController = new AbortController();
        const callController = new AbortController();
        const { fn } = abortableFetch(500);
        const client = createOpenAlex({ signal: factoryController.signal, fetchFn: fn });
        const pending = client.fetchDoi(DOI, { signal: callController.signal, timeoutMs: 10_000 });
        factoryController.abort('factory shutdown');
        const error = errorOf(await pending);
        expect(error.code).toBe('ABORTED');
        expect(error.cause).toBe('factory shutdown');
    });

    test('per-call abort only aborts that call without affecting factory signal or concurrent calls', async () => {
        const factoryController = new AbortController();
        const call1Controller = new AbortController();
        const call2Controller = new AbortController();
        const work = await loadWork('work-article');
        const { fn } = makeFetch((call) => {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => resolve(jsonResponse(work)), 50);
                call.signal?.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(new DOMException('The operation was aborted', 'AbortError'));
                });
            });
        });
        const client = createOpenAlex({ signal: factoryController.signal, fetchFn: fn });
        const p1 = client.fetchDoi(DOI, { signal: call1Controller.signal, timeoutMs: 10_000 });
        const p2 = client.fetchDoi(DOI, { signal: call2Controller.signal, timeoutMs: 10_000 });
        call1Controller.abort('call 1 cancel');
        const res1 = await p1;
        const res2 = await p2;
        expect(res1.ok).toBe(false);
        expect(errorOf(res1).code).toBe('ABORTED');
        expect(res2.ok).toBe(true);
        expect(factoryController.signal.aborted).toBe(false);
    });

    test('pre-aborted factory signal yields ABORTED without calling fetchFn', async () => {
        const factoryController = new AbortController();
        factoryController.abort('stopped');
        const { fn, calls } = makeFetch(() => jsonResponse({}));
        const client = createOpenAlex({ signal: factoryController.signal, fetchFn: fn });
        const error = errorOf(await client.fetchDoi(DOI));
        expect(error.code).toBe('ABORTED');
        expect(error.cause).toBe('stopped');
        expect(calls).toHaveLength(0);
    });

    test('timeout with both factory and call signals present yields TIMEOUT', async () => {
        const factoryController = new AbortController();
        const callController = new AbortController();
        const { fn } = abortableFetch(500);
        const client = createOpenAlex({
            signal: factoryController.signal,
            fetchFn: fn,
            limiterOptions: SINGLE_ATTEMPT,
        });
        const error = errorOf(await client.fetchDoi(DOI, { signal: callController.signal, timeoutMs: 10 }));
        expect(error.code).toBe('TIMEOUT');
    });

    test('listener leak guard: addEventListener and removeEventListener count matches across outcomes', async () => {
        const factoryController = new AbortController();
        const signal = factoryController.signal;
        let addCount = 0;
        let removeCount = 0;
        const originalAdd = signal.addEventListener.bind(signal);
        const originalRemove = signal.removeEventListener.bind(signal);
        signal.addEventListener = (...args: Parameters<typeof originalAdd>) => {
            addCount++;
            return originalAdd(...args);
        };
        signal.removeEventListener = (...args: Parameters<typeof originalRemove>) => {
            removeCount++;
            return originalRemove(...args);
        };

        const work = await loadWork('work-article');
        const client = createOpenAlex({ signal, limiterOptions: SINGLE_ATTEMPT, limits: { rps: 10_000 } });

        // 10 successes
        for (let i = 0; i < 10; i++) {
            await client.fetchDoi(DOI, { fetchFn: makeFetch(() => jsonResponse(work)).fn });
        }
        // 10 404s
        for (let i = 0; i < 10; i++) {
            await client.fetchDoi(DOI, { fetchFn: makeFetch(() => textResponse('', { status: 404 })).fn });
        }
        // 10 timeouts; a timeout pauses its lane past maxWaitMs, so each one needs its own client to be sent
        for (let i = 0; i < 10; i++) {
            const paused = createOpenAlex({ signal, limiterOptions: SINGLE_ATTEMPT, limits: { rps: 10_000 } });
            expect(errorOf(await paused.fetchDoi(DOI, { fetchFn: abortableFetch().fn, timeoutMs: 1 })).code).toBe(
                'TIMEOUT',
            );
        }
        // 10 call aborts mid-flight
        for (let i = 0; i < 10; i++) {
            const c = new AbortController();
            const p = client.fetchDoi(DOI, { fetchFn: abortableFetch(100).fn, signal: c.signal, timeoutMs: 10_000 });
            c.abort();
            await p;
        }

        // The queue listens on the factory signal while a request waits and removes the listener when it
        // settles; calls with their own signal listen on a composite instead.
        expect(addCount).toBe(30);
        expect(removeCount).toBe(addCount);
    });

    test('many concurrent calls on one shared signal add no listeners to it', async () => {
        const factoryController = new AbortController();
        const callController = new AbortController();
        let added = 0;
        for (const signal of [factoryController.signal, callController.signal]) {
            const originalAdd = signal.addEventListener.bind(signal);
            signal.addEventListener = (...args: Parameters<typeof originalAdd>) => {
                added++;
                return originalAdd(...args);
            };
        }
        const { fn } = abortableFetch(1000);
        const client = createOpenAlex({ signal: factoryController.signal, fetchFn: fn });
        const pending = Array.from({ length: 20 }, () => client.fetchDoi(DOI, { signal: callController.signal }));
        callController.abort();
        const results = await Promise.all(pending);

        expect(added).toBe(0);
        expect(results.map((result) => errorOf(result).code)).toEqual(Array(20).fill('ABORTED'));
    });

    test('every failure carries the uniform error shape', async () => {
        const responders: (() => unknown)[] = [
            () => textResponse('<html>', { status: 404 }),
            () => textResponse('{}', { status: 429 }),
            () => textResponse('{}', { status: 401 }),
            () => textResponse('boom', { status: 500 }),
            () => textResponse('not json'),
            () => Promise.reject(new Error('down')),
        ];
        for (const responder of responders) {
            const { fn } = makeFetch(responder);
            const error = errorOf(await createOpenAlex({ fetchFn: fn, limiterOptions: SINGLE_ATTEMPT }).fetchDoi(DOI));
            expect(Object.keys(error).sort()).toEqual([...ERROR_KEYS]);
        }
        const invalid = errorOf(await createOpenAlex().fetchDoi('nope'));
        expect(Object.keys(invalid).sort()).toEqual([...ERROR_KEYS]);
    });

    test('the error envelope carries only ok and error', async () => {
        const { fn } = makeFetch(() => textResponse('<html>', { status: 404 }));
        const result = await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI);
        expect(Object.keys(result).sort()).toEqual(['error', 'ok']);
    });
});

describe('fetchDoi never throws for any input', () => {
    const hostileDois: readonly [string, unknown][] = [
        ['undefined', undefined],
        ['null', null],
        ['a number', 10.5555],
        ['NaN', Number.NaN],
        ['true', true],
        ['an object', { doi: DOI }],
        ['a function', () => DOI],
        ['a Date', new Date(0)],
    ];

    for (const [label, value] of hostileDois) {
        test(`${label} as the DOI → INVALID_DOI, no call, no throw`, async () => {
            const { fn, calls } = makeFetch(() => jsonResponse({}));
            const promise = createOpenAlex({ fetchFn: fn }).fetchDoi(asDoi(value));
            expect(promise).toBeInstanceOf(Promise);
            const error = errorOf(await promise);
            expect(error.code).toBe('INVALID_DOI');
            expect(calls).toHaveLength(0);
        });
    }

    test('a hostile options object does not throw', async () => {
        const work = await loadWork('work-article');
        const client = createOpenAlex({ fetchFn: makeFetch(() => jsonResponse(work)).fn });
        const hostile: unknown[] = [null, 42, 'options', [], () => undefined, new Date(0)];
        for (const options of hostile) {
            const result = await client.fetchDoi(DOI, asOptions(options));
            expect(typeof (result as { ok: unknown }).ok).toBe('boolean');
        }
    });

    test('a hostile rename map does not throw', async () => {
        for (const rename of [null, 42, [], 'title', () => undefined]) {
            const { fn } = await workFetch();
            const result = await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI, asOptions({ rename }));
            expect(typeof (result as { ok: unknown }).ok).toBe('boolean');
        }
    });

    test('a rename map built from JSON with __proto__ does not pollute prototype', async () => {
        const { fn } = await workFetch();
        const rename = JSON.parse('{"__proto__":"title"}') as Record<string, string>;
        const result = await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI, { rename: asRenameMap(rename) });
        expect(result.ok).toBe(true);
        expect(({} as Record<string, unknown>).title).toBeUndefined();
        expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    });

    test('an array that throws while being read is a whole-call error, never a throw or rejection', async () => {
        const { proxy: revoked, revoke } = Proxy.revocable([DOI], {});
        revoke();
        const throwingTrap = new Proxy([DOI], {
            get() {
                throw new Error('trap');
            },
        });
        const throwingGetter: unknown[] = [DOI];
        Object.defineProperty(throwingGetter, 0, {
            get() {
                throw new Error('getter');
            },
        });
        const { fn, calls } = await workFetch();
        const oa = createOpenAlex({ apiKey: 'KEY', fetchFn: fn });
        for (const hostile of [revoked, throwingTrap, throwingGetter]) {
            const dois = hostile as unknown as string[];
            expect(errorOf(await oa.fetchDoi(dois)).code).toBe('INVALID_DOI');
            expect(errorOf(await oa.fetchWorkById(dois)).code).toBe('INVALID_ID');
        }
        expect(calls).toHaveLength(0);
    });

    test('a revoked Proxy or a Proxy-wrapped signal is INVALID_OPTIONS on every entry point, never a throw', async () => {
        const { proxy: revoked, revoke } = Proxy.revocable({}, {});
        revoke();
        const proxySignal = new Proxy(new AbortController().signal, {});
        const trapPrototype = new Proxy(
            {},
            {
                getPrototypeOf() {
                    throw new Error('trap');
                },
            },
        );
        const { fn, calls } = await workFetch();
        const oa = createOpenAlex({ apiKey: 'KEY', fetchFn: fn });
        const entryPoints: (() => Promise<unknown>)[] = [
            () => oa.fetchDoi(DOI, asOptions(revoked)),
            () => oa.fetchDoi(DOI, asOptions({ signal: proxySignal })),
            () => oa.fetchDoi(DOI, asOptions({ signal: trapPrototype })),
            () => oa.fetchWorkById('W1', asOptions(revoked)),
            () => oa.fetchContent('W1', asOptions({ signal: proxySignal })),
            () => oa.fetchBudget(asOptions({ signal: proxySignal })),
        ];
        for (const call of entryPoints) {
            const error = errorOf(await call());
            expect(error.code).toBe('INVALID_OPTIONS');
        }
        expect(calls).toHaveLength(0);
        for (const config of [revoked, { signal: proxySignal }, { signal: trapPrototype }]) {
            expect(() => createOpenAlex(asOptions(config))).toThrow(TypeError);
        }
    });

    test('a returned promise never rejects', async () => {
        const client = createOpenAlex({ limiterOptions: SINGLE_ATTEMPT });
        const cases: Promise<unknown>[] = [
            client.fetchDoi(asDoi(undefined)),
            client.fetchDoi(DOI, asOptions({ fetchFn: 42 })),
            client.fetchDoi(DOI, { fetchFn: makeFetch(() => Promise.reject(new Error('x'))).fn }),
            client.fetchDoi(DOI, {
                fetchFn: makeFetch(() => {
                    throw new Error('sync');
                }).fn,
            }),
        ];
        const settled = await Promise.allSettled(cases);
        for (const outcome of settled) {
            expect(outcome.status).toBe('fulfilled');
        }
    });
});

describe('a 2xx that is not a work is PARSE, never ok', () => {
    for (const [label, body] of [
        ['an empty object', {}],
        ['an error-shaped body', { error: 'oops', message: 'something broke' }],
        ['a work without an id', { title: 'x', doi: 'https://doi.org/10.5555/alpha00001' }],
        ['an author instead of a work', { id: 'https://openalex.org/A9000000001', display_name: 'x' }],
    ] as const) {
        test(label, async () => {
            const { fn } = makeFetch(() => jsonResponse(body));
            const error = errorOf(await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI));
            expect(error.code).toBe('PARSE');
            expect(error.retryable).toBe(false);
        });
    }

    test('the PARSE error keeps the budget headers of the 2xx response', async () => {
        const headers = { 'X-RateLimit-Cost-USD': '0', 'X-RateLimit-Remaining-USD': '0.5' };
        const { fn } = makeFetch(() => jsonResponse({}, { headers }));
        const error = errorOf(await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI));
        expect(error.code).toBe('PARSE');
        expect(error.budget?.cost_usd).toBe(0);
        expect(error.budget?.daily_remaining_usd).toBe(0.5);
    });

    test('record.id is the bare work id that fetchContent accepts', async () => {
        const { fn } = await workFetch();
        const data = workOf(await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI));
        expect((data.record as { id: unknown }).id).toBe('W9000000001');
    });
});

describe('requestedDoi keeps the lookup key when OpenAlex answers with a merged work', () => {
    test('a preprint DOI resolving to a work with another DOI', async () => {
        const work = { id: 'https://openalex.org/W9000000013', doi: 'https://doi.org/10.5555/zeta.00006' };
        const { fn } = makeFetch(() => jsonResponse(work));
        const data = workOf(
            await createOpenAlex({ fetchFn: fn }).fetchDoi('https://doi.org/10.5555/Epsilon.0000.00005'),
        );
        expect(data.requestedDoi).toBe('10.5555/epsilon.0000.00005');
        expect((data.record as { doi: unknown }).doi).toBe('10.5555/zeta.00006');
    });
});

describe('retry decisions through fetchDoi', () => {
    test('a 429 with a spent daily budget waits until the reset', async () => {
        const headers = { 'X-RateLimit-Remaining-USD': '0', 'X-RateLimit-Reset': '3600' };
        const { fn } = makeFetch(() => new Response('', { status: 429, headers }));
        const error = errorOf(await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI));
        expect(error.code).toBe('RATE_LIMITED');
        expect(error.retryable).toBe(true);
        expect(error.retryAfterSeconds).toBe(3600);
        expect(error.budget?.daily_remaining_usd).toBe(0);
        expect(error.budget?.resets_in_seconds).toBe(3600);
    });

    test('a 404 carries the budget it used up', async () => {
        const headers = { 'X-RateLimit-Cost-USD': '0.0001', 'X-RateLimit-Remaining-USD': '0.5' };
        const { fn } = makeFetch(() => textResponse('nope', { status: 404, headers }));
        const error = errorOf(await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI));
        expect(error.code).toBe('NOT_FOUND');
        expect(error.budget?.cost_usd).toBe(0.0001);
        expect(error.budget?.daily_remaining_usd).toBe(0.5);
    });

    test('an error without budget headers or without a response has budget null', async () => {
        const noHeaders = errorOf(
            await createOpenAlex({ fetchFn: makeFetch(() => textResponse('x', { status: 400 })).fn }).fetchDoi(DOI),
        );
        expect(noHeaders.budget).toBeNull();
        const offline = makeFetch(() => {
            throw new TypeError('fetch failed');
        });
        expect(
            errorOf(await createOpenAlex({ fetchFn: offline.fn, limiterOptions: SINGLE_ATTEMPT }).fetchDoi(DOI)).budget,
        ).toBeNull();
    });

    test('a 404 is permanent: the DOI does not exist in OpenAlex', async () => {
        const html = await loadFixtureText('error-404.html');
        const { fn } = makeFetch(() => textResponse(html, { status: 404 }));
        const error = errorOf(await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI));
        expect(error.code).toBe('NOT_FOUND');
        expect(error.retryable).toBe(false);
    });

    test('a 503 is retryable, a 400 is not', async () => {
        // a client per status: the 503 pauses the lane of its client
        const at = async (status: number) =>
            errorOf(
                await createOpenAlex({ limiterOptions: SINGLE_ATTEMPT }).fetchDoi(DOI, {
                    fetchFn: makeFetch(() => textResponse('x', { status })).fn,
                }),
            );
        expect((await at(503)).retryable).toBe(true);
        expect((await at(400)).retryable).toBe(false);
    });
});

describe('scalar requests through the queue', () => {
    test('a 429 whose Retry-After fits maxWaitMs is retried', async () => {
        const work = await loadWork('work-article');
        const { fn, calls } = makeFetch((_call: unknown, index: number) =>
            index === 0 ? textResponse('{}', { status: 429, headers: { 'Retry-After': '0' } }) : jsonResponse(work),
        );
        const result = await createOpenAlex({ fetchFn: fn }).fetchDoi(DOI);
        expect(result.ok).toBe(true);
        expect(calls).toHaveLength(2);
    });

    test('a 500 is retried up to maxRetries', async () => {
        const { fn, calls } = makeFetch(() => textResponse('x', { status: 500 }));
        const error = errorOf(
            await createOpenAlex({
                fetchFn: fn,
                limiterOptions: { maxRetries: 2, retryDelayMs: 1, maxRetryDelayMs: 1 },
            }).fetchDoi(DOI),
        );
        expect(error.code).toBe('HTTP');
        expect(error.status).toBe(500);
        expect(calls).toHaveLength(3);
    });

    test('a 503 is retried after a lane pause, even with maxRetries 0', async () => {
        const work = await loadWork('work-article');
        const { fn, calls } = makeFetch((_call: unknown, index: number) =>
            index === 0 ? textResponse('x', { status: 503 }) : jsonResponse(work),
        );
        const client = createOpenAlex({ fetchFn: fn, limiterOptions: { maxRetries: 0, retryDelayMs: 1 } });
        const results = await Promise.all([client.fetchDoi(DOI), client.fetchDoi(DOI)]);
        expect(results.every((result) => result.ok)).toBe(true);
        expect(calls).toHaveLength(3);
    });

    test('client calls share one queue: concurrency 1 runs them one after the other', async () => {
        const work = await loadWork('work-article');
        let active = 0;
        let peak = 0;
        const { fn, calls } = makeFetch(async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 10));
            active -= 1;
            return jsonResponse(work);
        });
        const client = createOpenAlex({ fetchFn: fn, limits: { concurrency: 1, rps: 10_000 } });
        const results = await Promise.all([client.fetchDoi(DOI), client.fetchDoi(DOI), client.fetchDoi(DOI)]);
        expect(results.every((result) => result.ok)).toBe(true);
        expect(calls).toHaveLength(3);
        expect(peak).toBe(1);
    });

    test('a spent budget pauses content downloads only; single lookups keep running', async () => {
        const work = await loadWork('work-article');
        const { fn, calls } = makeFetch((call: RecordedCall) =>
            call.url.includes('content.openalex.org')
                ? textResponse('{}', {
                      status: 429,
                      headers: { 'Retry-After': '3600', 'X-RateLimit-Remaining-USD': '0' },
                  })
                : jsonResponse(work),
        );
        const client = createOpenAlex({ fetchFn: fn, apiKey: 'key', limiterOptions: SINGLE_ATTEMPT });
        const spent = errorOf(await client.fetchContent('W9000000011'));
        expect(spent.code).toBe('RATE_LIMITED');
        expect(spent.status).toBe(429);

        // a paused free lane would refuse this lookup unsent, so ok means the free lane still runs
        expect((await client.fetchDoi(DOI)).ok).toBe(true);

        const paused = errorOf(await client.fetchContent('W9000000011'));
        expect(paused.code).toBe('RATE_LIMITED');
        expect(paused.status).toBeNull();
        expect(paused.retryAfterSeconds).toBeGreaterThan(3590);
        expect(paused.budget?.daily_remaining_usd).toBe(0);
        expect(calls.filter((call) => call.url.includes('content.openalex.org'))).toHaveLength(1);
    });

    test('invalid limits make createOpenAlex throw; limits per call are ignored', async () => {
        const cause = factoryCause({ limits: { rps: 0 } });
        expect(cause.code).toBe('INVALID_OPTIONS');
        expect(cause.message).toContain('limits.rps');
        const { fn } = await workFetch();
        const client = createOpenAlex({ fetchFn: fn });
        expect((await client.fetchDoi(DOI, asOptions({ limits: { rps: 0 } }))).ok).toBe(true);
    });
});
