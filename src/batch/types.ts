// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import type { Budget } from '../content/types.js';
import type { OpenAlexError, OpenAlexErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/result.js';

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

/** How an array lookup resolves values: list requests with single-lookup fallbacks, or single lookups only. */
export type BatchStrategy = 'batch' | 'single';

/** Requests one array lookup sent; retries are not counted. */
export type BatchRequests = {
    /** List requests (1 credit each). */
    readonly list: number;
    /** Single lookups (free). */
    readonly single: number;
};

/** Error codes of an array lookup: a 404 is a null work, never an error. */
export type BatchErrorCode<C extends OpenAlexErrorCode> = Exclude<C, 'NOT_FOUND'>;

/**
 * **Array lookup payload**: keyed by input as given; duplicate inputs share one entry.
 *
 * - every input is in `works` or `errors`, never both
 * - `works`: matched work, or null on HTTP 404
 * - `errors`: invalid input or request failure after retries; truncated work whose refetch failed is an error
 * - `budget`: summed cost; remaining fields from response with lowest remaining budget
 */
export type BatchData<D, C extends OpenAlexErrorCode> = {
    readonly works: Readonly<Record<string, D | null>>;
    readonly errors: Readonly<Record<string, OpenAlexError<BatchErrorCode<C>>>>;
    readonly budget: Budget | null;
    readonly requests: BatchRequests;
};

/**
 * **Array lookup result**: BatchData, or one error for the whole lookup.
 *
 * - `ok: true` when inputs are empty or at least one input is in `works`
 * - `ok: false` on invalid options/rename map, or when every input failed (returns most common error with combined budget)
 */
export type BatchResult<D, C extends OpenAlexErrorCode> = Result<BatchData<D, C>, BatchErrorCode<C>>;
