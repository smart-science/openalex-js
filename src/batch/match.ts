// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { normalizeDoi } from '../identifiers/doi.js';
import { normalizeWorkId } from '../identifiers/work-id.js';
import { asArray, asNumber, asObject } from '../utils/values.js';
import type { OpenAlexWork } from '../work/api-types.js';
import type { BatchKind } from './chunk.js';

// -------------------------------------------------------------------
// --- 1. Constants
// -------------------------------------------------------------------

/** List responses cap authorships and locations at this many entries. */
const LIST_ARRAY_CAP = 100;
/** Location ids of DOI sources, e.g. `doi:10.48550/arxiv.1706.03762`. */
const MATCH_DOI_LOCATION_ID = /^doi:/i;
const MATCH_WORK_NUMBER = /\d+$/;
const MATCH_LEADING_ZEROS = /^0+(?=\d)/;
/** Query string and fragment of a landing-page or PDF URL. */
const MATCH_URL_SUFFIX = /[?#].*$/;

// -------------------------------------------------------------------
// --- 2. Exported Functions
// -------------------------------------------------------------------

/**
 * **DOIs of a work**: every DOI a filter request can match the work by.
 *
 * - `doi`, `ids.doi`, and the `doi` of each location, `primary_location` and `best_oa_location`
 *   (list responses cut `locations` at 100, but keep those two)
 * - location ids with a `doi:` prefix
 * - DOIs in location landing-page and PDF URLs (doi.org links), without query string or fragment
 */
export function doiKeys(work: OpenAlexWork): Set<string> {
    const values: unknown[] = [work.doi, asObject(work.ids)?.doi];
    for (const entry of [...asArray(work.locations), work.primary_location, work.best_oa_location]) {
        const location = asObject(entry);
        if (location === null) {
            continue;
        }
        values.push(location.doi, stripUrlSuffix(location.landing_page_url), stripUrlSuffix(location.pdf_url));
        if (typeof location.id === 'string' && MATCH_DOI_LOCATION_ID.test(location.id)) {
            values.push(location.id.replace(MATCH_DOI_LOCATION_ID, ''));
        }
    }
    const keys = new Set<string>();
    for (const value of values) {
        const doi = normalizeDoi(value);
        if (doi !== null) {
            keys.add(doi);
        }
    }
    return keys;
}

/**
 * **Indexes works by key**: candidates for each requested key.
 *
 * - DOI keys come from doiKeys; id keys from the work's W id
 * - works without a key are skipped
 */
export function indexWorks(works: readonly OpenAlexWork[], kind: BatchKind): Map<string, OpenAlexWork[]> {
    const index = new Map<string, OpenAlexWork[]>();
    for (const work of works) {
        if (asObject(work) === null) {
            continue;
        }
        const keys = kind === 'doi' ? doiKeys(work) : idKeys(work);
        for (const key of keys) {
            const candidates = index.get(key);
            if (candidates === undefined) {
                index.set(key, [work]);
            } else {
                candidates.push(work);
            }
        }
    }
    return index;
}

/**
 * **Picks one work** among candidates for the same key.
 *
 * - a work whose own `doi` or `ids.doi` is the key wins over works that hold it only in a location
 * - then the highest cited_by_count, as single lookup does
 * - ties go to the lowest W id number, the older record
 */
export function pickWork(candidates: readonly OpenAlexWork[], key: string | null = null): OpenAlexWork | null {
    let best: OpenAlexWork | null = null;
    for (const work of candidates) {
        if (best === null || compareWorks(work, best, key) < 0) {
            best = work;
        }
    }
    return best;
}

/** True when list response may have truncated authorships or locations at 100 entries. */
export function isTruncated(work: OpenAlexWork): boolean {
    return asArray(work.authorships).length >= LIST_ARRAY_CAP || asArray(work.locations).length >= LIST_ARRAY_CAP;
}

/** True when work's own `doi` or `ids.doi` matches key, not only a location DOI. */
export function isPrimaryDoi(work: OpenAlexWork, key: string): boolean {
    return normalizeDoi(work.doi) === key || normalizeDoi(asObject(work.ids)?.doi) === key;
}

// -------------------------------------------------------------------
// --- 3. Private Functions
// -------------------------------------------------------------------

function idKeys(work: OpenAlexWork): string[] {
    const id = normalizeWorkId(work.id);
    return id === null ? [] : [id];
}

/** Negative when a ranks before b. */
function compareWorks(a: OpenAlexWork, b: OpenAlexWork, key: string | null): number {
    if (key !== null) {
        const primary = Number(isPrimaryDoi(b, key)) - Number(isPrimaryDoi(a, key));
        if (primary !== 0) {
            return primary;
        }
    }
    const citations = (asNumber(b.cited_by_count) ?? 0) - (asNumber(a.cited_by_count) ?? 0);
    return citations === 0 ? compareWorkNumbers(a, b) : citations;
}

/** Lower W number first, works without one last; compares digit strings to avoid precision loss. */
function compareWorkNumbers(a: OpenAlexWork, b: OpenAlexWork): number {
    const left = workDigits(a);
    const right = workDigits(b);
    if (left === right) {
        return 0;
    }
    if (left === null || right === null) {
        return left === null ? 1 : -1;
    }
    if (left.length !== right.length) {
        return left.length - right.length;
    }
    return left < right ? -1 : 1;
}

function workDigits(work: OpenAlexWork): string | null {
    const digits = normalizeWorkId(work.id)?.match(MATCH_WORK_NUMBER)?.[0];
    return digits === undefined ? null : digits.replace(MATCH_LEADING_ZEROS, '');
}

function stripUrlSuffix(value: unknown): unknown {
    return typeof value === 'string' ? value.replace(MATCH_URL_SUFFIX, '') : value;
}
