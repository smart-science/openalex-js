// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';

import { createError, ERROR_MESSAGES, type OpenAlexError, type OpenAlexErrorCode } from '../../src/utils/errors.js';
import { ERROR_KEYS, expectUniformErrorShape } from '../helpers.js';

const ALL_CODES = Object.keys(ERROR_MESSAGES) as OpenAlexErrorCode[];

const SAMPLES: readonly (readonly [OpenAlexError, string])[] = [
    [createError('INVALID_DOI', { input: 'garbage' }), '"garbage" is not a valid DOI'],
    [
        createError('INVALID_ID', { input: '10.5555/x' }),
        '"10.5555/x" is not an OpenAlex work id (e.g. W2741809807) — resolve a DOI with fetchDoi and pass record.id',
    ],
    [createError('NO_CONTENT', { workId: 'W1', format: 'pdf', status: 404 }), 'OpenAlex has no PDF for work W1'],
    [createError('INVALID_RENAME', { keys: ['titel', 'jahr'] }), 'Unknown field name(s) in rename map: titel, jahr'],
    [
        createError('RENAME_COLLISION', { keys: ['abstract'] }),
        'Rename target(s) collide with existing field(s): abstract',
    ],
    [
        createError('INVALID_OPTIONS', { option: 'timeoutMs', reason: 'must be a finite number greater than 0' }),
        'Invalid option "timeoutMs": must be a finite number greater than 0',
    ],
    [createError('NOT_FOUND', { doi: '10.9999/nope', status: 404 }), 'OpenAlex has no record for DOI "10.9999/nope"'],
    [
        createError('RATE_LIMITED', { status: 429, retryAfterSeconds: 30 }),
        'Rate limited by OpenAlex (HTTP 429); retry after 30s',
    ],
    [createError('AUTH', { status: 401 }), 'Authentication failed (HTTP 401) — check your API key'],
    [createError('HTTP', { status: 503, body: 'upstream down' }), 'OpenAlex returned HTTP 503: upstream down'],
    [createError('NETWORK', { reason: 'ECONNRESET' }), 'Network request failed: ECONNRESET'],
    [createError('TIMEOUT', { timeoutMs: 10_000 }), 'Request timed out after 10000ms'],
    [createError('ABORTED', {}), 'Request aborted by the caller'],
    [createError('PARSE', { body: '<html>' }), 'Unexpected response body: <html>'],
];

describe('error registry', () => {
    test('holds exactly the fourteen codes, every one UPPERCASE', () => {
        expect([...ALL_CODES].sort()).toEqual([
            'ABORTED',
            'AUTH',
            'HTTP',
            'INVALID_DOI',
            'INVALID_ID',
            'INVALID_OPTIONS',
            'INVALID_RENAME',
            'NETWORK',
            'NOT_FOUND',
            'NO_CONTENT',
            'PARSE',
            'RATE_LIMITED',
            'RENAME_COLLISION',
            'TIMEOUT',
        ]);
        for (const code of ALL_CODES) {
            expect(/^[A-Z_]+$/.test(code), code).toBe(true);
        }
    });

    test('every code has a sample below', () => {
        expect(SAMPLES.map(([error]) => error.code).sort()).toEqual([...ALL_CODES].sort());
    });
});

describe('message interpolation', () => {
    for (const [error, message] of SAMPLES) {
        test(`${error.code} reproduces its verified line`, () => {
            expect(error.message).toBe(message);
        });
    }

    test('RATE_LIMITED omits the clause entirely without a hint, and keeps it at zero', () => {
        expect(createError('RATE_LIMITED', { status: 429, retryAfterSeconds: null }).message).toBe(
            'Rate limited by OpenAlex (HTTP 429)',
        );
        expect(createError('RATE_LIMITED', { status: 429, retryAfterSeconds: 0 }).message).toContain('retry after 0s');
    });

    test('INVALID_RENAME with a single name has no separator', () => {
        expect(createError('INVALID_RENAME', { keys: ['titel'] }).message).toBe(
            'Unknown field name(s) in rename map: titel',
        );
    });
});

describe('flat seven-key shape', () => {
    test('every code produces exactly the same seven keys', () => {
        for (const [error] of SAMPLES) {
            expectUniformErrorShape(error);
            expect(Object.keys(error).sort(), error.code).toEqual([...ERROR_KEYS]);
        }
    });

    test('there is no nested context object', () => {
        for (const [error] of SAMPLES) {
            expect((error as unknown as Record<string, unknown>).context, error.code).toBeUndefined();
        }
    });
});

describe('status and retryAfterSeconds lifting', () => {
    test('a status argument is lifted, including the 404 of a NOT_FOUND', () => {
        expect(createError('HTTP', { status: 503, body: 'x' }).status).toBe(503);
        expect(createError('AUTH', { status: 403 }).status).toBe(403);
        expect(createError('RATE_LIMITED', { status: 429, retryAfterSeconds: 30 }).status).toBe(429);
        expect(createError('NOT_FOUND', { doi: '10.1/x', status: 404 }).status).toBe(404);
    });

    test('retryAfterSeconds is null on every code but RATE_LIMITED', () => {
        for (const [error] of SAMPLES) {
            if (error.code !== 'RATE_LIMITED') {
                expect(error.retryAfterSeconds, error.code).toBeNull();
            }
        }
        expect(createError('RATE_LIMITED', { status: 429, retryAfterSeconds: null }).retryAfterSeconds).toBeNull();
        const local = createError('RATE_LIMITED', { limiter: 'wait exceeds maxWaitMs' });
        expect(local.message).toBe('Rate limited by the local limiter: wait exceeds maxWaitMs');
        expect(local.status).toBeNull();
        expect(local.retryable).toBe(true);
    });

    test('a code with no status argument reports null, and unrelated arguments are not lifted', () => {
        expect(createError('INVALID_DOI', { input: 'x' }).status).toBeNull();
        expect(createError('TIMEOUT', { timeoutMs: 10_000 }).status).toBeNull();
        const error = createError('PARSE', { body: 'x' }) as unknown as Record<string, unknown>;
        expect(error.body).toBeUndefined();
    });
});

describe('retryable — the one flag a caller needs to decide on a retry', () => {
    test('only transient failures are retryable', () => {
        const retryable = SAMPLES.filter(([error]) => error.retryable).map(([error]) => error.code);
        expect(retryable.sort()).toEqual(['HTTP', 'NETWORK', 'RATE_LIMITED', 'TIMEOUT']);
    });

    test('HTTP is retryable for 408, 425 and 5xx only', () => {
        const retryableAt = (status: number) => createError('HTTP', { status, body: '' }).retryable;
        expect([408, 425, 500, 502, 503, 504, 599].map(retryableAt)).toEqual(Array(7).fill(true));
        expect([400, 402, 404, 405, 409, 410, 422, 451].map(retryableAt)).toEqual(Array(8).fill(false));
    });

    test('a missing DOI, a missing file and a bad key are permanent', () => {
        expect(createError('NOT_FOUND', { doi: '10.1/x', status: 404 }).retryable).toBe(false);
        expect(createError('NO_CONTENT', { workId: 'W1', format: 'xml', status: 404 }).retryable).toBe(false);
        expect(createError('AUTH', { status: 401 }).retryable).toBe(false);
        expect(createError('ABORTED', {}).retryable).toBe(false);
    });
});

describe('cause property', () => {
    test('defaults to null and preserves a given value by identity', () => {
        const boom = new Error('boom');
        expect(createError('NETWORK', { reason: 'x' }).cause).toBeNull();
        expect(createError('NETWORK', { reason: 'x' }, boom).cause).toBe(boom);
        expect(createError('NETWORK', { reason: 'x' }, 'plain').cause).toBe('plain');
        expect(createError('NETWORK', { reason: 'x' }, undefined).cause).toBeNull();
    });
});

describe('plain data error object', () => {
    test('errors are plain, unfrozen objects — not Error instances', () => {
        const error = createError('AUTH', { status: 401 });
        expect(Object.isFrozen(error)).toBe(false);
        expect(error instanceof Error).toBe(false);
    });

    test('every error survives a JSON round-trip with all seven keys', () => {
        for (const [error] of SAMPLES) {
            const round = JSON.parse(JSON.stringify(error)) as Record<string, unknown>;
            expect(Object.keys(round).sort(), error.code).toEqual([...ERROR_KEYS]);
            expect(round.message).toBe(error.message);
        }
    });

    test('Error cause serializes to {} while preserving cause key', () => {
        const error = createError('NETWORK', { reason: 'x' }, new Error('boom'));
        const round = JSON.parse(JSON.stringify(error)) as Record<string, unknown>;
        expect(round.cause).toEqual({});
    });
});
