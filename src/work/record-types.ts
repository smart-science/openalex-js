// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import type {
    Apc,
    Authorship,
    AuthorshipAffiliation,
    Award,
    Biblio,
    CitationNormalizedPercentile,
    CitedByPercentileYear,
    Concept,
    ContentUrls,
    CountsByYear,
    DehydratedAuthor,
    DehydratedInstitution,
    DehydratedSource,
    Funder,
    HasContent,
    Keyword,
    MeshTag,
    OpenAccess,
    OpenAlexWork,
    StudyDesign,
    SustainableDevelopmentGoal,
    Topic,
    TopicHierarchyEntry,
    WorkIds,
    WorkLocation,
    WorkVolume,
} from './api-types.js';
import type { APC, FlatOf, INSTITUTION, LOCATION, SOURCE, TOPIC, TOPIC_LEVEL, WORK_SCHEMA } from './flat-schema.js';

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** Canonical authorship record. */
export type AuthorRecord = {
    readonly name: string;
    readonly orcid: string | null;
    readonly position: 'first' | 'middle' | 'last';
    readonly is_corresponding: boolean;
    readonly affiliations: readonly string[];
    readonly countries: readonly string[];
};

/** Canonical open-access location record. */
export type OaLocationRecord = {
    /** Location's own DOI, which can differ from work's DOI. */
    readonly doi: string | null;
    readonly landing_page_url: string | null;
    readonly pdf_url: string | null;
    readonly license: string | null;
    readonly version: string | null;
    readonly source_name: string | null;
    readonly source_type: string | null;
    readonly is_published: boolean | null;
};

/** Derived convenience fields appended to the flattened record. */
export type DerivedFields = {
    readonly abstract: string | null;
    readonly authors: readonly string[];
    readonly authors_detailed: readonly AuthorRecord[];
    readonly first_author: string | null;
    readonly journal: string | null;
    readonly source_type: string | null;
    readonly pages: string | null;
    readonly oa_locations: readonly OaLocationRecord[];
    readonly keyword_names: readonly string[];
    readonly topic_names: readonly string[];
    readonly mesh_terms: readonly string[];
    readonly funder_names: readonly string[];
};

/** Canonical flattened WorkRecord data shape. */
export type WorkRecord = Simplify<FlatOf<typeof WORK_SCHEMA> & DerivedFields>;

/** Flattened elements inside arrays. */
export type FlatAuthorship = WorkRecord['authorships'][number];
export type FlatAffiliation = FlatAuthorship['affiliations'][number];
export type FlatInstitution = WorkRecord['institutions'][number];
export type FlatLocation = WorkRecord['locations'][number];
export type FlatTopic = WorkRecord['topics'][number];
export type FlatKeyword = WorkRecord['keywords'][number];
export type FlatConcept = WorkRecord['concepts'][number];
export type FlatMesh = WorkRecord['mesh'][number];
export type FlatSdg = WorkRecord['sustainable_development_goals'][number];
export type FlatAward = WorkRecord['awards'][number];
export type FlatFunder = WorkRecord['funders'][number];
export type FlatCountsByYear = WorkRecord['counts_by_year'][number];

/** Every valid source name for a rename map. */
export type FieldName = keyof WorkRecord;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/** Compile-time proof that FIELD_NAMES exhaustively covers FieldName. */
export type FieldNamesAreExhaustive = Assert<Equal<FieldName, (typeof FIELD_NAMES)[number]>>;

/** Compile-time proof that derived keys do not collide with flattened schema keys. */
export type DerivedDoNotCollide = Assert<Equal<Extract<keyof DerivedFields, keyof FlatOf<typeof WORK_SCHEMA>>, never>>;

type SelectOnlyKeys =
    | 'relevance_score'
    | 'sources'
    | 'type_crossref'
    | 'institution_assertions'
    | 'is_authors_truncated'
    | 'fulltext_origin'
    | 'datasets'
    | 'versions'
    | 'cited_by_api_url';
type ExpectedTopLevel = Exclude<
    keyof OpenAlexWork,
    SelectOnlyKeys | 'abstract_inverted_index' | 'sustainable_development_goals_aurora'
>;

/** Compile-time proof that WORK_SCHEMA covers all upstream non-select work properties. */
export type SchemaTopLevelIsExhaustive = Assert<Equal<keyof typeof WORK_SCHEMA, ExpectedTopLevel>>;

/** Compile-time proof that each nested schema exhaustively covers its corresponding upstream type. */
export type SchemaNestedIsExhaustive = [
    Assert<Equal<keyof (typeof WORK_SCHEMA)['ids']['children'], keyof WorkIds>>,
    Assert<Equal<keyof (typeof WORK_SCHEMA)['biblio']['children'], keyof Biblio>>,
    Assert<Equal<keyof (typeof WORK_SCHEMA)['volume']['children'], keyof WorkVolume>>,
    Assert<Equal<keyof (typeof WORK_SCHEMA)['study_designs']['children'], keyof StudyDesign>>,
    Assert<Equal<keyof (typeof WORK_SCHEMA)['authorships']['children'], keyof Authorship>>,
    Assert<Equal<keyof (typeof WORK_SCHEMA)['authorships']['children']['author']['children'], keyof DehydratedAuthor>>,
    Assert<Equal<keyof typeof INSTITUTION, keyof DehydratedInstitution>>,
    Assert<
        Equal<
            keyof (typeof WORK_SCHEMA)['authorships']['children']['affiliations']['children'],
            keyof AuthorshipAffiliation
        >
    >,
    Assert<Equal<keyof typeof LOCATION, keyof WorkLocation>>,
    Assert<Equal<keyof typeof SOURCE, keyof DehydratedSource>>,
    Assert<Equal<keyof (typeof WORK_SCHEMA)['open_access']['children'], keyof OpenAccess>>,
    Assert<Equal<keyof typeof APC, keyof Apc>>,
    Assert<
        Equal<
            keyof (typeof WORK_SCHEMA)['citation_normalized_percentile']['children'],
            keyof CitationNormalizedPercentile
        >
    >,
    Assert<Equal<keyof (typeof WORK_SCHEMA)['cited_by_percentile_year']['children'], keyof CitedByPercentileYear>>,
    Assert<Equal<keyof typeof TOPIC, keyof Topic>>,
    Assert<Equal<keyof typeof TOPIC_LEVEL, keyof TopicHierarchyEntry>>,
    Assert<Equal<keyof (typeof WORK_SCHEMA)['keywords']['children'], keyof Keyword>>,
    Assert<Equal<keyof (typeof WORK_SCHEMA)['concepts']['children'], keyof Concept>>,
    Assert<Equal<keyof (typeof WORK_SCHEMA)['mesh']['children'], keyof MeshTag>>,
    Assert<
        Equal<keyof (typeof WORK_SCHEMA)['sustainable_development_goals']['children'], keyof SustainableDevelopmentGoal>
    >,
    Assert<Equal<keyof (typeof WORK_SCHEMA)['awards']['children'], keyof Award>>,
    Assert<Equal<keyof (typeof WORK_SCHEMA)['funders']['children'], keyof Funder>>,
    Assert<Equal<keyof (typeof WORK_SCHEMA)['has_content']['children'], keyof HasContent>>,
    Assert<Equal<keyof (typeof WORK_SCHEMA)['content_urls']['children'], keyof ContentUrls>>,
    Assert<Equal<keyof (typeof WORK_SCHEMA)['counts_by_year']['children'], keyof CountsByYear>>,
];

// -------------------------------------------------------------------
// --- 2. Constants
// -------------------------------------------------------------------

/** Array of all canonical WorkRecord field names. */
export const FIELD_NAMES = [
    // Top-level schema scalar / primitives
    'id',
    'doi',
    'title',
    'display_name',
    'publication_year',
    'publication_date',
    'language',
    'type',
    'indexed_in',
    'countries_distinct_count',
    'institutions_distinct_count',
    'corresponding_author_ids',
    'corresponding_institution_ids',
    'locations_count',
    'fwci',
    'cited_by_count',
    'referenced_works_count',
    'referenced_works',
    'related_works',
    'has_fulltext',
    'is_retracted',
    'is_paratext',
    'is_traditional',
    'is_xpac',
    'updated_date',
    'created_date',
    // Top-level schema lists
    'authorships',
    'institutions',
    'locations',
    'counts_by_year',
    'topics',
    'keywords',
    'concepts',
    'mesh',
    'sustainable_development_goals',
    'study_designs',
    'awards',
    'funders',
    // Flattened ids
    'ids_openalex',
    'ids_doi',
    'ids_mag',
    'ids_pmid',
    'ids_pmcid',
    // Flattened biblio
    'biblio_volume',
    'biblio_issue',
    'biblio_first_page',
    'biblio_last_page',
    // Flattened volume (the containing work)
    'volume_id',
    'volume_display_name',
    // Flattened primary_location
    'primary_location_id',
    'primary_location_doi',
    'primary_location_is_oa',
    'primary_location_landing_page_url',
    'primary_location_pdf_url',
    'primary_location_source_id',
    'primary_location_source_display_name',
    'primary_location_source_issn_l',
    'primary_location_source_issn',
    'primary_location_source_is_oa',
    'primary_location_source_is_in_doaj',
    'primary_location_source_is_core',
    'primary_location_source_host_organization',
    'primary_location_source_host_organization_name',
    'primary_location_source_host_organization_lineage',
    'primary_location_source_host_organization_lineage_names',
    'primary_location_source_type',
    'primary_location_source_listed_in',
    'primary_location_license',
    'primary_location_license_id',
    'primary_location_version',
    'primary_location_is_accepted',
    'primary_location_is_published',
    'primary_location_raw_source_name',
    'primary_location_raw_type',
    // Flattened best_oa_location
    'best_oa_location_id',
    'best_oa_location_doi',
    'best_oa_location_is_oa',
    'best_oa_location_landing_page_url',
    'best_oa_location_pdf_url',
    'best_oa_location_source_id',
    'best_oa_location_source_display_name',
    'best_oa_location_source_issn_l',
    'best_oa_location_source_issn',
    'best_oa_location_source_is_oa',
    'best_oa_location_source_is_in_doaj',
    'best_oa_location_source_is_core',
    'best_oa_location_source_host_organization',
    'best_oa_location_source_host_organization_name',
    'best_oa_location_source_host_organization_lineage',
    'best_oa_location_source_host_organization_lineage_names',
    'best_oa_location_source_type',
    'best_oa_location_source_listed_in',
    'best_oa_location_license',
    'best_oa_location_license_id',
    'best_oa_location_version',
    'best_oa_location_is_accepted',
    'best_oa_location_is_published',
    'best_oa_location_raw_source_name',
    'best_oa_location_raw_type',
    // Flattened open_access
    'open_access_is_oa',
    'open_access_oa_status',
    'open_access_oa_url',
    'open_access_any_repository_has_fulltext',
    // Flattened apc_list & apc_paid
    'apc_list_value',
    'apc_list_currency',
    'apc_list_value_usd',
    'apc_list_provenance',
    'apc_paid_value',
    'apc_paid_currency',
    'apc_paid_value_usd',
    'apc_paid_provenance',
    // Flattened citation_normalized_percentile
    'citation_normalized_percentile_value',
    'citation_normalized_percentile_is_in_top_1_percent',
    'citation_normalized_percentile_is_in_top_10_percent',
    // Flattened cited_by_percentile_year
    'cited_by_percentile_year_min',
    'cited_by_percentile_year_max',
    // Flattened primary_topic
    'primary_topic_id',
    'primary_topic_display_name',
    'primary_topic_score',
    'primary_topic_subfield_id',
    'primary_topic_subfield_display_name',
    'primary_topic_field_id',
    'primary_topic_field_display_name',
    'primary_topic_domain_id',
    'primary_topic_domain_display_name',
    // Flattened has_content
    'has_content_pdf',
    'has_content_grobid_xml',
    // Flattened content_urls
    'content_urls_pdf',
    'content_urls_grobid_xml',
    // Derived fields
    'abstract',
    'authors',
    'authors_detailed',
    'first_author',
    'journal',
    'source_type',
    'pages',
    'oa_locations',
    'keyword_names',
    'topic_names',
    'mesh_terms',
    'funder_names',
] as const satisfies readonly FieldName[];

const FIELD_NAME_SET: ReadonlySet<string> = new Set<string>(FIELD_NAMES);

// -------------------------------------------------------------------
// --- 3. Exported Functions
// -------------------------------------------------------------------

/** Runtime membership test for canonical FieldName. */
export function isFieldName(value: unknown): value is FieldName {
    return typeof value === 'string' && FIELD_NAME_SET.has(value);
}
