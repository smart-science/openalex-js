// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { asText } from '../utils/values.js';

// -------------------------------------------------------------------
// --- 1. Constants
// -------------------------------------------------------------------

/** OpenAlex entity URL, e.g. https://openalex.org/W123 or https://openalex.org/subfields/1703. */
const MATCH_OPENALEX_PREFIX = /^https?:\/\/(?:(?:www|api)\.)?openalex\.org(?:\/+|(?=[?#])|$)/i;
/** ORCID iD URL, e.g. https://orcid.org/0000-0002-7184-5831. */
const MATCH_ORCID_PREFIX = /^https?:\/\/(?:www\.)?orcid\.org(?:\/+|(?=[?#])|$)/i;
/** ROR (Research Organization Registry) institution URL, e.g. https://ror.org/042nb2s44. */
const MATCH_ROR_PREFIX = /^https?:\/\/(?:www\.)?ror\.org(?:\/+|(?=[?#])|$)/i;
/** Wikidata entity URL, e.g. https://www.wikidata.org/wiki/Q21198. */
const MATCH_WIKIDATA_PREFIX = /^https?:\/\/(?:www\.)?wikidata\.org(?:\/(?:wiki|entity))?(?:\/+|(?=[?#])|$)/i;
/** Query string or fragment; never part of identifier. */
const MATCH_QUERY_OR_HASH = /[?#][\s\S]*$/;
const MATCH_TRAILING_SLASH = /\/+$/;

// -------------------------------------------------------------------
// --- 2. Exported Functions
// -------------------------------------------------------------------

/** OpenAlex URL → last path segment (W123, 1703, cc-by). Other strings are kept trimmed. */
export function stripOpenAlexUrl(value: unknown): string | null {
    return stripPrefix(value, MATCH_OPENALEX_PREFIX, true);
}

/** Wikidata URL → bare Q-identifier. Other strings are kept trimmed. */
export function normalizeWikidata(value: unknown): string | null {
    return stripPrefix(value, MATCH_WIKIDATA_PREFIX, true);
}

/** ORCID URL → bare iD. Other strings are kept trimmed. */
export function normalizeOrcid(value: unknown): string | null {
    return stripPrefix(value, MATCH_ORCID_PREFIX, false);
}

/** ROR URL → bare ROR id. Other strings are kept trimmed. */
export function normalizeRor(value: unknown): string | null {
    return stripPrefix(value, MATCH_ROR_PREFIX, false);
}

// -------------------------------------------------------------------
// --- 3. Private Functions
// -------------------------------------------------------------------

/** Strips known URL prefix; non-strings and blank strings become null, never throws. */
function stripPrefix(value: unknown, prefix: RegExp, lastSegmentOnly: boolean): string | null {
    const text = asText(value);
    if (text === null || !prefix.test(text)) {
        return text;
    }
    const path = text.replace(MATCH_QUERY_OR_HASH, '').replace(prefix, '').replace(MATCH_TRAILING_SLASH, '');
    const id = (lastSegmentOnly ? path.slice(path.lastIndexOf('/') + 1) : path).trim();
    return id === '' ? null : id;
}
