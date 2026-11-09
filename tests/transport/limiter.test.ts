// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import { createRPD } from 'smart-limit';

import { checkLimiterOptions, checkLimits, createRequestQueues, schedule } from '../../src/transport/limiter.js';
import { createError, type OpenAlexError } from '../../src/utils/errors.js';
import type { Result } from '../../src/utils/result.js';

const FAST = { maxRetries: 2, retryDelayMs: 0 } as const;
const BUDGET = {
    cost_usd: 0.0001,
    daily_remaining_usd: 0,
    daily_budget_usd: 1,
    prepaid_remaining_usd: 0,
    resets_in_seconds: 3600,
};

function heldOnce(result: Result<string, OpenAlexError['code']>) {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
        open = resolve;
    });
    let calls = 0;
    return {
        run: async (): Promise<Result<string, OpenAlexError['code']>> => {
            calls += 1;
            if (calls > 1) {
                return { ok: true, data: 'done' };
            }
            await gate;
            return result;
        },
        open: () => open(),
        get calls() {
            return calls;
        },
    };
}

function failure(code: 'HTTP' | 'NETWORK' | 'TIMEOUT', status = 0): Result<never, OpenAlexError['code']> {
    const error =
        code === 'HTTP'
            ? createError('HTTP', { status, body: '' })
            : code === 'NETWORK'
              ? createError('NETWORK', { reason: 'down' })
              : createError('TIMEOUT', { timeoutMs: 1 });
    return { ok: false, error };
}

function queues(options: Parameters<typeof createRequestQueues>[1] = FAST) {
    const created = createRequestQueues({ rps: 10_000 }, options, true);
    if (!created.ok) {
        throw new Error(created.error.message);
    }
    return created.data;
}

function sequence(failures: readonly Result<never, OpenAlexError['code']>[]) {
    let calls = 0;
    const run = async (): Promise<Result<string, OpenAlexError['code']>> => {
        const next = failures[calls];
        calls += 1;
        return next ?? { ok: true, data: 'done' };
    };
    return {
        run,
        get calls() {
            return calls;
        },
    };
}

describe('checkLimits', () => {
    test('accepts undefined, empty and positive integer limits', () => {
        expect(checkLimits({})).toBeNull();
        expect(checkLimits({ concurrency: 2, rps: 5, rpm: 100, rpd: 1000, buckets: [] })).toBeNull();
    });

    test.each([
        [null, 'limits'],
        [{ rps: 0 }, 'limits.rps'],
        [{ concurrency: 1.5 }, 'limits.concurrency'],
        [{ rpm: '10' }, 'limits.rpm'],
        [{ burst: 3 }, 'limits.burst'],
        [{ buckets: 'x' }, 'limits.buckets'],
        [{ buckets: [null] }, 'limits.buckets'],
        [{ buckets: [{}] }, 'limits.buckets'],
    ])('rejects %p', (value, field) => {
        const error = checkLimits(value);
        expect(error?.code).toBe('INVALID_OPTIONS');
        expect(error?.message).toContain(field);
    });
});

describe('checkLimiterOptions', () => {
    test('accepts zero and positive integers', () => {
        expect(checkLimiterOptions({ maxRetries: 0, retryDelayMs: 0, maxRetryDelayMs: 10, maxWaitMs: 5 })).toBeNull();
    });

    test.each([
        [{ maxRetries: -1 }, 'limiterOptions.maxRetries'],
        [{ retryDelayMs: 0.5 }, 'limiterOptions.retryDelayMs'],
        [{ timeoutMs: 5 }, 'limiterOptions.timeoutMs'],
        [[], 'limiterOptions'],
    ])('rejects %p', (value, field) => {
        const error = checkLimiterOptions(value);
        expect(error?.code).toBe('INVALID_OPTIONS');
        expect(error?.message).toContain(field);
    });
});

describe('schedule', () => {
    test('returns the data of a successful run', async () => {
        const runner = sequence([]);
        expect(await schedule(queues(), 'free', runner.run)).toEqual({ ok: true, data: 'done' });
        expect(runner.calls).toBe(1);
    });

    test.each([
        ['HTTP 500', failure('HTTP', 500)],
        ['HTTP 408', failure('HTTP', 408)],
    ])('retries %s and then succeeds', async (_name, fail) => {
        const runner = sequence([fail, fail]);
        expect(await schedule(queues(), 'free', runner.run)).toEqual({ ok: true, data: 'done' });
        expect(runner.calls).toBe(3);
    });

    test('an outage (NETWORK, TIMEOUT, 502, 503, 504) is retried after a lane pause, beyond maxRetries', async () => {
        const outages = [
            failure('NETWORK'),
            failure('TIMEOUT'),
            failure('HTTP', 502),
            failure('HTTP', 503),
            failure('HTTP', 504),
        ];
        // maxRetries 0: an outage is capped by maxWaitMs only
        const runners = outages.map((fail) => sequence([fail]));
        const results = await Promise.all(
            runners.map((runner) => schedule(queues({ maxRetries: 0, retryDelayMs: 0 }), 'free', runner.run)),
        );
        expect(results).toEqual(outages.map(() => ({ ok: true, data: 'done' })));
        expect(runners.map((runner) => runner.calls)).toEqual([2, 2, 2, 2, 2]);
    });

    test('an outage pauses its lane; the free lane keeps running', async () => {
        const shared = queues();
        const order: string[] = [];
        let failedOnce: () => void = () => undefined;
        const failed = new Promise<void>((resolve) => {
            failedOnce = resolve;
        });
        function record(name: string): () => Promise<Result<string, OpenAlexError['code']>> {
            let calls = 0;
            return async () => {
                calls += 1;
                order.push(name);
                if (name === 'a' && calls === 1) {
                    failedOnce();
                    return failure('NETWORK');
                }
                return { ok: true, data: name };
            };
        }
        const a = schedule(shared, 'paid', record('a'));
        await failed;
        const waiting = [schedule(shared, 'paid', record('b')), schedule(shared, 'paid', record('c'))];
        await schedule(shared, 'free', record('free'));
        expect((await Promise.all([a, ...waiting])).map((result) => result.ok && result.data)).toEqual(['a', 'b', 'c']);
        // b and c, pushed before the free request, were not sent during the pause; one probe then ended it
        expect(order.slice(0, 2)).toEqual(['a', 'free']);
        expect(order.slice(2).sort()).toEqual(['a', 'b', 'c']);
    });

    test('an outage longer than maxWaitMs fails, and the lane refuses later requests unsent as NETWORK', async () => {
        // the first pause is at least 1 s, longer than maxWaitMs
        const shared = queues({ ...FAST, maxWaitMs: 500 });
        const runner = sequence([failure('HTTP', 503)]);
        const result = await schedule(shared, 'paid', runner.run);
        expect(!result.ok && result.error.status).toBe(503);
        expect(runner.calls).toBe(1);

        const refused = sequence([]);
        const paused = await schedule(shared, 'paid', refused.run);
        expect(refused.calls).toBe(0);
        expect(!paused.ok && paused.error.code).toBe('NETWORK');
        expect(!paused.ok && paused.error.status).toBeNull();
        expect(!paused.ok && paused.error.retryable).toBe(true);
        expect(!paused.ok && paused.error.retryAfterSeconds).toBe(1);
        expect(!paused.ok && paused.error.message).toContain('paused');
        expect(!paused.ok && paused.error.message).toContain('503');

        const free = sequence([]);
        expect((await schedule(shared, 'free', free.run)).ok).toBe(true);
        expect(free.calls).toBe(1);
    });

    test('after an outage over maxWaitMs, later requests fail unsent until the pause ends, then probe', async () => {
        // a 1 s pause, then a 1.2 s pause that would end past maxWaitMs: the lane stops with 1.2 s left
        const shared = queues({ maxRetries: 2, retryDelayMs: 600, maxWaitMs: 1500 });
        const first = sequence([failure('HTTP', 503), failure('HTTP', 503)]);
        expect(await schedule(shared, 'paid', first.run)).toMatchObject({ ok: false, error: { status: 503 } });
        expect(first.calls).toBe(2);

        const refused = sequence([]);
        const paused = await schedule(shared, 'paid', refused.run);
        expect(refused.calls).toBe(0);
        expect(paused).toMatchObject({ ok: false, error: { code: 'NETWORK', status: null, retryAfterSeconds: 2 } });

        // the pause ends: the next request is sent; it fails, and the grown backoff (2.4 s) stops the lane at once
        await Bun.sleep(1300);
        const probe = sequence([failure('NETWORK')]);
        const probed = await schedule(shared, 'paid', probe.run);
        expect(!probed.ok && probed.error.message).toContain('down');
        expect(probe.calls).toBe(1);
        const refusedAgain = sequence([]);
        expect(await schedule(shared, 'paid', refusedAgain.run)).toMatchObject({ ok: false, error: { status: null } });
        expect(refusedAgain.calls).toBe(0);

        // a probe that succeeds ends the pause
        await Bun.sleep(2500);
        const recovered = sequence([]);
        expect(await schedule(shared, 'paid', recovered.run)).toEqual({ ok: true, data: 'done' });
        expect(await schedule(shared, 'paid', sequence([]).run)).toEqual({ ok: true, data: 'done' });
    }, 15_000);

    test('an aborted signal returns ABORTED also while the lane refuses requests', async () => {
        const limited = {
            ok: false,
            error: { ...createError('RATE_LIMITED', { limiter: 'limited' }), status: 429, retryAfterSeconds: 3600 },
        } as Result<never, OpenAlexError['code']>;
        const shared = queues({ ...FAST, maxWaitMs: 1000 });
        await schedule(shared, 'paid', sequence([limited]).run);
        const controller = new AbortController();
        controller.abort();
        const runner = sequence([]);
        const result = await schedule(shared, 'paid', runner.run, { signal: controller.signal });
        expect(!result.ok && result.error.code).toBe('ABORTED');
        expect(runner.calls).toBe(0);
        // without a signal the lane still refuses
        expect(await schedule(shared, 'paid', sequence([]).run)).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    });

    test('a request waiting to retry a 500 fails with the 429 that stopped its lane', async () => {
        const shared = queues({ maxRetries: 2, retryDelayMs: 300, maxWaitMs: 1000 });
        let failed: () => void = () => undefined;
        const firstSent = new Promise<void>((resolve) => {
            failed = resolve;
        });
        let calls = 0;
        const retrying = schedule(shared, 'paid', async (): Promise<Result<string, OpenAlexError['code']>> => {
            calls += 1;
            failed();
            return calls === 1 ? failure('HTTP', 500) : { ok: true, data: 'done' };
        });
        await firstSent;
        const limited = {
            ok: false,
            error: { ...createError('RATE_LIMITED', { limiter: 'limited' }), status: 429, retryAfterSeconds: 3600 },
        } as Result<never, OpenAlexError['code']>;
        expect(await schedule(shared, 'paid', sequence([limited]).run)).toMatchObject({ error: { status: 429 } });
        // RATE_LIMITED, not the 500 of its first attempt, so a batch falls back to single lookups
        expect(await retrying).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
        expect(calls).toBe(1);
    });

    test('a sent request released by a stop keeps its own 503, not a "not sent" pause error', async () => {
        const shared = queues({ maxRetries: 2, retryDelayMs: 0, maxWaitMs: 1500 });
        let open: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            open = resolve;
        });
        // both are in flight together and fail with 503; one probes until the lane stops, the other waits
        const outage = () => {
            let calls = 0;
            const run = async (): Promise<Result<string, OpenAlexError['code']>> => {
                calls += 1;
                await gate;
                return failure('HTTP', 503);
            };
            return {
                run,
                get calls() {
                    return calls;
                },
            };
        };
        const first = outage();
        const second = outage();
        const results = Promise.all([schedule(shared, 'paid', first.run), schedule(shared, 'paid', second.run)]);
        await Bun.sleep(20);
        open();
        for (const result of await results) {
            expect(result).toMatchObject({ ok: false, error: { code: 'HTTP', status: 503 } });
        }
        expect([first.calls, second.calls].sort()).toEqual([1, 2]);
    }, 10_000);

    test('a request paused by its own 503 fails with the 429 that then stopped its lane', async () => {
        const shared = queues({ maxRetries: 2, retryDelayMs: 0, maxWaitMs: 5000 });
        let open: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            open = resolve;
        });
        let limitedCalls = 0;
        // in flight before the 503 arrives; answers 429 with an hour to wait once the lane is paused
        const limited = schedule(shared, 'paid', async (): Promise<Result<string, OpenAlexError['code']>> => {
            limitedCalls += 1;
            await gate;
            return {
                ok: false,
                error: { ...createError('RATE_LIMITED', { limiter: 'limited' }), status: 429, retryAfterSeconds: 3600 },
            };
        });
        const outage = sequence([failure('HTTP', 503)]);
        const paused = schedule(shared, 'paid', outage.run);
        await Bun.sleep(50);
        open();
        expect(await limited).toMatchObject({ error: { status: 429 } });
        // RATE_LIMITED, not its own 503, so a batch falls back to single lookups
        expect(await paused).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
        expect(outage.calls).toBe(1);
        expect(limitedCalls).toBe(1);
    });

    test('a request released after an outage pause ran out fails as NETWORK, not RATE_LIMITED', async () => {
        const shared = queues({ maxRetries: 2, retryDelayMs: 0, maxWaitMs: 1500 });
        let failed: () => void = () => undefined;
        const firstSent = new Promise<void>((resolve) => {
            failed = resolve;
        });
        let calls = 0;
        // a 503 pauses the lane for 1 s; the probe takes 0.7 s and returns a 500, so the lane stops after the pause
        const probe = schedule(shared, 'paid', async (): Promise<Result<string, OpenAlexError['code']>> => {
            calls += 1;
            if (calls === 1) {
                failed();
                return failure('HTTP', 503);
            }
            await Bun.sleep(700);
            return failure('HTTP', 500);
        });
        await firstSent;
        // let the 503 pause the lane before the next request arrives
        await Bun.sleep(50);
        const waiting = sequence([]);
        const released = await schedule(shared, 'paid', waiting.run);
        expect(waiting.calls).toBe(0);
        expect(released).toMatchObject({
            ok: false,
            error: { code: 'NETWORK', status: null, retryAfterSeconds: null },
        });
        expect(!released.ok && released.error.message).toContain('503');
        await probe;
    }, 10_000);

    test('a 500 that keeps failing stops after maxRetries with the last error', async () => {
        const runner = sequence(Array(10).fill(failure('HTTP', 500)));
        const result = await schedule(queues({ maxRetries: 2, retryDelayMs: 0 }), 'free', runner.run);
        expect(result.ok).toBe(false);
        expect(!result.ok && result.error.status).toBe(500);
        expect(runner.calls).toBe(3);
    });

    test('maxRetries 0 fails a 500 at once', async () => {
        const runner = sequence([failure('HTTP', 500)]);
        const result = await schedule(queues({ maxRetries: 0, retryDelayMs: 0 }), 'free', runner.run);
        expect(!result.ok && result.error.code).toBe('HTTP');
        expect(runner.calls).toBe(1);
    });

    test('fatal errors are not retried', async () => {
        const runner = sequence([failure('HTTP', 400), failure('HTTP', 400)]);
        const result = await schedule(queues(), 'free', runner.run);
        expect(!result.ok && result.error.status).toBe(400);
        expect(runner.calls).toBe(1);
    });

    test('a 429 with a zero wait is retried after the global pause', async () => {
        const limited = {
            ok: false,
            error: {
                code: 'RATE_LIMITED',
                message: 'limited',
                status: 429,
                retryable: true,
                retryAfterSeconds: 0,
                cause: null,
            },
        } as Result<never, OpenAlexError['code']>;
        const runner = sequence([limited]);
        expect(await schedule(queues(), 'free', runner.run)).toEqual({ ok: true, data: 'done' });
        expect(runner.calls).toBe(2);
    });

    test('a 429 asking to wait longer than maxWaitMs fails at once and pauses only its lane', async () => {
        const limited = {
            ok: false,
            error: {
                code: 'RATE_LIMITED',
                message: 'limited',
                status: 429,
                retryable: true,
                retryAfterSeconds: 3600,
                cause: null,
                budget: BUDGET,
            },
        } as Result<never, OpenAlexError['code']>;
        const shared = queues({ ...FAST, maxWaitMs: 1000 });
        const runner = sequence([limited]);
        const result = await schedule(shared, 'paid', runner.run);
        expect(!result.ok && result.error.code).toBe('RATE_LIMITED');
        expect(!result.ok && result.error.status).toBe(429);
        expect(!result.ok && result.error.retryAfterSeconds).toBe(3600);
        // the sent 429 keeps its own cost
        expect(!result.ok && result.error.budget).toEqual(BUDGET);
        expect(runner.calls).toBe(1);

        // the paid lane refuses requests without sending them until the pause ends
        const refused = sequence([]);
        const paused = await schedule(shared, 'paid', refused.run);
        expect(refused.calls).toBe(0);
        expect(!paused.ok && paused.error.code).toBe('RATE_LIMITED');
        expect(!paused.ok && paused.error.status).toBeNull();
        expect(!paused.ok && paused.error.retryable).toBe(true);
        expect(!paused.ok && paused.error.retryAfterSeconds).toBeGreaterThan(3590);
        expect(!paused.ok && paused.error.retryAfterSeconds).toBeLessThanOrEqual(3600);
        // a refused request carries the 429's headers but not its cost: it was never sent
        expect(!paused.ok && paused.error.budget).toEqual({ ...BUDGET, cost_usd: null });
        expect(!paused.ok && paused.error.message).toContain('paused by a 429');

        // the free lane is not paused: a paused lane would refuse the request unsent
        const free = sequence([]);
        expect(await schedule(shared, 'free', free.run)).toEqual({ ok: true, data: 'done' });
        expect(free.calls).toBe(1);
    });

    test('a 429 within maxWaitMs pauses its lane and then retries', async () => {
        const limited = {
            ok: false,
            error: {
                code: 'RATE_LIMITED',
                message: 'limited',
                status: 429,
                retryable: true,
                retryAfterSeconds: 1,
                cause: null,
            },
        } as Result<never, OpenAlexError['code']>;
        const shared = queues();
        const order: string[] = [];
        let limitedSent: () => void = () => undefined;
        const sent = new Promise<void>((resolve) => {
            limitedSent = resolve;
        });
        let paidCalls = 0;
        const paid = schedule(shared, 'paid', async (): Promise<Result<string, OpenAlexError['code']>> => {
            paidCalls += 1;
            order.push(`paid ${paidCalls}`);
            if (paidCalls === 1) {
                limitedSent();
                return limited;
            }
            return { ok: true, data: 'done' };
        });
        await sent;
        await schedule(shared, 'free', async (): Promise<Result<string, OpenAlexError['code']>> => {
            order.push('free');
            return { ok: true, data: 'done' };
        });
        expect(await paid).toEqual({ ok: true, data: 'done' });
        // the free request ran while the paid lane waited out its Retry-After, then the paid request was retried
        expect(order).toEqual(['paid 1', 'free', 'paid 2']);
    });

    test('a local bucket wait over maxWaitMs returns RATE_LIMITED without a status', async () => {
        const created = createRequestQueues({ rps: 10_000, rpd: 1 }, { ...FAST, maxWaitMs: 1000 }, true);
        if (!created.ok) {
            throw new Error(created.error.message);
        }
        expect(await schedule(created.data, 'free', sequence([]).run)).toEqual({ ok: true, data: 'done' });
        const runner = sequence([]);
        const result = await schedule(created.data, 'free', runner.run);
        expect(!result.ok && result.error.code).toBe('RATE_LIMITED');
        expect(!result.ok && result.error.status).toBeNull();
        expect(!result.ok && result.error.retryable).toBe(true);
        expect(!result.ok && result.error.message).toContain('local limiter');
        // the bucket's remaining wait: the rolling day of the one request sent
        expect(!result.ok && result.error.retryAfterSeconds).toBeGreaterThan(86_390);
        expect(!result.ok && result.error.retryAfterSeconds).toBeLessThanOrEqual(86_400);
        expect(runner.calls).toBe(0);
    });

    test.each([
        [
            'throws',
            () => {
                throw new Error('broken bucket');
            },
        ],
        ['returns NaN', () => Number.NaN],
    ])('a user bucket that %s outside smart-limit still gives the local RATE_LIMITED', async (_name, broken) => {
        // smart-limit sees a wait over maxWaitMs; the limiter's own read of the wait gets the broken answer
        let isBroken = false;
        const bucket = {
            getWaitMs: () => (isBroken ? broken() : 3_600_000),
            reserve: () => undefined,
            settle: () => undefined,
        };
        const created = createRequestQueues({ rps: 10_000, buckets: [bucket] }, { ...FAST, maxWaitMs: 1000 }, true);
        if (!created.ok) {
            throw new Error(created.error.message);
        }
        const runner = sequence([]);
        // smart-limit checks the buckets and stops synchronously inside push; the limiter reads them after
        const pending = schedule(created.data, 'free', runner.run);
        isBroken = true;
        const result = await pending;
        expect(result).toMatchObject({
            ok: false,
            error: { code: 'RATE_LIMITED', status: null, retryAfterSeconds: null, budget: null },
        });
        expect(!result.ok && result.error.message).toContain('local limiter');
        expect(runner.calls).toBe(0);
    });

    test('an aborted signal returns ABORTED without running', async () => {
        const controller = new AbortController();
        controller.abort();
        const runner = sequence([]);
        const result = await schedule(queues(), 'free', runner.run, { signal: controller.signal });
        expect(!result.ok && result.error.code).toBe('ABORTED');
        expect(runner.calls).toBe(0);
    });

    test('concurrency limits runs in flight', async () => {
        const created = createRequestQueues({ concurrency: 2, rps: 10_000 }, FAST, false);
        if (!created.ok) {
            throw new Error(created.error.message);
        }
        let inFlight = 0;
        let peak = 0;
        async function run(): Promise<Result<number, 'HTTP'>> {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await Bun.sleep(5);
            inFlight -= 1;
            return { ok: true, data: 1 };
        }
        await Promise.all(Array.from({ length: 6 }, () => schedule(created.data, 'free', run)));
        expect(peak).toBe(2);
    });

    test.each(['free', 'paid'] as const)(
        'requests waiting to retry a 500 or 408 leave their slots to the next request (%s lane)',
        async (lane) => {
            const created = createRequestQueues(
                { concurrency: 2, rps: 10_000 },
                { maxRetries: 1, retryDelayMs: 300, maxRetryDelayMs: 300 },
                false,
            );
            if (!created.ok) {
                throw new Error(created.error.message);
            }
            const done: string[] = [];
            function run(name: string, failures: readonly Result<never, OpenAlexError['code']>[]) {
                const runner = sequence(failures);
                return async (): Promise<Result<string, OpenAlexError['code']>> => {
                    const result = await runner.run();
                    if (result.ok) {
                        done.push(name);
                    }
                    return result;
                };
            }
            const retried = [
                schedule(created.data, lane, run('a', [failure('HTTP', 500)])),
                schedule(created.data, lane, run('b', [failure('HTTP', 408)])),
            ];
            await Bun.sleep(20);
            const started = Date.now();
            const next = await schedule(created.data, lane, run('c', []));
            expect(next.ok).toBe(true);
            expect(Date.now() - started).toBeLessThan(200);
            await Promise.all(retried);
            expect(done).toEqual(['c', 'a', 'b']);
        },
    );

    test('both lanes share the concurrency limit', async () => {
        const created = createRequestQueues({ concurrency: 2, rps: 10_000 }, FAST, false);
        if (!created.ok) {
            throw new Error(created.error.message);
        }
        let inFlight = 0;
        let peak = 0;
        const lanes: string[] = [];
        function run(lane: string) {
            return async (): Promise<Result<number, 'HTTP'>> => {
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                lanes.push(lane);
                await Bun.sleep(5);
                inFlight -= 1;
                return { ok: true, data: 1 };
            };
        }
        await Promise.all([
            ...Array.from({ length: 4 }, () => schedule(created.data, 'free', run('free'))),
            ...Array.from({ length: 4 }, () => schedule(created.data, 'paid', run('paid'))),
        ]);
        expect(peak).toBe(2);
        expect(lanes.filter((lane) => lane === 'free')).toHaveLength(4);
        expect(lanes.filter((lane) => lane === 'paid')).toHaveLength(4);
    });

    test('both lanes share the requests-per-second limit', async () => {
        // the third request, in either lane, would wait about 1 s for the shared window, longer than maxWaitMs
        const created = createRequestQueues({ rps: 2 }, { ...FAST, maxWaitMs: 100 }, false);
        if (!created.ok) {
            throw new Error(created.error.message);
        }
        expect((await schedule(created.data, 'free', sequence([]).run)).ok).toBe(true);
        expect((await schedule(created.data, 'paid', sequence([]).run)).ok).toBe(true);
        const third = sequence([]);
        const refused = await schedule(created.data, 'free', third.run);
        expect(!refused.ok && refused.error.message).toContain('local limiter');
        expect(third.calls).toBe(0);
    });

    test('a higher priority starts first among waiting requests of a lane', async () => {
        const created = createRequestQueues({ concurrency: 1, rps: 10_000 }, FAST, false);
        if (!created.ok) {
            throw new Error(created.error.message);
        }
        const order: string[] = [];
        let release = (): void => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        function run(name: string, wait?: Promise<void>) {
            return async (): Promise<Result<string, 'HTTP'>> => {
                order.push(name);
                await wait;
                return { ok: true, data: name };
            };
        }
        const first = schedule(created.data, 'free', run('hold', held));
        await Bun.sleep(5);
        const rest = [
            schedule(created.data, 'free', run('a')),
            schedule(created.data, 'free', run('b')),
            schedule(created.data, 'free', run('c'), { priority: 1 }),
        ];
        release();
        await Promise.all([first, ...rest]);
        expect(order).toEqual(['hold', 'c', 'a', 'b']);
    });
});

describe('the first request after a stopped pause', () => {
    function limited(seconds: number): Result<never, OpenAlexError['code']> {
        const error = createError('RATE_LIMITED', { limiter: 'limited' });
        return { ok: false, error: { ...error, status: 429, retryAfterSeconds: seconds } };
    }

    async function stoppedLane(retryDelayMs = 0) {
        const shared = queues({ maxRetries: 2, retryDelayMs, maxWaitMs: 1500 });
        expect(await schedule(shared, 'paid', sequence([limited(2)]).run)).toMatchObject({ error: { status: 429 } });
        await Bun.sleep(2050);
        return shared;
    }

    function held(failures: readonly Result<never, OpenAlexError['code']>[]) {
        let open: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            open = resolve;
        });
        const inner = sequence(failures);
        return {
            run: async () => {
                await gate;
                return inner.run();
            },
            open: () => open(),
            get calls() {
                return inner.calls;
            },
        };
    }

    test('fails at once on an outage, refuses until the grown pause ends, then a success clears the stop', async () => {
        const shared = await stoppedLane();
        const probe = sequence([failure('HTTP', 503), failure('HTTP', 503)]);
        expect(await schedule(shared, 'paid', probe.run)).toMatchObject({ ok: false, error: { status: 503 } });
        expect(probe.calls).toBe(1);

        const refused = sequence([]);
        expect(await schedule(shared, 'paid', refused.run)).toMatchObject({
            ok: false,
            error: { code: 'NETWORK', status: null, retryAfterSeconds: 1 },
        });
        expect(refused.calls).toBe(0);

        await Bun.sleep(1050);
        expect(await schedule(shared, 'paid', sequence([]).run)).toEqual({ ok: true, data: 'done' });
        expect(await schedule(shared, 'paid', sequence([]).run)).toEqual({ ok: true, data: 'done' });
    }, 15_000);

    test('a request queued behind the failing probe is released unsent', async () => {
        const shared = await stoppedLane();
        const probe = held([failure('NETWORK')]);
        const probed = schedule(shared, 'paid', probe.run);
        await Bun.sleep(20);
        const behind = sequence([]);
        const waiting = schedule(shared, 'paid', behind.run);
        await Bun.sleep(20);
        probe.open();
        expect(await probed).toMatchObject({ ok: false, error: { code: 'NETWORK' } });
        expect(await waiting).toMatchObject({ ok: false, error: { code: 'NETWORK', status: null } });
        expect(behind.calls).toBe(0);
    }, 15_000);

    test('when the probe fails with a 500, the next request probes and still fails at once', async () => {
        // the 500 retries after 0.3 s; meanwhile the request behind it is sent as the probe
        const shared = await stoppedLane(300);
        const first = held([failure('HTTP', 500)]);
        const retrying = schedule(shared, 'paid', first.run);
        await Bun.sleep(20);
        const second = held([failure('HTTP', 503)]);
        const probed = schedule(shared, 'paid', second.run);
        await Bun.sleep(20);
        first.open();
        second.open();
        expect(await probed).toMatchObject({ ok: false, error: { status: 503 } });
        expect(second.calls).toBe(1);
        // released while waiting to retry its 500: the lane's pause, never the 500
        expect(await retrying).toMatchObject({ ok: false, error: { code: 'NETWORK', status: null } });
        expect(first.calls).toBe(1);
    }, 15_000);

    test('a probe 429 within maxWaitMs fails at once and refuses only for its own Retry-After', async () => {
        const shared = await stoppedLane();
        const probe = sequence([limited(1)]);
        expect(await schedule(shared, 'paid', probe.run)).toMatchObject({ ok: false, error: { status: 429 } });
        expect(probe.calls).toBe(1);
        expect(await schedule(shared, 'paid', sequence([]).run)).toMatchObject({
            ok: false,
            error: { code: 'RATE_LIMITED', status: null, retryAfterSeconds: 1 },
        });
        await Bun.sleep(1050);
        expect(await schedule(shared, 'paid', sequence([]).run)).toEqual({ ok: true, data: 'done' });
    }, 15_000);

    test('a success of a request sent before the stop does not end it, nor does its 503 replace the 429', async () => {
        const shared = queues({ maxRetries: 2, retryDelayMs: 0, maxWaitMs: 1500 });
        const before = held([]);
        const other = held([failure('HTTP', 503)]);
        const early = [schedule(shared, 'paid', before.run), schedule(shared, 'paid', other.run)];
        await Bun.sleep(20);
        // a 429 with an hour to wait stops the lane while both are still in flight
        expect(await schedule(shared, 'paid', sequence([limited(3600)]).run)).toMatchObject({
            error: { status: 429 },
        });
        before.open();
        other.open();
        await Promise.all(early);
        const refused = sequence([]);
        expect(await schedule(shared, 'paid', refused.run)).toMatchObject({
            ok: false,
            error: { code: 'RATE_LIMITED', status: null },
        });
        expect(refused.calls).toBe(0);
    }, 15_000);
});

describe('the error a released request reports for its lane pause', () => {
    function limited(seconds: number): Result<never, OpenAlexError['code']> {
        const error = createError('RATE_LIMITED', { limiter: 'limited' });
        return { ok: false, error: { ...error, status: 429, retryAfterSeconds: seconds, budget: BUDGET } };
    }

    function pausedThenSlow500(first: Result<never, OpenAlexError['code']>, delayMs: number) {
        let calls = 0;
        return async (): Promise<Result<string, OpenAlexError['code']>> => {
            calls += 1;
            if (calls === 1) {
                return first;
            }
            await Bun.sleep(delayMs);
            return failure('HTTP', 500);
        };
    }

    test('a stale in-flight timeout does not replace the 429 that paused the lane', async () => {
        // 429 pauses the lane for 1 s; the probe takes 0.7 s and returns a 500, so the lane stops after the pause
        const shared = queues({ maxRetries: 2, retryDelayMs: 0, maxWaitMs: 1500 });
        const inFlight = heldOnce(failure('TIMEOUT'));
        const early = schedule(shared, 'paid', inFlight.run);
        const pausing = schedule(shared, 'paid', pausedThenSlow500(limited(1), 700));
        await Bun.sleep(20);
        // sent before the 429 arrived: smart-limit ignores its timeout and keeps the 429's lock
        inFlight.open();
        await Bun.sleep(20);
        const waiting = sequence([]);
        const released = await schedule(shared, 'paid', waiting.run);
        expect(waiting.calls).toBe(0);
        expect(released).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', status: null } });
        expect(!released.ok && released.error.message).toContain('paused by a 429');
        expect(!released.ok && released.error.budget).toEqual({ ...BUDGET, cost_usd: null });
        expect((await early).ok).toBe(false);
        expect(inFlight.calls).toBe(1);
        await pausing;
    }, 10_000);

    test('a stale success during the probe does not let a later stale timeout replace the 429', async () => {
        // 429 pauses the lane for 1 s; the probe takes 0.9 s and returns a 500, so the lane stops at about 1.9 s
        const shared = queues({ maxRetries: 2, retryDelayMs: 0, maxWaitMs: 1500 });
        const staleOk = heldOnce({ ok: true, data: 'early' });
        const staleTimeout = heldOnce(failure('TIMEOUT'));
        const early = schedule(shared, 'paid', staleOk.run);
        const late = schedule(shared, 'paid', staleTimeout.run);
        const pausing = schedule(shared, 'paid', pausedThenSlow500(limited(1), 900));
        // during the probe: smart-limit reports lockUntil 0, which must not reset the 429's lock
        await Bun.sleep(1300);
        staleOk.open();
        expect(await early).toEqual({ ok: true, data: 'early' });
        // after the stop, while the run still waits for it: lockUntil is the 429's again
        await Bun.sleep(900);
        staleTimeout.open();
        const released = await late;
        expect(released).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', status: null } });
        expect(!released.ok && released.error.message).toContain('paused by a 429');
        expect(!released.ok && released.error.budget).toEqual({ ...BUDGET, cost_usd: null });
        expect(await pausing).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', status: null } });
    }, 10_000);

    test('a stale in-flight 429 shorter than the outage pause still replaces the outage', async () => {
        // 503 pauses the lane for 2 s; the stale 429 (1 s) does not extend it; the slow 500 probe stops the lane
        const shared = queues({ maxRetries: 2, retryDelayMs: 2000, maxWaitMs: 2500 });
        const inFlight = heldOnce(limited(1));
        const early = schedule(shared, 'paid', inFlight.run);
        const pausing = schedule(shared, 'paid', pausedThenSlow500(failure('HTTP', 503), 700));
        await Bun.sleep(20);
        inFlight.open();
        await Bun.sleep(20);
        const waiting = sequence([]);
        const released = await schedule(shared, 'paid', waiting.run);
        expect(waiting.calls).toBe(0);
        // RATE_LIMITED, not the outage, so a batch falls back to single lookups
        expect(released).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', status: null } });
        expect(!released.ok && released.error.budget).toEqual({ ...BUDGET, cost_usd: null });
        expect(await early).toMatchObject({ ok: false, error: { status: 429 } });
        await pausing;
    }, 10_000);

    test('a probe 503 after a 429 pause replaces the 429 for released and refused requests', async () => {
        // 429 pauses the lane for 1 s; the probe's 503 needs 1 s more, past maxWaitMs, and stops the lane
        const shared = queues({ maxRetries: 2, retryDelayMs: 0, maxWaitMs: 1500 });
        let calls = 0;
        const pausing = schedule(shared, 'paid', async (): Promise<Result<string, OpenAlexError['code']>> => {
            calls += 1;
            return calls === 1 ? limited(1) : failure('HTTP', 503);
        });
        await Bun.sleep(20);
        const waiting = sequence([]);
        const released = await schedule(shared, 'paid', waiting.run);
        expect(waiting.calls).toBe(0);
        expect(released).toMatchObject({ ok: false, error: { code: 'NETWORK', status: null } });
        expect(!released.ok && released.error.message).toContain('503');
        expect(await pausing).toMatchObject({ ok: false, error: { status: 503 } });
        expect(calls).toBe(2);

        const refused = sequence([]);
        const paused = await schedule(shared, 'paid', refused.run);
        expect(refused.calls).toBe(0);
        expect(paused).toMatchObject({ ok: false, error: { code: 'NETWORK', status: null, retryAfterSeconds: 1 } });
        expect(!paused.ok && paused.error.message).toContain('503');
    }, 10_000);
});

describe('a local bucket wait over maxWaitMs after a lane pause', () => {
    function dailyQueues(options: Parameters<typeof createRequestQueues>[1]) {
        const created = createRequestQueues({ rps: 10_000, rpd: 1 }, options, true);
        if (!created.ok) {
            throw new Error(created.error.message);
        }
        return created.data;
    }

    function expectLocal(result: Result<string, OpenAlexError['code']>) {
        expect(result).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', status: null, budget: null } });
        expect(!result.ok && result.error.message).toContain('local limiter');
        expect(!result.ok && result.error.retryAfterSeconds).toBeGreaterThan(86_390);
        expect(!result.ok && result.error.retryAfterSeconds).toBeLessThanOrEqual(86_400);
    }

    test('a 503 on the last daily request: released and later requests get the local RATE_LIMITED, not the outage', async () => {
        // the 503 pauses the lane for 1 s; then the day's bucket is empty, a wait far over maxWaitMs
        const shared = dailyQueues({ maxRetries: 2, retryDelayMs: 0, maxWaitMs: 1500 });
        const outage = heldOnce(failure('HTTP', 503));
        const sent = schedule(shared, 'paid', outage.run);
        await Bun.sleep(20);
        const waiting = sequence([]);
        const released = schedule(shared, 'paid', waiting.run);
        await Bun.sleep(20);
        outage.open();
        // the request that got the 503 keeps it
        expect(await sent).toMatchObject({ ok: false, error: { code: 'HTTP', status: 503 } });
        expect(outage.calls).toBe(1);
        expectLocal(await released);
        expect(waiting.calls).toBe(0);

        for (let round = 0; round < 2; round += 1) {
            const later = sequence([]);
            expectLocal(await schedule(shared, 'paid', later.run));
            expect(later.calls).toBe(0);
        }
    }, 10_000);

    test('a NaN bucket listed before the long daily bucket does not hide its wait after the elapsed 503 pause', async () => {
        // smart-limit gets 0 from the NaN bucket; the limiter's own read of the wait gets NaN
        let isNanMode = false;
        const nanBucket = {
            getWaitMs: () => (isNanMode ? Number.NaN : 0),
            reserve: () => undefined,
            settle: () => undefined,
        };
        const created = createRequestQueues(
            { rps: 10_000, buckets: [nanBucket, createRPD(1)] },
            { maxRetries: 2, retryDelayMs: 0, maxWaitMs: 1500 },
            true,
        );
        if (!created.ok) {
            throw new Error(created.error.message);
        }
        const outage = sequence([failure('HTTP', 503)]);
        expect(await schedule(created.data, 'paid', outage.run)).toMatchObject({ ok: false, error: { status: 503 } });
        // lets the stopped run finish, so the next push starts a new run synchronously
        await Bun.sleep(0);

        const later = sequence([]);
        // smart-limit checks the buckets and stops synchronously inside push; the limiter reads them after
        const pending = schedule(created.data, 'paid', later.run);
        isNanMode = true;
        expectLocal(await pending);
        expect(later.calls).toBe(0);
    }, 10_000);

    test('a 503 on the last daily request without others waiting: later requests get the local RATE_LIMITED', async () => {
        const shared = dailyQueues({ maxRetries: 2, retryDelayMs: 0, maxWaitMs: 1500 });
        const outage = sequence([failure('HTTP', 503)]);
        expect(await schedule(shared, 'paid', outage.run)).toMatchObject({ ok: false, error: { status: 503 } });
        expect(outage.calls).toBe(1);
        for (let round = 0; round < 2; round += 1) {
            const later = sequence([]);
            expectLocal(await schedule(shared, 'paid', later.run));
            expect(later.calls).toBe(0);
        }
    }, 10_000);

    test('a long 429 on the last daily request: released and later requests get the 429 pause', async () => {
        const shared = dailyQueues({ ...FAST, maxWaitMs: 1000 });
        const limited = heldOnce({
            ok: false,
            error: {
                ...createError('RATE_LIMITED', { limiter: 'limited' }),
                status: 429,
                retryAfterSeconds: 3600,
                budget: BUDGET,
            },
        });
        const sent = schedule(shared, 'paid', limited.run);
        await Bun.sleep(20);
        const waiting = sequence([]);
        const released = schedule(shared, 'paid', waiting.run);
        await Bun.sleep(20);
        limited.open();
        expect(await sent).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', status: 429, budget: BUDGET } });

        const later = sequence([]);
        const refused = schedule(shared, 'paid', later.run);
        for (const result of [await released, await refused]) {
            expect(result).toMatchObject({
                ok: false,
                error: { code: 'RATE_LIMITED', status: null, budget: { ...BUDGET, cost_usd: null } },
            });
            expect(!result.ok && result.error.message).toContain('paused by a 429');
            expect(!result.ok && result.error.retryAfterSeconds).toBeGreaterThan(3590);
            expect(!result.ok && result.error.retryAfterSeconds).toBeLessThanOrEqual(3600);
        }
        expect(waiting.calls).toBe(0);
        expect(later.calls).toBe(0);
    });
});
