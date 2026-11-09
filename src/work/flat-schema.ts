// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { normalizeOrcid, normalizeRor, normalizeWikidata, stripOpenAlexUrl } from '../identifiers/bare-ids.js';
import { normalizeDoi } from '../identifiers/doi.js';
import { normalizePmcid, normalizePmid } from '../identifiers/pubmed.js';
import { normalizeWorkId } from '../identifiers/work-id.js';
import { asArray, asBoolean, asIdentifier, asNumber, asObject, asText } from '../utils/values.js';

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

export type Leaf =
    | 'workId'
    | 'workIds'
    | 'text'
    | 'textId'
    | 'number'
    | 'bool'
    | 'boolOrNull'
    | 'texts'
    | 'ref'
    | 'refs'
    | 'doi'
    | 'pmid'
    | 'pmcid'
    | 'orcid'
    | 'orcids'
    | 'ror'
    | 'wikidata';

export type ObjNode = { readonly kind: 'obj'; readonly nullable: boolean; readonly children: Schema };
export type ListNode = { readonly kind: 'list'; readonly children: Schema };
export type Schema = { readonly [key: string]: Leaf | ObjNode | ListNode };

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

/** `workId` is non-null only at the top level (`id`), where toWorkRecord guarantees it; elsewhere it can be null. */
type LeafType<L, N extends boolean, P extends string> = L extends 'workId'
    ? P extends ''
        ? string
        : string | null
    : L extends 'number'
      ? number | null
      : L extends 'bool'
        ? N extends true
            ? boolean | null
            : boolean
        : L extends 'boolOrNull'
          ? boolean | null
          : L extends 'workIds' | 'texts' | 'refs' | 'orcids'
            ? readonly string[]
            : string | null;

export type FlatOf<S, P extends string = '', N extends boolean = false> = UnionToIntersection<
    {
        [K in keyof S & string]: S[K] extends {
            kind: 'obj';
            nullable: infer NullableChild extends boolean;
            children: infer C;
        }
            ? FlatOf<C, `${P}${K}_`, N extends true ? true : NullableChild>
            : S[K] extends { kind: 'list'; children: infer C }
              ? { readonly [Q in `${P}${K}`]: readonly Simplify<FlatOf<C>>[] }
              : { readonly [Q in `${P}${K}`]: LeafType<S[K], N, P> };
    }[keyof S & string]
>;

// -------------------------------------------------------------------
// --- 2. Constants
// -------------------------------------------------------------------

export const INSTITUTION = {
    id: 'ref',
    display_name: 'text',
    ror: 'ror',
    country_code: 'text',
    type: 'text',
    lineage: 'refs',
} as const;

export const SOURCE = {
    id: 'ref',
    display_name: 'text',
    issn_l: 'text',
    issn: 'texts',
    is_oa: 'bool',
    is_in_doaj: 'bool',
    is_core: 'bool',
    host_organization: 'ref',
    host_organization_name: 'text',
    host_organization_lineage: 'refs',
    host_organization_lineage_names: 'texts',
    type: 'text',
    listed_in: 'texts',
} as const;

export const LOCATION = {
    id: 'text',
    doi: 'doi',
    is_oa: 'bool',
    landing_page_url: 'text',
    pdf_url: 'text',
    source: obj(SOURCE, true),
    license: 'text',
    license_id: 'ref',
    version: 'text',
    is_accepted: 'bool',
    is_published: 'boolOrNull',
    raw_source_name: 'text',
    raw_type: 'text',
} as const;

export const TOPIC_LEVEL = { id: 'ref', display_name: 'text' } as const;

export const TOPIC = {
    id: 'ref',
    display_name: 'text',
    score: 'number',
    subfield: obj(TOPIC_LEVEL),
    field: obj(TOPIC_LEVEL),
    domain: obj(TOPIC_LEVEL),
} as const;

export const APC = { value: 'number', currency: 'text', value_usd: 'number', provenance: 'text' } as const;

export const WORK_SCHEMA = {
    /** Top level only: toWorkRecord rejects a work without a valid id, so it is never null. */
    id: 'workId',
    doi: 'doi',
    ids: obj({ openalex: 'workId', doi: 'doi', mag: 'textId', pmid: 'pmid', pmcid: 'pmcid' }),
    title: 'text',
    display_name: 'text',
    publication_year: 'number',
    publication_date: 'text',
    language: 'text',
    type: 'text',
    indexed_in: 'texts',
    biblio: obj({ volume: 'text', issue: 'text', first_page: 'text', last_page: 'text' }),
    volume: obj({ id: 'workId', display_name: 'text' }, true),
    authorships: list({
        author_position: 'text',
        author: obj({ id: 'ref', display_name: 'text', orcid: 'orcid', observed_orcids: 'orcids' }),
        institutions: list(INSTITUTION),
        countries: 'texts',
        is_corresponding: 'bool',
        raw_author_name: 'text',
        raw_affiliation_strings: 'texts',
        raw_orcid: 'orcid',
        affiliations: list({ raw_affiliation_string: 'text', institution_ids: 'refs' }),
    }),
    institutions: list(INSTITUTION),
    countries_distinct_count: 'number',
    institutions_distinct_count: 'number',
    corresponding_author_ids: 'refs',
    corresponding_institution_ids: 'refs',
    primary_location: obj(LOCATION, true),
    best_oa_location: obj(LOCATION, true),
    locations: list(LOCATION),
    locations_count: 'number',
    open_access: obj({ is_oa: 'bool', oa_status: 'text', oa_url: 'text', any_repository_has_fulltext: 'bool' }),
    apc_list: obj(APC, true),
    apc_paid: obj(APC, true),
    fwci: 'number',
    cited_by_count: 'number',
    citation_normalized_percentile: obj(
        { value: 'number', is_in_top_1_percent: 'bool', is_in_top_10_percent: 'bool' },
        true,
    ),
    cited_by_percentile_year: obj({ min: 'number', max: 'number' }, true),
    counts_by_year: list({ year: 'number', cited_by_count: 'number' }),
    referenced_works_count: 'number',
    referenced_works: 'workIds',
    related_works: 'workIds',
    has_fulltext: 'bool',
    is_retracted: 'bool',
    is_paratext: 'bool',
    is_traditional: 'bool',
    is_xpac: 'bool',
    primary_topic: obj(TOPIC, true),
    topics: list(TOPIC),
    keywords: list({ id: 'ref', display_name: 'text', score: 'number' }),
    concepts: list({ id: 'ref', wikidata: 'wikidata', display_name: 'text', level: 'number', score: 'number' }),
    mesh: list({
        descriptor_ui: 'text',
        descriptor_name: 'text',
        qualifier_ui: 'text',
        qualifier_name: 'text',
        is_major_topic: 'bool',
    }),
    sustainable_development_goals: list({ id: 'text', display_name: 'text', score: 'number' }),
    study_designs: list({ id: 'ref', display_name: 'text' }),
    awards: list({
        id: 'ref',
        display_name: 'text',
        funder_award_id: 'text',
        funder_id: 'ref',
        funder_display_name: 'text',
    }),
    funders: list({ id: 'ref', display_name: 'text', ror: 'ror' }),
    has_content: obj({ pdf: 'bool', grobid_xml: 'bool' }),
    content_urls: obj({ pdf: 'text', grobid_xml: 'text' }, true),
    updated_date: 'text',
    created_date: 'text',
} as const satisfies Schema;

const LEAF_READERS: { readonly [L in Leaf]: (raw: unknown) => unknown } = {
    workId: (raw) => normalizeWorkId(raw),
    workIds: (raw) => compact(raw, normalizeWorkId),
    text: asText,
    textId: asIdentifier,
    number: asNumber,
    bool: asBoolean,
    boolOrNull: (raw) => (typeof raw === 'boolean' ? raw : null),
    texts: (raw) => compact(raw, asText),
    ref: stripOpenAlexUrl,
    refs: (raw) => compact(raw, stripOpenAlexUrl),
    doi: normalizeDoi,
    pmid: normalizePmid,
    pmcid: normalizePmcid,
    orcid: normalizeOrcid,
    orcids: (raw) => compact(raw, normalizeOrcid),
    ror: normalizeRor,
    wikidata: normalizeWikidata,
};

const ARRAY_LEAVES: ReadonlySet<Leaf> = new Set<Leaf>(['workIds', 'texts', 'refs', 'orcids']);

// -------------------------------------------------------------------
// --- 3. Exported Functions
// -------------------------------------------------------------------

/**
 * **Flatten by schema**: emits every schema key, joining nested object keys with `_`.
 *
 * - missing or non-object value is read as `{}`
 * - null or missing nullable object yields null scalars and empty arrays for all its children
 * - lists remain arrays with each element flattened by the same rule
 */
export function flatten(schema: Schema, value: unknown): Record<string, unknown> {
    return flattenInto(schema, asObject(value) ?? {}, '', {});
}

// -------------------------------------------------------------------
// --- 4. Private Functions
// -------------------------------------------------------------------

/** Overloads keep `nullable` a literal type; FlatOf reads it to type children under a nullable parent. */
function obj<C extends Schema>(children: C): { readonly kind: 'obj'; readonly nullable: false; readonly children: C };
function obj<C extends Schema>(
    children: C,
    nullable: true,
): { readonly kind: 'obj'; readonly nullable: true; readonly children: C };
function obj<C extends Schema>(children: C, nullable = false): ObjNode {
    return { kind: 'obj', nullable, children };
}

function list<C extends Schema>(children: C) {
    return { kind: 'list', children } as const;
}

/** A null bag means the parent object is null: scalars become null and arrays []. */
function flattenInto(
    schema: Schema,
    bag: Record<string, unknown> | null,
    prefix: string,
    out: Record<string, unknown>,
): Record<string, unknown> {
    for (const [key, node] of Object.entries(schema)) {
        const fullKey = `${prefix}${key}`;
        const raw = bag === null ? undefined : bag[key];
        if (typeof node === 'string') {
            out[fullKey] = bag !== null ? LEAF_READERS[node](raw) : ARRAY_LEAVES.has(node) ? [] : null;
        } else if (node.kind === 'obj') {
            const child = bag === null ? null : (asObject(raw) ?? (node.nullable ? null : {}));
            flattenInto(node.children, child, `${fullKey}_`, out);
        } else {
            out[fullKey] = asArray(raw).map((item) => flattenInto(node.children, asObject(item) ?? {}, '', {}));
        }
    }
    return out;
}

/** Maps array elements, drops nulls and duplicates in first-occurrence order; non-arrays become []. */
function compact(value: unknown, read: (item: unknown) => string | null): string[] {
    const seen = new Set<string>();
    for (const item of asArray(value)) {
        const text = read(item);
        if (text !== null) {
            seen.add(text);
        }
    }
    return [...seen];
}
