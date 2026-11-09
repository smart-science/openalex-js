// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import {
    type Bucket,
    createConcurrencyBucket,
    createQueue,
    createRPD,
    createRPM,
    createSlidingWindow,
    type JobError,
    type JobErrorType,
    type JobResult,
    type LimiterError,
    type PushOptions,
    type Queue,
} from 'smart-limit';
import { MS_PER_SECOND } from '../utils/constants.js';
import { createError, invalidOption, type OpenAlexError, type OpenAlexErrorCode } from '../utils/errors.js';
import { err, type Result } from '../utils/result.js';
import { isPlainObject } from '../utils/values.js';

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

/** Request limits of one client; unset keys use the defaults. */
export type OpenAlexLimits = {
    /** Requests in flight at once; default 10. */
    readonly concurrency?: number | undefined;
    /** Requests per second; default 25 with an API key, 8 without. */
    readonly rps?: number | undefined;
    /** Requests per minute; no default. */
    readonly rpm?: number | undefined;
    /** Requests per day; no default. */
    readonly rpd?: number | undefined;
    /** Extra smart-limit buckets, e.g. buckets shared with other clients. */
    readonly buckets?: readonly Bucket[] | undefined;
};

/** Retry and wait settings of the smart-limit queues. */
export type OpenAlexLimiterOptions = {
    /** Retries per request after HTTP 408, 425, 500, and other retryable 5xx (default 4; 429 and outages pause the lane instead). */
    readonly maxRetries?: number | undefined;
    /** Base exponential backoff delay in milliseconds (default 2000). */
    readonly retryDelayMs?: number | undefined;
    /** Backoff delay cap in milliseconds (default 300000). */
    readonly maxRetryDelayMs?: number | undefined;
    /** Maximum single 429/bucket wait, lane pause without a successful probe, or total per-request retry backoff in milliseconds (default 300000). */
    readonly maxWaitMs?: number | undefined;
};

/** Queue lane: `free` for single lookups and /rate-limit, `paid` for list requests and content downloads. */
export type Lane = 'free' | 'paid';

/** Options of one scheduled request. */
export type ScheduleOptions = {
    readonly signal?: AbortSignal | undefined;
    /** Higher starts first among waiting requests of the lane; default 0. */
    readonly priority?: number | undefined;
};

/** One queued request: run performs a single attempt. */
type Job = {
    readonly run: () => Promise<Result<unknown, OpenAlexErrorCode>>;
    lastError?: OpenAlexError;
};

/**
 * **One queue lane**: tracks smart-limit queue and pause state.
 *
 * - `lastPause`: 429 or outage error that last paused the lane
 * - `pauseUntil`: smart-limit `lockUntil` last seen after a 429 or outage (0 once unlocked); tells lock growth from stale failures
 * - `stoppedUntil`: timestamp when a pause exceeding maxWaitMs ends (0 when none); requests fail unsent until then
 * - `probing`: true after a stopped pause until a probe request succeeds
 * - `buckets`, `maxWaitMs`: queue settings; tell a local bucket stop from a lane pause
 */
type LaneQueue = {
    readonly queue: Queue<Job, unknown>;
    readonly buckets: readonly Bucket[];
    readonly maxWaitMs: number;
    lastPause: OpenAlexError | null;
    pauseUntil: number;
    stoppedUntil: number;
    probing: boolean;
};

/** Client queues sharing concurrency and rate buckets while pausing independently per lane. */
export type RequestQueues = Readonly<Record<Lane, LaneQueue>>;

// -------------------------------------------------------------------
// --- 2. Constants
// -------------------------------------------------------------------

const DEFAULT_CONCURRENCY = 10;
/** 30 req/s allowed with an API key, 10 without; the defaults stay below both. */
const DEFAULT_RPS_WITH_KEY = 25;
const DEFAULT_RPS_WITHOUT_KEY = 8;
/** Longest 429 pause or bucket wait before requests fail as RATE_LIMITED (5 minutes). */
const DEFAULT_MAX_WAIT_MS = 300_000;
/** Limiter buffer of each lane: unbounded, so retries sleeping in it never block free concurrency slots. */
const UNLIMITED_BUFFER = Number.POSITIVE_INFINITY;
/** Gateway statuses of a server that is down or overloaded; they pause the lane like a network error. */
const OUTAGE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

const LIMIT_KEYS: ReadonlySet<string> = new Set(['concurrency', 'rps', 'rpm', 'rpd', 'buckets']);
const INTEGER_LIMITS = ['concurrency', 'rps', 'rpm', 'rpd'] as const;
const LIMITER_KEYS: ReadonlySet<string> = new Set(['maxRetries', 'retryDelayMs', 'maxRetryDelayMs', 'maxWaitMs']);

// -------------------------------------------------------------------
// --- 3. Exported Functions
// -------------------------------------------------------------------

/** Validates the limits option; returns INVALID_OPTIONS or null. */
export function checkLimits(value: unknown): OpenAlexError<'INVALID_OPTIONS'> | null {
    const keysError = checkKeys(value, LIMIT_KEYS, 'limits');
    if (keysError !== null) {
        return keysError;
    }
    const limits = value as Readonly<Record<string, unknown>>;
    for (const key of INTEGER_LIMITS) {
        if (limits[key] !== undefined && !isInteger(limits[key], 1)) {
            return invalidOption(`limits.${key}`, 'must be an integer of at least 1');
        }
    }
    if (limits.buckets !== undefined && !(Array.isArray(limits.buckets) && limits.buckets.every(isBucket))) {
        return invalidOption('limits.buckets', 'must be an array of smart-limit buckets');
    }
    return null;
}

/** Validates the limiterOptions option; returns INVALID_OPTIONS or null. */
export function checkLimiterOptions(value: unknown): OpenAlexError<'INVALID_OPTIONS'> | null {
    const keysError = checkKeys(value, LIMITER_KEYS, 'limiterOptions');
    if (keysError !== null) {
        return keysError;
    }
    for (const [key, entry] of Object.entries(value as Readonly<Record<string, unknown>>)) {
        if (entry !== undefined && !isInteger(entry, 0)) {
            return invalidOption(`limiterOptions.${key}`, 'must be an integer of at least 0');
        }
    }
    return null;
}

/**
 * **Creates the free and paid queues** from validated limits.
 *
 * - concurrency and rps fall back to defaults; rps default depends on the API key
 * - user buckets are added after the built-in ones; both queues share every bucket instance
 * - returns INVALID_OPTIONS when a bucket reports a configError
 */
export function createRequestQueues(
    limits: OpenAlexLimits | undefined,
    limiterOptions: OpenAlexLimiterOptions | undefined,
    hasApiKey: boolean,
): Result<RequestQueues, 'INVALID_OPTIONS'> {
    const rps = limits?.rps ?? (hasApiKey ? DEFAULT_RPS_WITH_KEY : DEFAULT_RPS_WITHOUT_KEY);
    const buckets: Bucket[] = [
        createConcurrencyBucket(limits?.concurrency ?? DEFAULT_CONCURRENCY),
        createSlidingWindow({ requests: rps, perMs: MS_PER_SECOND }),
        ...(limits?.rpm === undefined ? [] : [createRPM(limits.rpm)]),
        ...(limits?.rpd === undefined ? [] : [createRPD(limits.rpd)]),
        ...(limits?.buckets ?? []),
    ];
    const broken = buckets.find((bucket) => bucket.configError !== undefined);
    if (broken !== undefined) {
        return err(invalidOption('limits', broken.configError?.message ?? 'invalid bucket'));
    }
    const settings: Record<string, number> = {};
    for (const [key, value] of Object.entries(limiterOptions ?? {})) {
        if (value !== undefined) {
            settings[key] = value;
        }
    }
    const maxWaitMs = limiterOptions?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    function createLane(): LaneQueue {
        const lane: LaneQueue = {
            buckets,
            maxWaitMs,
            lastPause: null,
            pauseUntil: 0,
            stoppedUntil: 0,
            probing: false,
            queue: createQueue<Job, unknown>({
                ...settings,
                maxWaitMs,
                // Each lane may use every slot; the shared concurrency bucket caps both together.
                concurrency: limits?.concurrency ?? DEFAULT_CONCURRENCY,
                maxBufferSize: UNLIMITED_BUFFER,
                buckets,
                processJob: (job) => attempt(job),
                onAttempt: (_job, result) => afterAttempt(lane, result),
            }),
        };
        return lane;
    }
    return { ok: true, data: { free: createLane(), paid: createLane() } };
}

/**
 * **Runs one request** through its lane queue.
 *
 * - 429 or outage (network error, timeout, HTTP 502/503/504) pauses only its lane and probes with one request at a time
 * - pauses exceeding maxWaitMs fail waiting requests and refuse new requests until the pause window expires, then send one probe
 * - HTTP 408, 425, 500, and other retryable 5xx retry per request up to maxRetries
 * - failed outcomes return last OpenAlex error, ABORTED, lane pause error, RATE_LIMITED (bucket wait > maxWaitMs), or NETWORK
 */
export async function schedule<T, C extends OpenAlexErrorCode>(
    queues: RequestQueues,
    lane: Lane,
    run: () => Promise<Result<T, C>>,
    options: ScheduleOptions = {},
): Promise<Result<T, C | 'ABORTED' | 'RATE_LIMITED' | 'TIMEOUT' | 'NETWORK'>> {
    const job: Job = { run };
    const target = queues[lane];
    // An aborted signal wins: the queue returns ABORTED without running the job.
    const refused = options.signal?.aborted ? null : refusalOf(target);
    if (refused !== null) {
        return err(refused as OpenAlexError<C | 'ABORTED' | 'RATE_LIMITED' | 'TIMEOUT' | 'NETWORK'>);
    }
    const push: PushOptions = {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.priority === undefined ? {} : { priority: options.priority }),
    };
    const outcome = await target.queue.push(job, push);
    if (outcome.ok) {
        return { ok: true, data: outcome.data as T };
    }
    return err(
        fromLimiterError(outcome.error, job, target) as OpenAlexError<
            C | 'ABORTED' | 'RATE_LIMITED' | 'TIMEOUT' | 'NETWORK'
        >,
    );
}

/** Signal that aborts when any of the given signals aborts; undefined when none is given. */
export function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
    const present = signals.filter((signal) => signal !== undefined);
    return present.length <= 1 ? present[0] : AbortSignal.any(present);
}

// -------------------------------------------------------------------
// --- 4. Private Functions
// -------------------------------------------------------------------

async function attempt(job: Job): Promise<JobResult<unknown>> {
    const result = await job.run();
    if (result.ok) {
        return { ok: true, data: result.data };
    }
    job.lastError = result.error;
    return { ok: false, error: toJobError(result.error) };
}

/** True when a pause with retryAfterMs outlasts the current stopped pause, preserving the active 429 and its budget against late in-flight failures. */
function replacesPause(lane: LaneQueue, error: JobError): boolean {
    const leftMs = lane.stoppedUntil - Date.now();
    return leftMs <= 0 || (error.retryAfterMs ?? 0) > leftMs;
}

/**
 * **smart-limit onAttempt hook**: updates pause and probe state after smart-limit processes an attempt.
 *
 * - `lastPause`: set by a 429 or outage that grew `lockUntil`, or by one with retryAfterMs per `replacesPause`; stale outage without retryAfterMs ignored
 * - when probing after a stop, a success that cleared `lockUntil` ends probing
 * - a 429 or outage while probing stops the queue immediately with the newly grown `lockUntil` (without awaiting `stop()` inside callback)
 */
function afterAttempt(lane: LaneQueue, result: JobResult<unknown>): void {
    const status = lane.queue.getStatus();
    // getStatus reports lockUntil 0 while a probe runs, so only 'unlocked' counts as no lock
    if (status.lockUntil === 0 && status.state !== 'probing') {
        lane.pauseUntil = 0;
    }
    if (!result.ok && result.error.type === 'backoff_global') {
        const grew = status.lockUntil > lane.pauseUntil;
        if (grew) {
            lane.pauseUntil = status.lockUntil;
        }
        // an error without retryAfterMs that did not grow the lock is a stale in-flight outage smart-limit ignored
        if (grew || (result.error.retryAfterMs !== undefined && replacesPause(lane, result.error))) {
            lane.lastPause = result.error.cause as OpenAlexError;
        }
    }
    if (!lane.probing) {
        return;
    }
    if (result.ok) {
        if (status.lockUntil === 0) {
            lane.probing = false;
        }
        return;
    }
    if (result.error.type === 'backoff_global' && status.state !== 'stopping') {
        void lane.queue.stop();
    }
}

/**
 * **smart-limit error** from an OpenAlex error; maps retryAfterSeconds to retryAfterMs.
 *
 * - 429 pauses its lane for retryAfterMs (fails immediately when exceeding maxWaitMs)
 * - outage has no retryAfterMs and pauses the lane with exponential backoff
 */
function toJobError(error: OpenAlexError): JobError {
    const jobError: JobError = { type: jobErrorType(error), message: error.message, code: error.code, cause: error };
    if (error.retryAfterSeconds !== null) {
        jobError.retryAfterMs = error.retryAfterSeconds * MS_PER_SECOND;
    }
    return jobError;
}

/**
 * **smart-limit error classification** for an OpenAlex error.
 *
 * - `backoff_global`: 429 and outages (network, timeout, 502, 503, 504); pauses lane and probes with one request
 * - `retry_backoff`: other retryable errors (408, 425, 500, other 5xx); retried per request without holding the lane
 * - `fatal`: non-retryable errors
 */
function jobErrorType(error: OpenAlexError): JobErrorType {
    if (error.code === 'RATE_LIMITED' || isOutage(error)) {
        return 'backoff_global';
    }
    return error.retryable ? 'retry_backoff' : 'fatal';
}

/** Checks if error represents an outage (network, timeout, or gateway failure). */
function isOutage(error: OpenAlexError): boolean {
    return (
        error.code === 'NETWORK' ||
        error.code === 'TIMEOUT' ||
        (error.code === 'HTTP' && error.status !== null && OUTAGE_STATUSES.has(error.status))
    );
}

/** Kind of pause an error causes: 'rate' for a 429, 'outage' for an outage, null for the rest. */
function pauseKind(error: OpenAlexError): 'rate' | 'outage' | null {
    if (error.code === 'RATE_LIMITED') {
        return 'rate';
    }
    return isOutage(error) ? 'outage' : null;
}

/** Returns pause error when lane is stopped and `stoppedUntil` has not elapsed; null when ready to queue/probe. */
function refusalOf(lane: LaneQueue): OpenAlexError | null {
    const pausedMs = lane.stoppedUntil - Date.now();
    return pausedMs > 0 ? pausedError(lane.lastPause, pausedMs, undefined) : null;
}

/**
 * **OpenAlex error** for a failed queue outcome.
 *
 * - ABORTED with signal reason as cause
 * - MAX_WAIT_EXCEEDED / STOPPED: returns trigger error, matching job attempt error, pausedError for active lane lock, or RATE_LIMITED for local bucket wait
 * - bucket stop (no cause, lock elapsed, bucket wait > maxWaitMs): lane not stopped, `probing` unchanged
 * - local bucket RATE_LIMITED: retryAfterSeconds = bucket's remaining wait (null when none), budget null
 * - otherwise returns last attempt error, or NETWORK fallback
 */
function fromLimiterError(error: LimiterError, job: Job, lane: LaneQueue): OpenAlexError {
    if (error.code === 'ABORTED') {
        return createError('ABORTED', {}, error.cause);
    }
    // STOPPED comes only from afterAttempt: a failed probe after a stop
    if (error.code === 'MAX_WAIT_EXCEEDED' || error.code === 'STOPPED') {
        // lockUntil is 0 while the lane is not paused; a stopped pause keeps it, even when it has passed
        const { lockUntil } = lane.queue.getStatus();
        const cause = error.cause as JobError | undefined;
        const wait = cause === undefined ? bucketWaitMs(lane.buckets) : 0;
        // smart-limit checks no bucket while the lock is active, so a stop then is caused by the lock
        const bucketStop = lockUntil <= Date.now() && Number.isFinite(wait) && wait > lane.maxWaitMs;
        // a request whose own retry backoff ran over maxWaitMs, or a local bucket wait, does not stop its lane
        if (!bucketStop && cause?.type !== 'retry_backoff' && lockUntil > 0) {
            lane.stoppedUntil = Math.max(lane.stoppedUntil, lockUntil);
            lane.probing = true;
        }
        const trigger = cause?.cause as OpenAlexError | undefined;
        if (trigger?.code !== undefined) {
            return trigger;
        }
        // a job released without cause that was sent and failed with the same kind of pause as the lane's
        // keeps its own error (and budget); an older error (a 500 it was waiting to retry, an outage a later
        // 429 replaced) is not why it stopped
        const kind = job.lastError === undefined ? null : pauseKind(job.lastError);
        if (kind !== null && lane.lastPause !== null && kind === pauseKind(lane.lastPause)) {
            return job.lastError as OpenAlexError;
        }
        if (!bucketStop && lockUntil > 0) {
            return pausedError(lane.lastPause, lockUntil - Date.now(), error);
        }
        const retryAfterSeconds = Number.isFinite(wait) && wait > 0 ? Math.ceil(wait / MS_PER_SECOND) : null;
        return { ...createError('RATE_LIMITED', { limiter: error.message }, error), retryAfterSeconds, budget: null };
    }
    if (job.lastError !== undefined) {
        return job.lastError;
    }
    return createError('NETWORK', { reason: `rate limiter: ${error.message}` }, error);
}

/**
 * **Error for a request refused while its lane is paused**: status null, retryAfterSeconds set to remaining pause seconds.
 *
 * - after 429: RATE_LIMITED with the 429's budget, `cost_usd: null` (request never sent; cost counted once via trigger)
 * - after outage: NETWORK naming the error that paused the lane
 */
function pausedError(pause: OpenAlexError | null, pausedMs: number, cause: unknown): OpenAlexError {
    const seconds = pausedMs > 0 ? Math.ceil(pausedMs / MS_PER_SECOND) : null;
    const left = seconds === null ? 'longer than maxWaitMs' : `for ${seconds}s more`;
    if (pause === null || pause.code === 'RATE_LIMITED') {
        const paused = createError('RATE_LIMITED', { limiter: `paused by a 429 ${left}` }, cause);
        const budget = pause?.budget == null ? null : { ...pause.budget, cost_usd: null };
        return { ...paused, retryAfterSeconds: seconds, budget };
    }
    const reason = `not sent, the lane is paused ${left} after: ${pause.message}`;
    return { ...createError('NETWORK', { reason }, cause), retryAfterSeconds: seconds };
}

/** Longest wait of any bucket for one request; a throw, non-number, NaN or `WAIT_FOR_CHANGE` counts as 0. */
function bucketWaitMs(buckets: readonly Bucket[]): number {
    const now = Date.now();
    let wait = 0;
    for (const bucket of buckets) {
        let bucketWait: unknown;
        try {
            bucketWait = bucket.getWaitMs({ requests: 1 }, now);
        } catch {
            bucketWait = 0;
        }
        if (typeof bucketWait === 'number' && !Number.isNaN(bucketWait)) {
            wait = Math.max(wait, bucketWait);
        }
    }
    return wait;
}

function checkKeys(
    value: unknown,
    allowed: ReadonlySet<string>,
    option: string,
): OpenAlexError<'INVALID_OPTIONS'> | null {
    if (!isPlainObject(value)) {
        return invalidOption(option, 'must be a plain object');
    }
    const unknown = Object.keys(value).find((key) => !allowed.has(key));
    return unknown === undefined ? null : invalidOption(`${option}.${unknown}`, 'is not a known option');
}

function isBucket(value: unknown): boolean {
    const bucket = value as Partial<Record<keyof Bucket, unknown>> | null;
    return (
        typeof bucket === 'object' &&
        bucket !== null &&
        typeof bucket.getWaitMs === 'function' &&
        typeof bucket.reserve === 'function' &&
        typeof bucket.settle === 'function'
    );
}

function isInteger(value: unknown, min: number): boolean {
    return typeof value === 'number' && Number.isInteger(value) && value >= min;
}
