// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import {
    extractErrorBody,
    headerValue,
    isResponseLike,
    isSuccessStatus,
    parseBudget,
    parseRetryAfter,
    type ResponseLike,
    readBody,
    retryDelay,
    summarizeBody,
    toStatusError,
} from '../../src/transport/response.js';
import { MAX_ERROR_BODY_LENGTH } from '../../src/utils/constants.js';
import { createError } from '../../src/utils/errors.js';
import { expectUniformErrorShape, loadFixtureText } from '../helpers.js';

const NOT_FOUND = createError('NOT_FOUND', { doi: '10.1/x', status: 404 });

describe('isResponseLike / isSuccessStatus', () => {
    test('a real Response and a minimal stub qualify; anything else does not', () => {
        expect(isResponseLike(new Response('x'))).toBe(true);
        expect(isResponseLike({ status: 200, text: () => Promise.resolve('') })).toBe(true);
        for (const value of [null, undefined, 42, 'x', {}, { status: 200 }, { text: () => '' }, { status: '200' }]) {
            expect(isResponseLike(value), String(value)).toBe(false);
        }
    });

    test('success is 2xx only — a 3xx that reaches us unfollowed is an error', () => {
        for (const status of [200, 201, 204, 299]) {
            expect(isSuccessStatus(status), String(status)).toBe(true);
        }
        for (const status of [100, 199, 300, 302, 400, 404, 500]) {
            expect(isSuccessStatus(status), String(status)).toBe(false);
        }
    });
});

describe('summarizeBody', () => {
    test('collapses whitespace runs and trims', () => {
        expect(summarizeBody('  line one\n\n   line   two\t ')).toBe('line one line two');
        expect(summarizeBody('')).toBe('');
    });

    test('a body of exactly the limit is untouched; one character past it is cut and marked', () => {
        const exact = 'y'.repeat(MAX_ERROR_BODY_LENGTH);
        expect(summarizeBody(exact)).toBe(exact);
        expect(summarizeBody(exact)).not.toContain('…');

        const over = summarizeBody('x'.repeat(MAX_ERROR_BODY_LENGTH + 1));
        expect(over).toHaveLength(MAX_ERROR_BODY_LENGTH + 1);
        expect(over.endsWith('…')).toBe(true);
    });
});

describe('extractErrorBody', () => {
    test('prefers message, falls back to error, then to the compact JSON', () => {
        expect(extractErrorBody('{"message":"m","error":"e"}')).toBe('m');
        expect(extractErrorBody('{"error":"e"}')).toBe('e');
        expect(extractErrorBody('{"message":"   ","error":"e"}')).toBe('e');
        expect(extractErrorBody('{"message":42,"error":"e"}')).toBe('e');
        expect(extractErrorBody('{"foo":1,"bar":[2]}')).toBe('{"foo":1,"bar":[2]}');
    });

    test('keeps unparseable bodies as text', async () => {
        const html = await loadFixtureText('error-404.html');
        const extracted = extractErrorBody(html);
        expect(extracted.startsWith('<')).toBe(true);
        expect(extracted.length).toBeLessThanOrEqual(MAX_ERROR_BODY_LENGTH + 1);
    });

    test('parses error message before truncation', async () => {
        const body = await loadFixtureText('error-400.json');
        const message = (JSON.parse(body) as { message: string }).message.replace(/\s+/g, ' ').trim();
        expect(message.length).toBeGreaterThan(MAX_ERROR_BODY_LENGTH);
        expect(extractErrorBody(body)).toBe(`${message.slice(0, MAX_ERROR_BODY_LENGTH)}…`);
    });

    test('never throws, whatever the body', () => {
        for (const body of ['', 'null', '[1,2]', '{', '<html>', '"text"']) {
            expect(() => extractErrorBody(body), body).not.toThrow();
        }
        expect(extractErrorBody('[1,2]')).toBe('[1,2]');
        expect(extractErrorBody('null')).toBe('null');
    });
});

describe('parseRetryAfter RFC 9110 forms', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');

    test('delay-seconds', () => {
        expect(parseRetryAfter('30')).toBe(30);
        expect(parseRetryAfter('0')).toBe(0);
        expect(parseRetryAfter('  30  ')).toBe(30);
    });

    test('an HTTP-date becomes whole seconds from now, rounded up, never negative', () => {
        expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30);
        expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:00 GMT', now + 500)).toBe(0);
        expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', now)).toBe(0);
        // A fractional gap rounds up, so a caller never retries too early.
        expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:02 GMT', now + 500)).toBe(2);
    });

    test('missing, blank, malformed, negative and fractional values are null', () => {
        for (const value of [undefined, null, '', '   ', 'soon', '-5', '1.5', 'NaN', '30s']) {
            expect(parseRetryAfter(value, now), String(value)).toBeNull();
        }
    });

    test('large delays pass through as numerical seconds', () => {
        expect(parseRetryAfter('86400')).toBe(86_400);
    });
});

describe('headerValue and readBody guards', () => {
    test('a stub without headers is not an error, and a real Headers lookup is case-insensitive', () => {
        expect(headerValue({ status: 429, text: () => Promise.resolve('') }, 'Retry-After')).toBeNull();
        expect(headerValue(new Response('', { headers: { 'Retry-After': '7' } }) as ResponseLike, 'retry-after')).toBe(
            '7',
        );
    });

    test('a body that rejects or returns a non-string yields an empty string, not an exception', async () => {
        expect(await readBody({ status: 500, text: () => Promise.reject(new Error('broken')) })).toBe('');
        expect(await readBody({ status: 500, text: () => Promise.resolve(42 as unknown as string) })).toBe('');
        expect(await readBody(new Response('body text'))).toBe('body text');
    });
});

describe('toStatusError status mapping', () => {
    test('404 returns the caller-supplied NOT_FOUND, by reference', () => {
        expect(toStatusError(404, 'ignored', null, NOT_FOUND)).toBe(NOT_FOUND);
    });

    test('429 becomes RATE_LIMITED carrying the retry delay', () => {
        expect(toStatusError(429, '', 30, NOT_FOUND).retryAfterSeconds).toBe(30);
        expect(toStatusError(429, '', null, NOT_FOUND).retryAfterSeconds).toBeNull();
        expect(toStatusError(429, '', null, NOT_FOUND).status).toBe(429);
    });

    test('401 and 403 become AUTH; every other non-2xx becomes HTTP carrying the body', () => {
        expect(toStatusError(401, '', null, NOT_FOUND).code).toBe('AUTH');
        expect(toStatusError(403, '', null, NOT_FOUND).code).toBe('AUTH');

        const http = toStatusError(503, 'upstream down', null, NOT_FOUND);
        expect(http.code).toBe('HTTP');
        expect(http.status).toBe(503);
        expect(http.message).toContain('upstream down');
    });

    test('every produced error keeps the uniform six-key shape, and only 429 carries a retry hint', () => {
        for (const status of [400, 401, 403, 404, 429, 500]) {
            const error = toStatusError(status, 'body', 30, NOT_FOUND);
            expectUniformErrorShape(error);
            if (status !== 429) {
                expect(error.retryAfterSeconds, String(status)).toBeNull();
            }
        }
    });
});

describe('retryDelay — when a 429 may be retried', () => {
    const with429 = (headers: Record<string, string>): ResponseLike => new Response('', { status: 429, headers });

    test('Retry-After wins over the budget headers', () => {
        expect(
            retryDelay(with429({ 'Retry-After': '3', 'X-RateLimit-Remaining-USD': '0', 'X-RateLimit-Reset': '900' })),
        ).toBe(3);
    });

    test('a spent daily budget waits for the reset', () => {
        expect(retryDelay(with429({ 'X-RateLimit-Remaining-USD': '0', 'X-RateLimit-Reset': '900' }))).toBe(900);
        expect(retryDelay(with429({ 'X-RateLimit-Remaining-USD': '-0.001', 'X-RateLimit-Reset': '900' }))).toBe(900);
        expect(retryDelay(with429({ 'X-RateLimit-Remaining-USD': '-1e-05', 'X-RateLimit-Reset': '900' }))).toBe(900);
    });

    test('a remaining prepaid balance means the reset is not the delay', () => {
        const headers = { 'X-RateLimit-Remaining-USD': '0', 'X-RateLimit-Reset': '900' };
        expect(retryDelay(with429({ ...headers, 'X-RateLimit-Prepaid-Remaining-USD': '4.5' }))).toBeNull();
        expect(retryDelay(with429({ ...headers, 'X-RateLimit-Prepaid-Remaining-USD': '0' }))).toBe(900);
    });

    test('a negative reset is clamped to zero', () => {
        expect(retryDelay(with429({ 'X-RateLimit-Remaining-USD': '0', 'X-RateLimit-Reset': '-10' }))).toBe(0);
    });

    test('a per-second 429 with budget left has no known delay', () => {
        expect(retryDelay(with429({ 'X-RateLimit-Remaining-USD': '0.5', 'X-RateLimit-Reset': '900' }))).toBeNull();
        expect(retryDelay(with429({}))).toBeNull();
    });
});

describe('parseBudget', () => {
    function withHeaders(headers: Record<string, string>): ResponseLike {
        return new Response('', { headers });
    }

    test('reads the five X-RateLimit budget headers as numbers', () => {
        const budget = parseBudget(
            withHeaders({
                'X-RateLimit-Cost-USD': '0.01',
                'X-RateLimit-Remaining-USD': '0.99',
                'X-RateLimit-Limit-USD': '1',
                'X-RateLimit-Reset': '35563',
                'X-RateLimit-Prepaid-Remaining-USD': '4.5',
            }),
        );
        expect(budget).toEqual({
            cost_usd: 0.01,
            daily_remaining_usd: 0.99,
            daily_budget_usd: 1,
            prepaid_remaining_usd: 4.5,
            resets_in_seconds: 35563,
        });
    });

    test('a malformed header is null, the others survive', () => {
        const budget = parseBudget(
            withHeaders({ 'X-RateLimit-Cost-USD': '', 'X-RateLimit-Remaining-USD': '0x1', 'X-RateLimit-Reset': '12' }),
        );
        expect(budget).toEqual({
            cost_usd: null,
            daily_remaining_usd: null,
            daily_budget_usd: null,
            prepaid_remaining_usd: null,
            resets_in_seconds: 12,
        });
    });

    test('scientific notation is read, an overflowing value is null', () => {
        const budget = parseBudget(
            withHeaders({ 'X-RateLimit-Cost-USD': '1e-05', 'X-RateLimit-Reset': '9'.repeat(400) }),
        );
        expect(budget?.cost_usd).toBe(0.00001);
        expect(budget?.resets_in_seconds).toBeNull();
    });

    test('no budget header at all, or no headers object, is null', () => {
        expect(parseBudget(withHeaders({}))).toBeNull();
        expect(parseBudget({ status: 200, text: async () => '' })).toBeNull();
    });
});
