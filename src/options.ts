// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import type { BatchStrategy } from './batch/types.js';
import type { ContentFormat } from './content/types.js';
import {
    checkLimiterOptions,
    checkLimits,
    type OpenAlexLimiterOptions,
    type OpenAlexLimits,
} from './transport/limiter.js';
import { createError, invalidOption, type OpenAlexError } from './utils/errors.js';
import { err, ok, type Result } from './utils/result.js';
import { isPlainObject } from './utils/values.js';
import { type RenameMap, type StrictRenameMap, validateRenameMap } from './work/rename.js';

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

type Base = {
    readonly timeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly fetchFn?: typeof fetch | undefined;
};

/** Queue settings of the factory. */
type Limiting = {
    /** Request limits shared by the free and paid queues every request goes through. */
    readonly limits?: OpenAlexLimits | undefined;
    /** Retry and wait settings of both queues. */
    readonly limiterOptions?: OpenAlexLimiterOptions | undefined;
};

type Lookup = Base & {
    /** Array lookups only: 'batch' (default) uses list requests, 'single' one request per value. */
    readonly strategy?: BatchStrategy | undefined;
    /** Array lookups only: fall back to free single lookups when a list request fails with RATE_LIMITED (default false). */
    readonly fallbackOnRateLimit?: boolean | undefined;
    /** Array lookups only: send list chunks smaller than this as free single lookups (non-negative integer, default 0). */
    readonly singleBelow?: number | undefined;
};

/** Options for client.fetchDoi. */
export type DoiCallOptions = Lookup;

/** Options for client.fetchWorkById. */
export type WorkIdCallOptions = Lookup;

/** Options for client.fetchContent. */
export type ContentCallOptions = Base & {
    readonly format?: ContentFormat | undefined;
};

/** Options for client.fetchBudget. */
export type BudgetCallOptions = Base;

/** createOpenAlex factory options. */
export type OpenAlexOptions = Lookup &
    Limiting & {
        readonly apiKey?: string | undefined;
    };

/** Options carrying literal rename map typed Renamed<M>. */
export type RenameOptions<M extends RenameMap, O = DoiCallOptions> = O & {
    readonly rename: M & StrictRenameMap<M>;
};

/** Plain-overload options object disallowing rename map. */
export type PlainOptions<O = DoiCallOptions> = O & {
    readonly rename?: undefined;
};

/** @deprecated Use BudgetCallOptions or ContentCallOptions. */
export type CallOptions = Base;

/** @deprecated Use ContentCallOptions. */
export type ContentOptions = ContentCallOptions;

/** Validated factory options, frozen at creation. */
export type FactoryOptions = {
    readonly apiKey?: string;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly fetchFn?: typeof fetch;
    readonly rename?: RenameMap;
    readonly strategy?: BatchStrategy;
    readonly fallbackOnRateLimit?: boolean;
    readonly singleBelow?: number;
    readonly limits?: OpenAlexLimits;
    readonly limiterOptions?: OpenAlexLimiterOptions;
};

/**
 * **Merged call options**: validated combination of factory and call settings.
 *
 * - `clientSignal`: inherited factory signal, never from call input
 * - `rename`: validated downstream by fetchDoi after DOI validation
 */
export type MergedOptions = Omit<FactoryOptions, 'rename'> & {
    readonly clientSignal?: AbortSignal;
    readonly rename?: unknown;
    readonly format?: ContentFormat;
};

type OptionKey =
    | 'apiKey'
    | 'timeoutMs'
    | 'signal'
    | 'fetchFn'
    | 'rename'
    | 'format'
    | 'strategy'
    | 'fallbackOnRateLimit'
    | 'singleBelow'
    | 'limits'
    | 'limiterOptions';

// -------------------------------------------------------------------
// --- 2. Constants
// -------------------------------------------------------------------

const FACTORY_KEYS: readonly OptionKey[] = [
    'apiKey',
    'timeoutMs',
    'signal',
    'fetchFn',
    'rename',
    'strategy',
    'fallbackOnRateLimit',
    'singleBelow',
    'limits',
    'limiterOptions',
];

/** limits and limiterOptions belong to the client queue and are not read per call. */
export const DOI_KEYS: readonly OptionKey[] = [
    'timeoutMs',
    'signal',
    'fetchFn',
    'rename',
    'strategy',
    'fallbackOnRateLimit',
    'singleBelow',
];
export const WORK_KEYS: readonly OptionKey[] = DOI_KEYS;
export const CONTENT_KEYS: readonly OptionKey[] = ['timeoutMs', 'signal', 'fetchFn', 'format'];
export const BUDGET_KEYS: readonly OptionKey[] = ['timeoutMs', 'signal', 'fetchFn'];

/** Read from the call only, never inherited from the factory. */
const CALL_ONLY_KEYS: readonly OptionKey[] = ['signal', 'format'];

/** Printable ASCII characters allowed in header values. */
const MATCH_PRINTABLE = /^[\x20-\x7e]+$/;
const CONTENT_FORMATS: readonly unknown[] = ['pdf', 'xml'] satisfies readonly ContentFormat[];
const STRATEGIES: readonly unknown[] = ['batch', 'single'] satisfies readonly BatchStrategy[];
const READ_ABORTED = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;

// -------------------------------------------------------------------
// --- 3. Exported Functions
// -------------------------------------------------------------------

/**
 * **Snapshot factory options**: reads each known key once, validates copy, freezes it.
 *
 * - package throwing path: invalid config produces TypeError with OpenAlexError cause
 * - creates shallow copy of rename map; preserves signal and fetchFn references
 * @throws {TypeError} on invalid options configuration or rename map
 */
export function snapshotFactoryOptions(opts: unknown): FactoryOptions {
    if (opts === undefined) {
        return Object.freeze({});
    }
    const read = readOptions(opts, FACTORY_KEYS);
    if (!read.ok) {
        throw configError(read.error);
    }
    const renameError = read.data.rename === undefined ? null : validateRenameMap(read.data.rename);
    if (renameError !== null) {
        throw configError(renameError);
    }
    return Object.freeze(read.data) as FactoryOptions;
}

/**
 * **Merge call options**: per-call values over factory values; never throws.
 *
 * - reads only keys method uses; ignores all other keys (including apiKey)
 * - preserves factory apiKey
 * - isolates factory signal as clientSignal so both signals apply
 */
export function mergeCall(
    factory: FactoryOptions,
    perCall: unknown,
    keys: readonly OptionKey[],
): Result<MergedOptions, 'INVALID_OPTIONS'> {
    const read: Result<Record<string, unknown>, 'INVALID_OPTIONS'> = perCall === undefined
        ? ok({})
        : readOptions(perCall, keys);
    if (!read.ok) {
        return read;
    }
    const inherited = factory as Readonly<Record<string, unknown>>;
    const merged: Record<string, unknown> = {};
    assign(merged, 'apiKey', factory.apiKey);
    assign(merged, 'clientSignal', factory.signal);
    for (const key of keys) {
        const value = read.data[key];
        // Only undefined inherits; per-call null is validated like any other value.
        assign(merged, key, CALL_ONLY_KEYS.includes(key) || value !== undefined ? value : inherited[key]);
    }
    return ok(merged as MergedOptions);
}

/** Creates TypeError with OpenAlexError cause for invalid factory configuration. */
export function configError(error: OpenAlexError): TypeError {
    return new TypeError(`createOpenAlex: ${error.message}`, { cause: error });
}

// -------------------------------------------------------------------
// --- 4. Private Functions
// -------------------------------------------------------------------

/** Reads listed keys once into fresh object and validates copy against getter tampering; never throws. */
function readOptions(opts: unknown, keys: readonly OptionKey[]): Result<Record<string, unknown>, 'INVALID_OPTIONS'> {
    try {
        if (!isPlainObject(opts)) {
            return err(invalidOption('options', 'must be a plain object'));
        }
        const bag = opts;
        const copy: Record<string, unknown> = {};
        for (const key of keys) {
            assign(copy, key, bag[key]);
        }
        for (const key of ['rename', 'limits', 'limiterOptions'] as const) {
            if (isPlainObject(copy[key])) {
                copy[key] = Object.freeze({ ...copy[key] });
            }
        }
        const limits = copy.limits as { buckets?: unknown } | undefined;
        if (isPlainObject(limits) && Array.isArray(limits.buckets)) {
            copy.limits = Object.freeze({ ...limits, buckets: Object.freeze([...limits.buckets]) });
        }
        const error = checkOptions(copy);
        if (error !== null) {
            return err(error);
        }
        if (typeof copy.apiKey === 'string') {
            copy.apiKey = copy.apiKey.trim();
        }
        return ok(copy);
    } catch (cause) {
        return err(createError('INVALID_OPTIONS', { option: 'options', reason: 'could not be read' }, cause));
    }
}

function assign(target: Record<string, unknown>, key: string, value: unknown): void {
    if (value !== undefined) {
        target[key] = value;
    }
}

/** Brand check: verifies AbortSignal instance accessors to reject spoofed Proxies. */
function isAbortSignal(value: unknown): value is AbortSignal {
    if (!(value instanceof AbortSignal)) {
        return false;
    }
    try {
        READ_ABORTED?.call(value);
        return true;
    } catch {
        return false;
    }
}

function checkOptions(bag: Readonly<Record<string, unknown>>): OpenAlexError<'INVALID_OPTIONS'> | null {
    const apiKey = bag.apiKey;
    if (apiKey !== undefined) {
        if (typeof apiKey !== 'string' || apiKey.trim() === '') {
            return invalidOption('apiKey', 'must be a non-empty string');
        }
        if (!MATCH_PRINTABLE.test(apiKey.trim())) {
            return invalidOption('apiKey', 'must contain only printable ASCII characters');
        }
    }

    const timeoutMs = bag.timeoutMs;
    if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        return invalidOption('timeoutMs', 'must be a finite number greater than 0');
    }

    if (bag.signal !== undefined && !isAbortSignal(bag.signal)) {
        return invalidOption('signal', 'must be an AbortSignal');
    }

    if (bag.fetchFn !== undefined && typeof bag.fetchFn !== 'function') {
        return invalidOption('fetchFn', 'must be a function');
    }

    if (bag.format !== undefined && !CONTENT_FORMATS.includes(bag.format)) {
        return invalidOption('format', 'must be "pdf" or "xml"');
    }

    if (bag.strategy !== undefined && !STRATEGIES.includes(bag.strategy)) {
        return invalidOption('strategy', 'must be "batch" or "single"');
    }

    if (bag.fallbackOnRateLimit !== undefined && typeof bag.fallbackOnRateLimit !== 'boolean') {
        return invalidOption('fallbackOnRateLimit', 'must be a boolean');
    }

    const singleBelow = bag.singleBelow;
    if (singleBelow !== undefined && !(Number.isInteger(singleBelow) && (singleBelow as number) >= 0)) {
        return invalidOption('singleBelow', 'must be a non-negative integer');
    }

    if (bag.limits !== undefined) {
        const limitsError = checkLimits(bag.limits);
        if (limitsError !== null) {
            return limitsError;
        }
    }

    if (bag.limiterOptions !== undefined) {
        const limiterError = checkLimiterOptions(bag.limiterOptions);
        if (limiterError !== null) {
            return limiterError;
        }
    }

    return null;
}
