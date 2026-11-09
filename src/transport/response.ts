// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import type { Budget } from '../content/types.js';
import { MAX_ERROR_BODY_LENGTH, MS_PER_SECOND } from '../utils/constants.js';
import { createError, type OpenAlexError, type OpenAlexErrorCode } from '../utils/errors.js';

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

/** Response interface slice used for transport operations. */
export type ResponseLike = {
    readonly status: number;
    readonly headers?: { get(name: string): string | null } | undefined;
    text(): Promise<string>;
    /** Only read for binary content (PDF); a stub without it gets PARSE. */
    arrayBuffer?(): Promise<ArrayBuffer>;
};

// -------------------------------------------------------------------
// --- 2. Constants
// -------------------------------------------------------------------

export const HTTP_STATUS = {
    OK: 200,
    /** First non-2xx status — anything at or above this is not a success. */
    MULTIPLE_CHOICES: 300,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    TOO_MANY_REQUESTS: 429,
} as const;

const TRUNCATION_SUFFIX = '…';
const MATCH_WHITESPACE_RUN = /\s+/g;
const MATCH_DELAY_SECONDS = /^\d+$/;

/**
 * **Match HTTP-date indicator**: checks for alphabetic characters in timestamp string.
 *
 * - detects letters from month/day names or ISO format
 * - prevents V8 Date.parse from incorrectly accepting negative integers
 */
const MATCH_HTTP_DATE_HINT = /[a-z]/i;
/** Plain decimal number with optional exponent (`1e-05`). */
const MATCH_DECIMAL = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;

// -------------------------------------------------------------------
// --- 3. Exported Functions
// -------------------------------------------------------------------

/** Type guard checking whether a value implements the ResponseLike interface slice. */
export function isResponseLike(value: unknown): value is ResponseLike {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as { status?: unknown; text?: unknown };
    return typeof candidate.status === 'number' && typeof candidate.text === 'function';
}

/** Checks whether HTTP status code indicates success (2xx). */
export function isSuccessStatus(status: number): boolean {
    return status >= HTTP_STATUS.OK && status < HTTP_STATUS.MULTIPLE_CHOICES;
}

/** Collapses whitespace and cuts to MAX_ERROR_BODY_LENGTH, marking the cut. */
export function summarizeBody(text: string): string {
    const collapsed = text.replace(MATCH_WHITESPACE_RUN, ' ').trim();
    return collapsed.length <= MAX_ERROR_BODY_LENGTH
        ? collapsed
        : `${collapsed.slice(0, MAX_ERROR_BODY_LENGTH)}${TRUNCATION_SUFFIX}`;
}

/** Extracts human-readable message from JSON error response or raw body. */
export function extractErrorBody(text: string): string {
    let body = text;
    try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null) {
            const bag = parsed as Record<string, unknown>;
            const message = typeof bag.message === 'string' ? bag.message.trim() : '';
            const error = typeof bag.error === 'string' ? bag.error.trim() : '';
            body = message !== '' ? message : error !== '' ? error : JSON.stringify(parsed);
        }
    } catch {
        // Not JSON: retain raw body.
    }
    return summarizeBody(body);
}

/**
 * **Parse Retry-After header**: computes delay in seconds from header value.
 *
 * - handles integer delay-seconds format
 * - handles RFC 9110 HTTP-date timestamps
 * - clamps negative or past timestamps to zero
 * @internal - exported for testing only
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text === '') {
        return null;
    }
    if (MATCH_DELAY_SECONDS.test(text)) {
        const seconds = Number(text);
        return Number.isFinite(seconds) ? seconds : null;
    }
    if (!MATCH_HTTP_DATE_HINT.test(text)) {
        return null;
    }
    const when = Date.parse(text);
    if (Number.isNaN(when)) {
        return null;
    }
    return Math.max(0, Math.ceil((when - now) / MS_PER_SECOND));
}

/**
 * Reads one header defensively from ResponseLike object.
 * @internal - exported for testing only
 */
export function headerValue(response: ResponseLike, name: string): string | null {
    return typeof response.headers?.get === 'function' ? response.headers.get(name) : null;
}

/** Extracts rate limit budget fields from response headers. */
export function parseBudget(response: ResponseLike): Budget | null {
    const budget: Budget = {
        cost_usd: headerNumber(response, 'X-RateLimit-Cost-USD'),
        daily_remaining_usd: headerNumber(response, 'X-RateLimit-Remaining-USD'),
        daily_budget_usd: headerNumber(response, 'X-RateLimit-Limit-USD'),
        prepaid_remaining_usd: headerNumber(response, 'X-RateLimit-Prepaid-Remaining-USD'),
        resets_in_seconds: headerNumber(response, 'X-RateLimit-Reset'),
    };
    return Object.values(budget).every((value) => value === null) ? null : budget;
}

/**
 * **Retry delay of a 429**: when to send the same request again.
 *
 * - `Retry-After` wins when OpenAlex sends it
 * - otherwise a spent daily budget (and no prepaid balance) waits for the reset; a per-second 429 has no known delay
 * - a negative reset is clamped to zero, as `parseRetryAfter` does for a past date
 */
export function retryDelay(response: ResponseLike): number | null {
    const header = parseRetryAfter(headerValue(response, 'Retry-After'));
    if (header !== null) {
        return header;
    }
    const remaining = headerNumber(response, 'X-RateLimit-Remaining-USD');
    const prepaid = headerNumber(response, 'X-RateLimit-Prepaid-Remaining-USD') ?? 0;
    const spent = remaining !== null && remaining <= 0 && prepaid <= 0;
    const reset = spent ? headerNumber(response, 'X-RateLimit-Reset') : null;
    return reset === null ? null : Math.max(0, reset);
}

/** Reads response body text defensively without throwing. */
export async function readBody(response: ResponseLike): Promise<string> {
    try {
        const text = await response.text();
        return typeof text === 'string' ? text : '';
    } catch {
        return '';
    }
}

/** Maps non-success HTTP status codes to standardized OpenAlexError. */
export function toStatusError<N extends OpenAlexErrorCode>(
    status: number,
    body: string,
    retryAfterSeconds: number | null,
    notFoundError: OpenAlexError<N>,
): OpenAlexError<N | 'RATE_LIMITED' | 'AUTH' | 'HTTP'> {
    if (status === HTTP_STATUS.NOT_FOUND) {
        return notFoundError;
    }
    if (status === HTTP_STATUS.TOO_MANY_REQUESTS) {
        return createError('RATE_LIMITED', { status, retryAfterSeconds });
    }
    if (status === HTTP_STATUS.UNAUTHORIZED || status === HTTP_STATUS.FORBIDDEN) {
        return createError('AUTH', { status });
    }
    return createError('HTTP', { status, body });
}

// -------------------------------------------------------------------
// --- 4. Private Functions
// -------------------------------------------------------------------

function headerNumber(response: ResponseLike, name: string): number | null {
    const text = (headerValue(response, name) ?? '').trim();
    const value = Number(text);
    return MATCH_DECIMAL.test(text) && Number.isFinite(value) ? value : null;
}
