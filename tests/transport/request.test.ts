// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Budget } from '../../src/content/types.js';
import { requestJson, requestPdf, requestWork } from '../../src/transport/request.js';
import { API_BASE_URL, USER_AGENT } from '../../src/utils/constants.js';
import { createError } from '../../src/utils/errors.js';
import {
    abortableFetch,
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
    textResponse,
    typedOkOf,
} from '../helpers.js';

const DOI = '10.5555/alpha00001';
const EXPECTED_URL = 'https://api.openalex.org/works/doi:10.5555%2Falpha00001';
const WORK_ID = 'W9000000012';
const BUDGET_HEADERS = {
    'X-RateLimit-Cost-USD': '0.0001',
    'X-RateLimit-Remaining-USD': '0.5',
    'X-RateLimit-Limit-USD': '1',
    'X-RateLimit-Reset': '3600',
};
const BUDGET: Budget = {
    cost_usd: 0.0001,
    daily_remaining_usd: 0.5,
    daily_budget_usd: 1,
    prepaid_remaining_usd: null,
    resets_in_seconds: 3600,
};
const MANUAL_TIMEOUT_MS = 60_000;

let trap: FetchTrap;

beforeEach(() => {
    trap = installGlobalFetchTrap();
});

afterEach(() => {
    trap.assertUntouched();
    trap.restore();
});

describe('HTTP request construction', () => {
    test('GETs work endpoint without query parameters', async () => {
        const work = await loadWork('work-article');
        const { fn, calls } = makeFetch(() => jsonResponse(work));
        await requestWork(DOI, { fetchFn: fn });

        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe(EXPECTED_URL);
        expect(calls[0]?.url.startsWith(API_BASE_URL)).toBe(true);
        expect(calls[0]?.method).toBe('GET');

        const url = new URL(calls[0]?.url as string);
        expect(url.search).toBe('');
        expect(url.href).not.toContain('mailto');
        expect(url.href).not.toContain('select');
    });

    test('sends Accept and the package User-Agent', async () => {
        const { fn, calls } = makeFetch(() => jsonResponse({}));
        await requestWork(DOI, { fetchFn: fn });
        expect(calls[0]?.headers.get('accept')).toBe('application/json');
        expect(calls[0]?.headers.get('user-agent')).toBe(USER_AGENT);
    });

    test('omits Authorization header without key, sends Bearer with key', async () => {
        const without = makeFetch(() => jsonResponse({}));
        await requestWork(DOI, { fetchFn: without.fn });
        expect(without.calls[0]?.headers.get('authorization')).toBeNull();

        const withKey = makeFetch(() => jsonResponse({}));
        await requestWork(DOI, { fetchFn: withKey.fn, apiKey: 'SECRET' });
        expect(withKey.calls[0]?.headers.get('authorization')).toBe('Bearer SECRET');
        // Never in the URL.
        expect(withKey.calls[0]?.url).not.toContain('SECRET');
    });

    test('percent-encodes a suffix containing a slash, parentheses and a question mark', async () => {
        const { fn, calls } = makeFetch(() => jsonResponse({}));
        await requestWork('10.5555/s0140-6736(03)12113-7?x', { fetchFn: fn });
        expect(calls[0]?.url).toBe('https://api.openalex.org/works/doi:10.5555%2Fs0140-6736(03)12113-7%3Fx');
    });

    test('AbortSignal is passed and not aborted upfront', async () => {
        const { fn, calls } = makeFetch(() => jsonResponse({}));
        await requestWork(DOI, { fetchFn: fn });
        expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
        expect(calls[0]?.signal?.aborted).toBe(false);
    });
});

describe('a 2xx response', () => {
    test('returns the parsed work untouched, in an envelope of only ok and data, holding body and budget', async () => {
        const work = await loadWork('work-article');
        const { fn } = makeFetch(() => jsonResponse(work));
        const result = await requestWork(DOI, { fetchFn: fn });

        const payload = typedOkOf(result);
        expect(Object.keys(result)).toEqual(['ok', 'data']);
        expect(Object.keys(payload.data)).toEqual(['body', 'budget']);
        expect(payload.data.body).toEqual(work);
    });

    test('any 2xx status is a success', async () => {
        for (const status of [200, 201, 204, 299]) {
            const { fn } = makeFetch(() => jsonResponse({ id: 'W1' }, { status }));
            expect<unknown>(typedOkOf(await requestWork(DOI, { fetchFn: fn })).data.body, String(status)).toEqual({
                id: 'W1',
            });
        }
    });
});

describe('non-2xx status handling', () => {
    test('HTML 404 body maps to NOT_FOUND', async () => {
        const body = await loadFixtureText('error-404.html');
        const { fn } = makeFetch(() => textResponse(body, { status: 404 }));
        const error = errorOf(await requestWork('10.9999/nope', { fetchFn: fn }));

        expect(error.code).toBe('NOT_FOUND');
        expect(error.message).toBe('OpenAlex has no record for DOI "10.9999/nope"');
        // The HTML never leaks into the message, but the status is reported honestly.
        expect(error.message).not.toContain('<');
        expect(error.status).toBe(404);
        expect(error.retryAfterSeconds).toBeNull();
    });

    test('a JSON or empty 404 body maps to NOT_FOUND too', async () => {
        for (const responder of [
            () => jsonResponse({ error: 'not found' }, { status: 404 }),
            () => textResponse('', { status: 404 }),
        ]) {
            const { fn } = makeFetch(responder);
            expect(errorOf(await requestWork(DOI, { fetchFn: fn })).code).toBe('NOT_FOUND');
        }
    });

    test('401 and 403 map to AUTH with the status lifted', async () => {
        for (const status of [401, 403]) {
            const { fn } = makeFetch(() => jsonResponse({ error: 'Invalid or missing API key' }, { status }));
            const error = errorOf(await requestWork(DOI, { fetchFn: fn, apiKey: 'bogus' }));
            expect(error.code, String(status)).toBe('AUTH');
            expect(error.status, String(status)).toBe(status);
            expect(error.retryAfterSeconds, String(status)).toBeNull();
        }
    });

    test('429 is RATE_LIMITED carrying Retry-After after one call', async () => {
        const { fn, calls } = makeFetch(() =>
            jsonResponse(
                { error: 'rate limited' },
                {
                    status: 429,
                    headers: { 'Retry-After': '30' },
                },
            ),
        );
        const error = errorOf(await requestWork(DOI, { fetchFn: fn }));

        expect(error.code).toBe('RATE_LIMITED');
        expect(error.status).toBe(429);
        expect(error.retryAfterSeconds).toBe(30);
        expect(error.message).toBe('Rate limited by OpenAlex (HTTP 429); retry after 30s');
        // No retry at this layer.
        expect(calls).toHaveLength(1);
    });

    test('429 without a usable Retry-After yields null rather than NaN', async () => {
        for (const value of [undefined, '', '   ', 'soon', '-5']) {
            const headers = value === undefined ? {} : { 'Retry-After': value };
            const { fn } = makeFetch(() => jsonResponse({}, { status: 429, headers }));
            expect(errorOf(await requestWork(DOI, { fetchFn: fn })).retryAfterSeconds, String(value)).toBeNull();
        }
    });

    test('non-2xx status maps to HTTP carrying truncated body', async () => {
        for (const status of [302, 400, 402, 500, 503]) {
            const { fn } = makeFetch(() => textResponse('boom', { status }));
            const error = errorOf(await requestWork(DOI, { fetchFn: fn }));
            expect(error.code, String(status)).toBe('HTTP');
            expect(error.status, String(status)).toBe(status);
            expect(error.message, String(status)).toBe(`OpenAlex returned HTTP ${status}: boom`);
        }
    });

    test('the real 400 fixture reports its message field', async () => {
        const body = await loadFixtureText('error-400.json');
        const { fn } = makeFetch(() => textResponse(body, { status: 400 }));
        const error = errorOf(await requestWork(DOI, { fetchFn: fn }));
        expect(error.code).toBe('HTTP');
        expect(error.status).toBe(400);
        expect(error.message).toContain('abstract is not a valid select field');
    });

    test('unreadable body yields empty string without throwing', async () => {
        const { fn } = makeFetch(() => ({
            status: 500,
            headers: { get: () => null },
            text: () => Promise.reject(new Error('stream broken')),
        }));
        const error = errorOf(await requestWork(DOI, { fetchFn: fn }));
        expect(error.code).toBe('HTTP');
        expect(error.status).toBe(500);
    });
});

describe('2xx response with invalid body yields PARSE', () => {
    const bodies: readonly [string, string][] = [
        ['invalid JSON', '{not json at all'],
        ['a JSON null body', 'null'],
        ['a JSON array body', '[{"id":"W1"}]'],
        ['a JSON string body', '"just a string"'],
        ['a JSON number body', '42'],
        ['a JSON boolean body', 'true'],
        ['an empty body', ''],
        ['an HTML body served with a 200', '<!doctype html><h1>nope</h1>'],
    ];

    for (const [label, body] of bodies) {
        test(`${label} is PARSE, with the body in the message`, async () => {
            const { fn } = makeFetch(() => textResponse(body));
            const error = errorOf(await requestWork(DOI, { fetchFn: fn }));
            expect(error.code).toBe('PARSE');
            expect(error.status).toBeNull();
        });
    }

    test('a text() resolving to a non-string is PARSE, not retryable NETWORK', async () => {
        for (const value of [42, null, {}]) {
            const { fn } = makeFetch(() => ({ status: 200, headers: new Headers(), text: async () => value }));
            const error = errorOf(await requestWork(DOI, { fetchFn: fn }));
            expect(error.code).toBe('PARSE');
            expect(error.retryable).toBe(false);
        }
    });

    test('object body with unknown fields succeeds at request layer', async () => {
        const { fn } = makeFetch(() => jsonResponse({ unexpected: true }));
        expect<unknown>(typedOkOf(await requestWork(DOI, { fetchFn: fn })).data.body).toEqual({ unexpected: true });
    });
});

describe('transport failures yield NETWORK', () => {
    test('a fetchFn that throws synchronously, rejects, or resolves to garbage', async () => {
        const boom = new Error('ECONNRESET');
        const throwing = makeFetch(() => {
            throw boom;
        });
        const thrown = errorOf(await requestWork(DOI, { fetchFn: throwing.fn }));
        expect(thrown.code).toBe('NETWORK');
        expect(thrown.message).toBe('Network request failed: ECONNRESET');
        expect(thrown.cause).toBe(boom);

        const rejecting = makeFetch(() => Promise.reject('plain string'));
        expect(errorOf(await requestWork(DOI, { fetchFn: rejecting.fn })).code).toBe('NETWORK');

        for (const garbage of [null, 42, 'a string', { status: 'not a number' }, { text: () => '' }]) {
            const { fn } = makeFetch(() => garbage);
            const error = errorOf(await requestWork(DOI, { fetchFn: fn }));
            expect(error.code, String(garbage)).toBe('NETWORK');
            expect(error.message, String(garbage)).toBe('Network request failed: fetch did not return a Response');
        }
    });

    test('missing runtime fetch yields NETWORK error without throwing', async () => {
        trap.set(undefined);
        expect(errorOf(await requestWork(DOI, {})).message).toBe(
            'Network request failed: fetch is not available in this runtime',
        );
        trap.set(42);
        expect(errorOf(await requestWork(DOI, {})).code).toBe('NETWORK');
    });

    test('request layer performs no automatic retries', async () => {
        const { fn, calls } = makeFetch(() => {
            throw new Error('down');
        });
        await requestWork(DOI, { fetchFn: fn });
        expect(calls).toHaveLength(1);
    });
});

describe('request timeouts', () => {
    test('a slow request is aborted and reported as TIMEOUT, not NETWORK', async () => {
        const { fn, calls } = abortableFetch();
        const error = errorOf(await requestWork(DOI, { fetchFn: fn, timeoutMs: 10 }));
        expect(error.code).toBe('TIMEOUT');
        expect(error.message).toBe('Request timed out after 10ms');
        expect(calls).toHaveLength(1);
        expect(calls[0]?.signal?.aborted).toBe(true);
    });

    test('the timer is cleared on every path, so a late abort never fires', async () => {
        const { fn, calls } = makeFetch(() => jsonResponse({ id: 'W1' }));
        await requestWork(DOI, { fetchFn: fn, timeoutMs: 5 });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(calls[0]?.signal?.aborted).toBe(false);
    });

    test('an external abort that is not our timer is NETWORK', async () => {
        const { fn } = makeFetch(() => Promise.reject(new DOMException('The operation was aborted.', 'AbortError')));
        expect(errorOf(await requestWork(DOI, { fetchFn: fn, timeoutMs: 10_000 })).code).toBe('NETWORK');
    });
});

describe('an error body interrupted while streaming', () => {
    const stalledBody = (status: number) =>
        makeFetch((call) => ({
            status,
            headers: new Headers(),
            text: () =>
                new Promise<string>((_resolve, reject) => {
                    call.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                }),
        }));

    test('a timeout is TIMEOUT, not HTTP', async () => {
        const { fn } = stalledBody(500);
        expect(errorOf(await requestWork(DOI, { fetchFn: fn, timeoutMs: 10 })).code).toBe('TIMEOUT');
    });

    test('a caller abort is ABORTED, not RATE_LIMITED', async () => {
        const controller = new AbortController();
        const { fn } = stalledBody(429);
        const pending = requestWork(DOI, { fetchFn: fn, signal: controller.signal, timeoutMs: 10_000 });
        setTimeout(() => controller.abort('stop'), 5);
        const error = errorOf(await pending);
        expect(error.code).toBe('ABORTED');
        expect(error.cause).toBe('stop');
    });
});

describe('a 2xx body interrupted while streaming or resolving after abort', () => {
    test('a timeout while reading a 200 body is TIMEOUT, even if text() resolves', async () => {
        const { fn } = makeFetch((call) => ({
            status: 200,
            headers: new Headers(),
            text: () =>
                new Promise<string>((resolve) => {
                    call.signal?.addEventListener('abort', () => {
                        setTimeout(() => resolve('{"id":"W1"}'), 5);
                    });
                }),
        }));
        const error = errorOf(await requestWork(DOI, { fetchFn: fn, timeoutMs: 10 }));
        expect(error.code).toBe('TIMEOUT');
    });

    test('a caller abort while reading a 200 body is ABORTED, not PARSE', async () => {
        const controller = new AbortController();
        const { fn } = makeFetch((call) => ({
            status: 200,
            headers: new Headers(),
            text: () =>
                new Promise<string>((resolve) => {
                    call.signal?.addEventListener('abort', () => {
                        setTimeout(() => resolve('{"id":'), 5);
                    });
                }),
        }));
        const pending = requestWork(DOI, { fetchFn: fn, signal: controller.signal, timeoutMs: 10_000 });
        setTimeout(() => controller.abort('user stopped'), 5);
        const error = errorOf(await pending);
        expect(error.code).toBe('ABORTED');
        expect(error.cause).toBe('user stopped');
    });

    test('timeout where fetchFn resolves with non-response yields TIMEOUT', async () => {
        const { fn } = makeFetch(
            (call) =>
                new Promise((resolve) => {
                    call.signal?.addEventListener('abort', () => {
                        setTimeout(() => resolve(null), 5);
                    });
                }),
        );
        const error = errorOf(await requestWork(DOI, { fetchFn: fn, timeoutMs: 10 }));
        expect(error.code).toBe('TIMEOUT');
    });
});

describe('caller cancellation', () => {
    test('a signal aborted before the call never opens a socket', async () => {
        const { fn, calls } = makeFetch(() => jsonResponse({}));
        const error = errorOf(await requestWork(DOI, { fetchFn: fn, signal: AbortSignal.abort('too late') }));
        expect(error.code).toBe('ABORTED');
        expect(error.message).toBe('Request aborted by the caller');
        expect(error.status).toBeNull();
        expect(error.cause).toBe('too late');
        expect(calls).toHaveLength(0);
    });

    test('aborting mid-flight aborts the fetch and reports ABORTED, not TIMEOUT', async () => {
        const controller = new AbortController();
        const { fn, calls } = abortableFetch(500);
        const pending = requestWork(DOI, { fetchFn: fn, signal: controller.signal, timeoutMs: 10_000 });
        controller.abort();

        const error = errorOf(await pending);
        expect(error.code).toBe('ABORTED');
        expect(calls[0]?.signal?.aborted).toBe(true);
    });

    test('a fetch slow to reject still reports ABORTED once the caller aborted first', async () => {
        const controller = new AbortController();
        const { fn } = makeFetch(
            (call) =>
                new Promise((_resolve, reject) => {
                    call.signal?.addEventListener('abort', () => setTimeout(() => reject(new Error('late')), 50));
                }),
        );
        const pending = requestWork(DOI, { fetchFn: fn, signal: controller.signal, timeoutMs: 30 });
        setTimeout(() => controller.abort('stop'), 10);
        const error = errorOf(await pending);
        expect(error.code).toBe('ABORTED');
        expect(error.cause).toBe('stop');
    });

    test('a signal that never aborts changes nothing', async () => {
        const controller = new AbortController();
        const { fn } = makeFetch(() => jsonResponse({ id: 'W1' }));
        expect<unknown>(
            typedOkOf(await requestWork(DOI, { fetchFn: fn, signal: controller.signal })).data.body,
        ).toEqual({ id: 'W1' });
    });
});

describe('an error after the response arrived carries its budget headers', () => {
    test('a 2xx whose text() rejects is NETWORK with the budget', async () => {
        const { fn } = makeFetch(() => ({
            status: 200,
            headers: new Headers(BUDGET_HEADERS),
            text: () => Promise.reject(new Error('stream broken')),
        }));
        const error = errorOf(await requestWork(DOI, { fetchFn: fn }));
        expect(error.code).toBe('NETWORK');
        expect(error.message).toBe('Network request failed: stream broken');
        expect(error.budget).toEqual(BUDGET);
    });

    test('a 2xx PDF whose arrayBuffer() rejects is NETWORK with the budget', async () => {
        const { fn } = makeFetch(() => ({
            status: 200,
            headers: new Headers(BUDGET_HEADERS),
            text: async () => '',
            arrayBuffer: () => Promise.reject(new Error('stream broken')),
        }));
        const error = errorOf(await requestPdf(WORK_ID, { fetchFn: fn }));
        expect(error.code).toBe('NETWORK');
        expect(error.budget).toEqual(BUDGET);
    });

    test('a timeout while a 2xx body streams and the read rejects is TIMEOUT with the budget', async () => {
        const error = await timedOutRead(200, 'reject');
        expect(error.code).toBe('TIMEOUT');
        expect(error.budget).toEqual(BUDGET);
    });

    test('a caller abort while a 2xx body streams is ABORTED with the budget', async () => {
        const error = await abortedRead(200, 'reject');
        expect(error.code).toBe('ABORTED');
        expect(error.cause).toBe('stop');
        expect(error.budget).toEqual(BUDGET);
    });

    test('a 2xx body that resolves after the timer fired is TIMEOUT with the budget', async () => {
        const error = await timedOutRead(200, 'resolve');
        expect(error.code).toBe('TIMEOUT');
        expect(error.budget).toEqual(BUDGET);
    });

    test('a 2xx body that resolves after a caller abort is ABORTED with the budget', async () => {
        const error = await abortedRead(200, 'resolve');
        expect(error.code).toBe('ABORTED');
        expect(error.budget).toEqual(BUDGET);
    });

    test('a non-2xx body interrupted by the timer is TIMEOUT with the budget', async () => {
        const error = await timedOutRead(500, 'reject');
        expect(error.code).toBe('TIMEOUT');
        expect(error.budget).toEqual(BUDGET);
    });

    test('a non-2xx body interrupted by a caller abort is ABORTED with the budget', async () => {
        const error = await abortedRead(429, 'reject');
        expect(error.code).toBe('ABORTED');
        expect(error.budget).toEqual(BUDGET);
    });

    test('a response that fetch resolves after the timer fired is TIMEOUT with the budget', async () => {
        const recorded = recordTimers();
        try {
            const { fn } = makeFetch(
                (call) =>
                    new Promise((resolve) => {
                        call.signal?.addEventListener('abort', () =>
                            resolve(textResponse('{}', { headers: BUDGET_HEADERS })),
                        );
                    }),
            );
            const pending = requestWork(DOI, { fetchFn: fn, timeoutMs: MANUAL_TIMEOUT_MS });
            fireTimeout(recorded.timers);
            const error = errorOf(await pending);
            expect(error.code).toBe('TIMEOUT');
            expect(error.budget).toEqual(BUDGET);
        } finally {
            recorded.restore();
        }
    });

    test('an error before any response arrived keeps budget null', async () => {
        const early = makeFetch(() => textResponse('{}', { headers: BUDGET_HEADERS }));
        const aborted = errorOf(await requestWork(DOI, { fetchFn: early.fn, signal: AbortSignal.abort('stop') }));
        expect(aborted.code).toBe('ABORTED');
        expect(aborted.budget).toBeNull();

        const offline = makeFetch(() => Promise.reject(new TypeError('fetch failed')));
        const network = errorOf(await requestWork(DOI, { fetchFn: offline.fn }));
        expect(network.code).toBe('NETWORK');
        expect(network.budget).toBeNull();

        const timeout = errorOf(await requestWork(DOI, { fetchFn: abortableFetch().fn, timeoutMs: 1 }));
        expect(timeout.code).toBe('TIMEOUT');
        expect(timeout.budget).toBeNull();

        const controller = new AbortController();
        const pending = requestWork(DOI, { fetchFn: abortableFetch().fn, signal: controller.signal });
        controller.abort('stop');
        const midFlight = errorOf(await pending);
        expect(midFlight.code).toBe('ABORTED');
        expect(midFlight.budget).toBeNull();
    });

    test('a response whose headers.get throws resolves to NETWORK or TIMEOUT with budget null', async () => {
        const throwingHeaders = (status: number) => ({
            status,
            headers: {
                get(): string | null {
                    throw new Error('x');
                },
            },
            text: async () => '{}',
        });

        for (const status of [200, 500]) {
            const { fn } = makeFetch(() => throwingHeaders(status));
            const error = errorOf(await requestWork(DOI, { fetchFn: fn }));
            expect(error.code, String(status)).toBe('NETWORK');
            expect(error.budget, String(status)).toBeNull();
        }

        const recorded = recordTimers();
        try {
            const { fn } = makeFetch(
                (call) =>
                    new Promise((resolve) => {
                        call.signal?.addEventListener('abort', () => resolve(throwingHeaders(200)));
                    }),
            );
            const pending = requestWork(DOI, { fetchFn: fn, timeoutMs: MANUAL_TIMEOUT_MS });
            fireTimeout(recorded.timers);
            const error = errorOf(await pending);
            expect(error.code).toBe('TIMEOUT');
            expect(error.budget).toBeNull();
        } finally {
            recorded.restore();
        }
    });
});

describe('requestJson reusable transport', () => {
    test('builds https://api.openalex.org{path}, returns the payload, and uses the caller-supplied 404 error', async () => {
        const { fn, calls } = makeFetch(() => jsonResponse({ results: [] }));
        const ok = await requestJson<{ results: unknown[] }, 'NOT_FOUND'>(
            '/works?filter=x',
            { fetchFn: fn },
            notFound(),
        );
        expect(calls[0]?.url).toBe('https://api.openalex.org/works?filter=x');
        expect(typedOkOf(ok).data.body).toEqual({ results: [] });

        const missing = makeFetch(() => textResponse('nope', { status: 404 }));
        const error = errorOf(await requestJson('/works/W1', { fetchFn: missing.fn }, notFound()));
        expect(error.code).toBe('NOT_FOUND');
        expect(error.message).toBe('OpenAlex has no record for DOI "10.1/x"');
    });

    test('makes exactly one network call per invocation', async () => {
        const responders: readonly (() => unknown)[] = [
            () => jsonResponse({ id: 'W1' }),
            () => textResponse('', { status: 404 }),
            () => textResponse('', { status: 429 }),
            () => textResponse('', { status: 500 }),
            () => textResponse('not json'),
            () => {
                throw new Error('boom');
            },
        ];
        for (const responder of responders) {
            const { fn, calls } = makeFetch(responder);
            await requestWork(DOI, { fetchFn: fn });
            expect(calls).toHaveLength(1);
        }
    });

    test('requestWork survives an empty options object and any hostile fetchFn result', async () => {
        trap.set(() => Promise.resolve(jsonResponse({ id: 'W1' })));
        expect<unknown>(typedOkOf(await requestWork(DOI, {})).data.body).toEqual({ id: 'W1' });

        for (const value of [undefined, null, Number.NaN, Symbol('x'), 10n, new Map(), Object.create(null)]) {
            const { fn } = makeFetch(() => value);
            const result = await requestWork(DOI, { fetchFn: fn });
            expect(result.ok, typeof value).toBe(false);
        }
    });
});

function notFound() {
    return createError('NOT_FOUND', { doi: '10.1/x', status: 404 });
}

function stalledRead(status: number, onAbort: 'reject' | 'resolve') {
    let entered: () => void = () => {};
    const reading = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const read = (call: RecordedCall) => () => {
        entered();
        return new Promise<string>((resolve, reject) => {
            call.signal?.addEventListener('abort', () =>
                onAbort === 'reject' ? reject(new Error('aborted')) : resolve('{"id":"W1"}'),
            );
        });
    };
    const { fn } = makeFetch((call) => ({ status, headers: new Headers(BUDGET_HEADERS), text: read(call) }));
    return { fn, reading };
}

async function timedOutRead(status: number, onAbort: 'reject' | 'resolve') {
    const recorded = recordTimers();
    try {
        const { fn, reading } = stalledRead(status, onAbort);
        const pending = requestWork(DOI, { fetchFn: fn, timeoutMs: MANUAL_TIMEOUT_MS });
        await reading;
        fireTimeout(recorded.timers);
        return errorOf(await pending);
    } finally {
        recorded.restore();
    }
}

async function abortedRead(status: number, onAbort: 'reject' | 'resolve') {
    const controller = new AbortController();
    const { fn, reading } = stalledRead(status, onAbort);
    const pending = requestWork(DOI, { fetchFn: fn, signal: controller.signal, timeoutMs: MANUAL_TIMEOUT_MS });
    await reading;
    controller.abort('stop');
    return errorOf(await pending);
}

function fireTimeout(timers: readonly RecordedTimer[]): void {
    const timer = timers.find((recorded) => recorded.ms === MANUAL_TIMEOUT_MS);
    if (timer === undefined) {
        throw new Error('the request timer was not recorded');
    }
    timer.fire();
}
