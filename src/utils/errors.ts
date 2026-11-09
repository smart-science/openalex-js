// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import type { Budget } from '../content/types.js';

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

/** Registry-derived error code union. */
export type OpenAlexErrorCode = keyof typeof ERROR_MESSAGES;

/** Codes any HTTP request can end with, on top of the method's own codes. */
export type TransportErrorCode = 'RATE_LIMITED' | 'AUTH' | 'HTTP' | 'NETWORK' | 'TIMEOUT' | 'ABORTED' | 'PARSE';

/** Every code fetchDoi can return. */
export type FetchDoiErrorCode =
    | 'INVALID_OPTIONS'
    | 'INVALID_DOI'
    | 'INVALID_RENAME'
    | 'RENAME_COLLISION'
    | 'NOT_FOUND'
    | TransportErrorCode;

/** Every code fetchWorkById can return. */
export type FetchWorkErrorCode =
    | 'INVALID_OPTIONS'
    | 'INVALID_ID'
    | 'INVALID_RENAME'
    | 'RENAME_COLLISION'
    | 'NOT_FOUND'
    | TransportErrorCode;

/** Every code fetchContent can return. */
export type FetchContentErrorCode = 'INVALID_OPTIONS' | 'INVALID_ID' | 'NO_CONTENT' | TransportErrorCode;

/** Every code fetchBudget can return. */
export type FetchBudgetErrorCode = 'INVALID_OPTIONS' | TransportErrorCode;

type ArgsFor<C extends OpenAlexErrorCode> = Parameters<(typeof ERROR_MESSAGES)[C]>[0];

/** Standard error shape returned across all failure results. */
export type OpenAlexError<C extends OpenAlexErrorCode = OpenAlexErrorCode> = {
    /** Machine-readable, switchable error code. */
    readonly code: C;
    /** Human-readable error message. */
    readonly message: string;
    /** HTTP status code or null if no response was received. */
    readonly status: number | null;
    /** True when identical request may succeed later (NETWORK, TIMEOUT, RATE_LIMITED, HTTP 408/425/5xx). */
    readonly retryable: boolean;
    /** Seconds to wait before retrying; set on RATE_LIMITED (when known) and on NETWORK when a lane is paused after an outage. */
    readonly retryAfterSeconds: number | null;
    /** Underlying thrown error or rejection cause. */
    readonly cause: unknown;
    /**
     * **Budget headers of the failed response**: null when no response arrived or it had no budget headers.
     *
     * - exception: request refused or released while its lane is paused carries headers of the 429 that paused the lane, with `cost_usd: null`
     */
    readonly budget: Budget | null;
};

// -------------------------------------------------------------------
// --- 2. Constants
// -------------------------------------------------------------------

const LIST_SEPARATOR = ', ';

const ALWAYS_RETRYABLE: ReadonlySet<OpenAlexErrorCode> = new Set<OpenAlexErrorCode>([
    'NETWORK',
    'TIMEOUT',
    'RATE_LIMITED',
]);
/** Request Timeout and Too Early: the server asks for the same request again. */
const RETRYABLE_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 425]);
const FIRST_SERVER_ERROR_STATUS = 500;

/** Error message templates mapping error codes to formatters. */
export const ERROR_MESSAGES = {
    INVALID_DOI: (c: { input: string }) => `"${c.input}" is not a valid DOI`,
    INVALID_ID: (c: { input: string }) =>
        `"${c.input}" is not an OpenAlex work id (e.g. W2741809807) — resolve a DOI with fetchDoi and pass record.id`,
    INVALID_RENAME: (c: { keys: readonly string[] }) =>
        `Unknown field name(s) in rename map: ${c.keys.join(LIST_SEPARATOR)}`,
    RENAME_COLLISION: (c: { keys: readonly string[] }) =>
        `Rename target(s) collide with existing field(s): ${c.keys.join(LIST_SEPARATOR)}`,
    INVALID_OPTIONS: (c: { option: string; reason: string }) => `Invalid option "${c.option}": ${c.reason}`,
    NOT_FOUND: (c: { doi: string; status: number } | { workId: string; status: number }) =>
        'doi' in c ? `OpenAlex has no record for DOI "${c.doi}"` : `OpenAlex has no record for work ${c.workId}`,
    NO_CONTENT: (c: { workId: string; format: 'pdf' | 'xml'; status: number }) =>
        `OpenAlex has no ${c.format === 'pdf' ? 'PDF' : 'TEI XML'} for work ${c.workId}`,
    RATE_LIMITED: (c: { status: number; retryAfterSeconds: number | null } | { limiter: string }) =>
        'limiter' in c
            ? `Rate limited by the local limiter: ${c.limiter}`
            : `Rate limited by OpenAlex (HTTP ${c.status})${
                  c.retryAfterSeconds === null ? '' : `; retry after ${c.retryAfterSeconds}s`
              }`,
    AUTH: (c: { status: number }) => `Authentication failed (HTTP ${c.status}) — check your API key`,
    HTTP: (c: { status: number; body: string }) => `OpenAlex returned HTTP ${c.status}: ${c.body}`,
    NETWORK: (c: { reason: string }) => `Network request failed: ${c.reason}`,
    TIMEOUT: (c: { timeoutMs: number }) => `Request timed out after ${c.timeoutMs}ms`,
    ABORTED: (_c: Record<string, never>) => 'Request aborted by the caller',
    PARSE: (c: { body: string }) => `Unexpected response body: ${c.body}`,
} as const;

// -------------------------------------------------------------------
// --- 3. Exported Functions
// -------------------------------------------------------------------

/** Creates standardized OpenAlexError envelope. */
export function createError<C extends OpenAlexErrorCode>(
    code: C,
    args: ArgsFor<C>,
    cause: unknown = null,
): OpenAlexError<C> {
    const build = ERROR_MESSAGES[code] as (a: ArgsFor<C>) => string;
    const status = lift(args, 'status');
    return {
        code,
        message: build(args),
        status,
        retryable: isRetryable(code, status),
        retryAfterSeconds: lift(args, 'retryAfterSeconds'),
        cause,
        budget: null,
    };
}

/** Creates INVALID_OPTIONS error naming the option and why it is invalid. */
export function invalidOption(option: string, reason: string): OpenAlexError<'INVALID_OPTIONS'> {
    return createError('INVALID_OPTIONS', { option, reason });
}

// -------------------------------------------------------------------
// --- 4. Private Functions
// -------------------------------------------------------------------

function lift(args: object, key: 'status' | 'retryAfterSeconds'): number | null {
    const value = (args as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRetryable(code: OpenAlexErrorCode, status: number | null): boolean {
    if (ALWAYS_RETRYABLE.has(code)) {
        return true;
    }
    return (
        code === 'HTTP' &&
        status !== null &&
        (status >= FIRST_SERVER_ERROR_STATUS || RETRYABLE_CLIENT_STATUSES.has(status))
    );
}
