// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { normalizeOrcid } from '../identifiers/bare-ids.js';
import { normalizeDoi } from '../identifiers/doi.js';
import { asArray, asBoolean, asObject, asText, dedupe } from '../utils/values.js';
import { reconstructAbstract } from './abstract.js';
import type { AbstractInvertedIndex, OpenAlexWork } from './api-types.js';
import { flatten, WORK_SCHEMA } from './flat-schema.js';
import type { AuthorRecord, DerivedFields, OaLocationRecord, WorkRecord } from './record-types.js';

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

type Bag = Record<string, unknown>;

// -------------------------------------------------------------------
// --- 2. Constants
// -------------------------------------------------------------------

const PAGE_RANGE_SEPARATOR = '-';
const AUTHOR_POSITIONS = ['first', 'middle', 'last'] as const;
const DEFAULT_AUTHOR_POSITION = 'middle';

// -------------------------------------------------------------------
// --- 3. Exported Functions
// -------------------------------------------------------------------

/**
 * **Convert to work record**: transforms raw OpenAlex work into canonical WorkRecord.
 *
 * - fully flattens all raw properties joining nested objects with underscores
 * - reconstructs abstract plaintext from inverted index
 * - normalizes authorships, locations, and identifiers
 * - populates missing fields with defensive nulls and empty arrays
 * - returns null when the input is not a work (no valid OpenAlex work id); never throws
 */
export function toWorkRecord(work: OpenAlexWork): WorkRecord | null {
    try {
        return buildRecord(work);
    } catch {
        return null; // hostile input: a throwing getter or Proxy
    }
}

// -------------------------------------------------------------------
// --- 4. Private Functions
// -------------------------------------------------------------------

/** Every non-blank string in an array. */
function strings(value: unknown): string[] {
    const out: string[] = [];
    for (const item of asArray(value)) {
        const text = asText(item);
        if (text !== null) {
            out.push(text);
        }
    }
    return out;
}

/** Lifts one string property from array of objects. */
function pluck(value: unknown, key: string): string[] {
    const out: string[] = [];
    for (const item of asArray(value)) {
        const text = asText(asObject(item)?.[key]);
        if (text !== null) {
            out.push(text);
        }
    }
    return out;
}

/** First non-empty candidate list, deduplicated. */
function firstNonEmpty(...candidates: readonly string[][]): string[] {
    for (const candidate of candidates) {
        if (candidate.length > 0) {
            return dedupe(candidate);
        }
    }
    return [];
}

function toAuthorPosition(value: unknown): AuthorRecord['position'] {
    const text = asText(value);
    for (const position of AUTHOR_POSITIONS) {
        if (position === text) {
            return position;
        }
    }
    return DEFAULT_AUTHOR_POSITION;
}

function toAuthorRecord(authorship: Bag): AuthorRecord | null {
    const author = asObject(authorship.author);
    const name = asText(author?.display_name) ?? asText(authorship.raw_author_name);
    if (name === null) {
        return null;
    }
    return {
        name,
        orcid: normalizeOrcid(author?.orcid) ?? normalizeOrcid(authorship.raw_orcid),
        position: toAuthorPosition(authorship.author_position),
        is_corresponding: asBoolean(authorship.is_corresponding),
        affiliations: firstNonEmpty(
            strings(authorship.raw_affiliation_strings),
            pluck(authorship.affiliations, 'raw_affiliation_string'),
            pluck(authorship.institutions, 'display_name'),
        ),
        countries: firstNonEmpty(strings(authorship.countries), pluck(authorship.institutions, 'country_code')),
    };
}

function toOaLocationRecord(location: Bag): OaLocationRecord {
    const source = asObject(location.source);
    return {
        doi: normalizeDoi(location.doi),
        landing_page_url: asText(location.landing_page_url),
        pdf_url: asText(location.pdf_url),
        license: asText(location.license),
        version: asText(location.version),
        source_name: asText(source?.display_name) ?? asText(location.raw_source_name),
        source_type: asText(source?.type) ?? asText(location.raw_type),
        is_published: typeof location.is_published === 'boolean' ? location.is_published : null,
    };
}

/** Formats pagination page range or single page. */
function toPages(first: string | null, last: string | null): string | null {
    if (first !== null && last !== null) {
        return first === last ? first : `${first}${PAGE_RANGE_SEPARATOR}${last}`;
    }
    return first ?? last;
}

function deriveFields(work: unknown): DerivedFields {
    const w: Bag = asObject(work) ?? {};
    const biblio = asObject(w.biblio);
    const primaryLocation = asObject(w.primary_location);
    const primarySource = asObject(primaryLocation?.source);

    const locations = asArray(w.locations);
    const oaList = locations
        .map(asObject)
        .filter((location): location is Bag => location !== null && asBoolean(location.is_oa))
        .map(toOaLocationRecord);

    const authorsDetailedList = asArray(w.authorships)
        .map(asObject)
        .filter((authorship): authorship is Bag => authorship !== null)
        .map(toAuthorRecord)
        .filter((author): author is AuthorRecord => author !== null);

    const authors = authorsDetailedList.map((author) => author.name);
    const declaresFirst = asArray(w.authorships).some(
        (authorship) => asText(asObject(authorship)?.author_position) === 'first',
    );

    const first = asText(biblio?.first_page);
    const last = asText(biblio?.last_page);
    const funders = dedupe(pluck(w.funders, 'display_name'));

    return {
        abstract: reconstructAbstract(w.abstract_inverted_index as AbstractInvertedIndex | null),
        authors,
        authors_detailed: authorsDetailedList,
        first_author:
            authorsDetailedList.find((author) => author.position === 'first')?.name ??
            (declaresFirst ? null : (authors[0] ?? null)),
        journal: asText(primarySource?.display_name) ?? asText(primaryLocation?.raw_source_name),
        source_type: asText(primarySource?.type) ?? asText(primaryLocation?.raw_type),
        pages: toPages(first, last),
        oa_locations: oaList,
        keyword_names: dedupe(pluck(w.keywords, 'display_name')),
        topic_names: dedupe(pluck(w.topics, 'display_name')),
        mesh_terms: dedupe(pluck(w.mesh, 'descriptor_name')),
        funder_names: funders.length > 0 ? funders : dedupe(pluck(w.awards, 'funder_display_name')),
    };
}

function buildRecord(work: unknown): WorkRecord | null {
    const flat = flatten(WORK_SCHEMA, work);
    if (flat.id === null) {
        return null;
    }
    return { ...flat, ...deriveFields(work) } as WorkRecord;
}
