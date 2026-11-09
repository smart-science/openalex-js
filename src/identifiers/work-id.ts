// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

// -------------------------------------------------------------------
// --- 1. Constants
// -------------------------------------------------------------------

const MATCH_HTTP_URL = /^https?:\/\//i;
/** OpenAlex URL with optional works/ segment. */
const MATCH_URL_PREFIX = /^https?:\/\/(?:(?:www|api)\.)?openalex\.org\/(?:works\/)?/i;
const MATCH_QUERY_OR_HASH = /[?#][\s\S]*$/;
const MATCH_TRAILING_SLASH = /\/+$/;
/** Canonical work ID format: 'W' followed by positive integer. */
const MATCH_WORK_ID = /^w[1-9]\d*$/i;

// -------------------------------------------------------------------
// --- 2. Exported Functions
// -------------------------------------------------------------------

/**
 * **Normalize work ID**: extracts and validates OpenAlex Work identifier.
 *
 * - strips OpenAlex URLs, query strings, and trailing slashes
 * - accepts raw IDs like W123 or lowercase w123
 * - ensures canonical uppercase work ID format
 */
export function normalizeWorkId(input: unknown): string | null {
    if (typeof input !== 'string') {
        return null;
    }

    let id = input.trim();
    if (id === '') {
        return null;
    }

    if (MATCH_HTTP_URL.test(id)) {
        if (!MATCH_URL_PREFIX.test(id)) {
            return null;
        }
        id = id.replace(MATCH_QUERY_OR_HASH, '').replace(MATCH_URL_PREFIX, '').replace(MATCH_TRAILING_SLASH, '').trim();
    }

    return MATCH_WORK_ID.test(id) ? id.toUpperCase() : null;
}
