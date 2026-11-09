// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { asIdentifier } from '../utils/values.js';

// -------------------------------------------------------------------
// --- 1. Constants
// -------------------------------------------------------------------

const MATCH_HTTP_URL = /^https?:\/\//i;
const MATCH_QUERY_OR_HASH = /[?#][\s\S]*$/;
/** Leading PubMed URL: current and legacy host formats. */
const MATCH_PMID_URL = /^https?:\/\/(?:www\.)?(?:pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov\/pubmed)\//i;
/** Leading pmid: label with optional URN prefix. */
const MATCH_PMID_LABEL = /^(?:urn:)?pmid:\s*/i;
/** Leading PMC URL: current and legacy host formats. */
const MATCH_PMCID_URL = /^https?:\/\/(?:www\.)?(?:ncbi\.nlm\.nih\.gov\/pmc|pmc\.ncbi\.nlm\.nih\.gov)\/articles\//i;
/** Leading pmc: or pmcid: label with optional URN prefix. */
const MATCH_PMCID_LABEL = /^(?:urn:)?pmc(?:id)?:\s*/i;
const PMCID_PREFIX = 'PMC';
/** Positive integer accession without leading zeros. */
const MATCH_ACCESSION = /^[1-9]\d*$/;
const MATCH_PMCID = /^PMC[1-9]\d*$/;
const MATCH_TRAILING_SLASH = /\/+$/;

// -------------------------------------------------------------------
// --- 2. Exported Functions
// -------------------------------------------------------------------

/** Normalizes raw PubMed identifier or URL into bare numeric accession string. */
export function normalizePmid(value: unknown): string | null {
    const raw = asIdentifier(value);
    if (raw === null) {
        return null;
    }
    const bare = withoutUrlDecoration(raw.replace(MATCH_PMID_LABEL, '')).replace(MATCH_PMID_URL, '').trim();
    return MATCH_ACCESSION.test(bare) ? bare : null;
}

/**
 * **Normalize PMCID**: extracts canonical PubMed Central identifier.
 *
 * - strips PubMed Central URL prefixes and protocol decoration
 * - restores uppercase PMC prefix when accession is bare integer
 */
export function normalizePmcid(value: unknown): string | null {
    const raw = asIdentifier(value);
    if (raw === null) {
        return null;
    }
    let bare = withoutUrlDecoration(raw.replace(MATCH_PMCID_LABEL, ''))
        .replace(MATCH_PMCID_URL, '')
        .trim()
        .toUpperCase();
    if (MATCH_ACCESSION.test(bare)) {
        bare = `${PMCID_PREFIX}${bare}`;
    }
    return MATCH_PMCID.test(bare) ? bare : null;
}

// -------------------------------------------------------------------
// --- 3. Private Functions
// -------------------------------------------------------------------

/** Removes query string, fragment and trailing slashes from URL inputs; bare values keep them and fail validation. */
function withoutUrlDecoration(raw: string): string {
    return MATCH_HTTP_URL.test(raw) ? raw.replace(MATCH_QUERY_OR_HASH, '').replace(MATCH_TRAILING_SLASH, '') : raw;
}
