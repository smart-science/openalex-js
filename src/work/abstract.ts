// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { MAX_ABSTRACT_POSITION } from '../utils/constants.js';
import { asObject } from '../utils/values.js';

// -------------------------------------------------------------------
// --- 1. Constants
// -------------------------------------------------------------------

const SEPARATOR = ' ';
const MATCH_WHITESPACE = /\s+/g;

// -------------------------------------------------------------------
// --- 2. Exported Functions
// -------------------------------------------------------------------

/**
 * **Reconstruct abstract**: rebuilds plaintext abstract from OpenAlex inverted index.
 *
 * - returns null for non-object, empty, or unparseable input
 * - skips non-array positions, negative numbers, and non-integers
 * - aborts reconstruction if position exceeds maximum threshold
 * - applies last-write-wins rule on position collisions
 * - key order: canonical array-index tokens (`"2019"`, not `"007"`) first ascending, then insertion order
 * - drops empty gaps and filters sparse array holes
 */
export function reconstructAbstract(
    index: Readonly<Record<string, readonly number[]>> | null | undefined,
): string | null {
    if (asObject(index) === null) {
        return null;
    }

    // Written sparsely: a position of 500 000 costs one entry, not 500 000 slots.
    const slots: (string | undefined)[] = [];
    try {
        for (const [key, positions] of Object.entries(index as Record<string, unknown>)) {
            const token = key.trim().replace(MATCH_WHITESPACE, SEPARATOR);
            if (token === '' || !Array.isArray(positions)) {
                continue;
            }
            for (const position of positions) {
                if (!Number.isInteger(position) || position < 0) {
                    continue;
                }
                if (position > MAX_ABSTRACT_POSITION) {
                    return null; // allocation guard
                }
                slots[position] = token; // last write wins; word token beats array-index token (own-key order)
            }
        }
    } catch {
        return null;
    }

    // `filter` skips the holes a sparse array leaves, so gaps never become double spaces.
    const words = slots.filter((word): word is string => word !== undefined);
    return words.length === 0 ? null : words.join(SEPARATOR);
}
