// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { normalizeDoi } from '../identifiers/doi.js';
import { normalizeWorkId } from '../identifiers/work-id.js';
import { MAX_FILTER_VALUES } from '../transport/request.js';
import { dedupe, label } from '../utils/values.js';
import type { BatchStrategy } from './types.js';

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

/** Identifier type of an array lookup; DOI and id filters cannot be combined. */
export type BatchKind = 'doi' | 'id';

/** One input with its normalized key; key is null for invalid input. */
export type Entry = {
    readonly input: string;
    readonly key: string | null;
};

/** Requests to send: list chunks of at most MAX_FILTER_VALUES keys, and keys for single lookup. */
export type RequestPlan = {
    readonly lists: readonly (readonly string[])[];
    readonly singles: readonly string[];
};

// -------------------------------------------------------------------
// --- 2. Constants
// -------------------------------------------------------------------

/** Characters that break filter syntax (`,` separates filters, `|` separates values) or the value itself. */
const MATCH_FILTER_UNSAFE = /[,|\s]/;

// -------------------------------------------------------------------
// --- 3. Exported Functions
// -------------------------------------------------------------------

/** Normalizes each input to a DOI or W id, one entry per index (holes as `undefined`); never throws. */
export function toEntries(inputs: readonly unknown[], kind: BatchKind): Entry[] {
    const normalize = kind === 'doi' ? normalizeDoi : normalizeWorkId;
    return Array.from(inputs, (input) => ({ input: label(input), key: normalize(input) }));
}

/**
 * **Plans requests** for distinct valid keys.
 *
 * - `single` strategy: every key uses single lookup
 * - DOIs containing `,`, `|` or whitespace use single lookup
 * - other keys chunked by MAX_FILTER_VALUES in first-occurrence order
 * - `singleBelow`: chunks smaller than this threshold use free single lookups instead of paid list requests (0 disables)
 */
export function planRequests(
    entries: readonly Entry[],
    kind: BatchKind,
    strategy: BatchStrategy,
    singleBelow = 0,
): RequestPlan {
    const keys = dedupe(entries.flatMap((entry) => (entry.key === null ? [] : [entry.key])));
    if (strategy === 'single') {
        return { lists: [], singles: keys };
    }
    const unsafe = kind === 'doi' ? keys.filter((key) => MATCH_FILTER_UNSAFE.test(key)) : [];
    const listed = keys.filter((key) => !unsafe.includes(key));
    const lists: string[][] = [];
    const singles = [...unsafe];
    for (let start = 0; start < listed.length; start += MAX_FILTER_VALUES) {
        const chunk = listed.slice(start, start + MAX_FILTER_VALUES);
        if (chunk.length < singleBelow) {
            singles.push(...chunk);
        } else {
            lists.push(chunk);
        }
    }
    return { lists, singles };
}
