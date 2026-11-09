// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

// -------------------------------------------------------------------
// --- 1. Constants
// -------------------------------------------------------------------

/** Strips prefix: `doi:` / `DOI:` / `DOI ` with optional trailing spaces. */
const MATCH_LABEL = /^doi[:\s]\s*/i;
/** Matches common doi.org URL prefixes. */
const MATCH_URL = /^(?:https?:\/\/)?(?:dx\.|www\.)?doi\.org\//i;
/**
 * **Plausible DOI**: validates structure and rejects illegal characters.
 *
 * - matches `10.` followed by 4–9 digit registrant and `/`
 * - rejects control characters and lone surrogates to prevent encodeURIComponent failures
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const MATCH_DOI = /^10\.\d{4,9}\/[^\u0000-\u001f\u007f\ud800-\udfff]+$/u;

const PATH_PREFIX = 'doi:';

// -------------------------------------------------------------------
// --- 2. Exported Functions
// -------------------------------------------------------------------

/**
 * **Normalize DOI**: strips prefix around DOI and validates format.
 *
 * - trims surrounding whitespace, strips `doi:` label and doi.org resolver URL
 * - lowercases (DOIs are case-insensitive)
 * - preserves suffix intact: punctuation, `%`, `?`, `#`, and inner spaces remain as given
 * - normalizes caller inputs and returned OpenAlex DOIs for exact equality comparisons
 */
export function normalizeDoi(input: unknown): string | null {
    if (typeof input !== 'string') {
        return null;
    }
    // Label is stripped on both sides of the URL: `doi: https://doi.org/10.…` and `https://doi.org/doi:10.…`.
    const doi = input.trim().replace(MATCH_LABEL, '').replace(MATCH_URL, '').replace(MATCH_LABEL, '').toLowerCase();
    return MATCH_DOI.test(doi) ? doi : null;
}

/** Encodes normalized DOI into path segment for OpenAlex API. */
export function encodeDoi(doi: string): string {
    return `${PATH_PREFIX}${encodeURIComponent(doi)}`;
}
