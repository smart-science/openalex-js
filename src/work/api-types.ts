// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

/** Documented union widened so new upstream values never break compilation. */
type Open<T extends string> = T | (string & {});

export type WorkType = Open<
    | 'article'
    | 'book'
    | 'book-chapter'
    | 'dataset'
    | 'dissertation'
    | 'editorial'
    | 'erratum'
    | 'grant'
    | 'letter'
    | 'libguides'
    | 'other'
    | 'paratext'
    | 'peer-review'
    | 'preprint'
    | 'reference-entry'
    | 'report'
    | 'retraction'
    | 'review'
    | 'standard'
    | 'supplementary-materials'
>;

export type OaStatus = Open<'diamond' | 'gold' | 'green' | 'bronze' | 'hybrid' | 'closed'>;

export type WorkVersion = 'publishedVersion' | 'acceptedVersion' | 'submittedVersion';

export type WorkIds = {
    readonly openalex: string;
    readonly doi?: string;
    readonly mag?: string;
    readonly pmid?: string;
    readonly pmcid?: string;
};

export type DehydratedAuthor = {
    readonly id: string;
    readonly display_name: string;
    readonly orcid: string | null;
    /** Every ORCID seen for this author across sources. */
    readonly observed_orcids?: readonly string[];
};

export type DehydratedInstitution = {
    readonly id: string;
    readonly display_name: string;
    readonly ror: string | null;
    readonly country_code: string | null;
    readonly type: string | null;
    readonly lineage: readonly string[];
};

export type DehydratedSource = {
    readonly id: string;
    readonly display_name: string;
    readonly issn_l: string | null;
    readonly issn: readonly string[] | null;
    readonly is_oa: boolean;
    readonly is_in_doaj: boolean;
    readonly is_core: boolean;
    readonly host_organization: string | null;
    readonly host_organization_name: string | null;
    readonly host_organization_lineage: readonly string[];
    readonly host_organization_lineage_names: readonly string[];
    readonly type: string;
    /** Curated journal lists the source appears on, e.g. "doaj". */
    readonly listed_in?: readonly string[];
};

export type AuthorshipAffiliation = {
    readonly raw_affiliation_string: string;
    readonly institution_ids: readonly string[];
};

export type Authorship = {
    readonly author_position: 'first' | 'middle' | 'last';
    readonly author: DehydratedAuthor;
    readonly institutions: readonly DehydratedInstitution[];
    readonly countries: readonly string[];
    readonly is_corresponding: boolean;
    readonly raw_author_name: string | null;
    readonly raw_affiliation_strings: readonly string[];
    readonly raw_orcid: string | null;
    readonly affiliations: readonly AuthorshipAffiliation[];
};

export type WorkLocation = {
    readonly id: string | null;
    /** Location's own DOI; a preprint or repository copy can differ from work's DOI. */
    readonly doi?: string | null;
    readonly is_oa: boolean;
    readonly landing_page_url: string | null;
    readonly pdf_url: string | null;
    readonly source: DehydratedSource | null;
    readonly license: string | null;
    readonly license_id: string | null;
    readonly version: WorkVersion | null;
    readonly is_accepted: boolean;
    readonly is_published: boolean | null;
    readonly raw_source_name: string | null;
    readonly raw_type: string | null;
};

export type OpenAccess = {
    readonly is_oa: boolean;
    readonly oa_status: OaStatus;
    readonly oa_url: string | null;
    readonly any_repository_has_fulltext: boolean;
};

export type Biblio = {
    readonly volume: string | null;
    readonly issue: string | null;
    readonly first_page: string | null;
    readonly last_page: string | null;
};

export type Apc = {
    readonly value: number;
    readonly currency: string;
    readonly value_usd: number;
    readonly provenance?: string;
};

export type CitationNormalizedPercentile = {
    readonly value: number;
    readonly is_in_top_1_percent: boolean;
    readonly is_in_top_10_percent: boolean;
};

export type CitedByPercentileYear = {
    readonly min: number;
    readonly max: number;
};

export type TopicHierarchyEntry = {
    readonly id: string;
    readonly display_name: string;
};

export type Topic = {
    readonly id: string;
    readonly display_name: string;
    readonly score: number;
    readonly subfield: TopicHierarchyEntry;
    readonly field: TopicHierarchyEntry;
    readonly domain: TopicHierarchyEntry;
};

export type Keyword = {
    readonly id: string;
    readonly display_name: string;
    readonly score: number;
};

/** Legacy OpenAlex concept entry; replaced upstream by `topics`. */
export type Concept = {
    readonly id: string;
    readonly wikidata: string | null;
    readonly display_name: string;
    readonly level: number;
    readonly score: number;
};

export type MeshTag = {
    readonly descriptor_ui: string;
    readonly descriptor_name: string;
    readonly qualifier_ui: string | null;
    readonly qualifier_name: string | null;
    readonly is_major_topic: boolean;
};

export type SustainableDevelopmentGoal = {
    readonly id: string;
    readonly display_name: string;
    readonly score: number;
};

export type Award = {
    readonly id: string;
    readonly display_name: string | null;
    readonly funder_award_id: string | null;
    readonly funder_id: string | null;
    readonly funder_display_name: string | null;
};

export type Funder = {
    readonly id: string;
    readonly display_name: string;
    readonly ror: string | null;
};

export type HasContent = {
    readonly grobid_xml: boolean;
    readonly pdf: boolean;
};

export type ContentUrls = {
    readonly pdf?: string;
    readonly grobid_xml?: string;
};

export type CountsByYear = {
    readonly year: number;
    readonly cited_by_count: number;
};

/** Containing work volume (e.g. book containing chapter). */
export type WorkVolume = {
    readonly id: string;
    readonly display_name: string;
};

export type StudyDesign = {
    readonly id: string;
    readonly display_name: string;
};

/** Inverted index mapping tokens to word positions. */
export type AbstractInvertedIndex = Readonly<Record<string, readonly number[]>>;

/** Complete OpenAlex work payload returned by GET /works/doi:{doi}. */
export type OpenAlexWork = {
    // identifiers
    readonly id: string;
    readonly doi: string | null;
    readonly ids: WorkIds;
    // bibliographic
    readonly title: string | null;
    readonly display_name: string | null;
    readonly publication_year: number | null;
    readonly publication_date: string | null;
    readonly language: string | null;
    readonly type: WorkType;
    readonly indexed_in: readonly string[];
    readonly biblio: Biblio;
    readonly volume?: WorkVolume | null;
    readonly abstract_inverted_index: AbstractInvertedIndex | null;
    // authorship
    readonly authorships: readonly Authorship[];
    readonly institutions: readonly DehydratedInstitution[];
    readonly countries_distinct_count: number;
    readonly institutions_distinct_count: number;
    readonly corresponding_author_ids: readonly string[];
    readonly corresponding_institution_ids: readonly string[];
    // locations & access
    readonly primary_location: WorkLocation | null;
    readonly best_oa_location: WorkLocation | null;
    readonly locations: readonly WorkLocation[];
    readonly locations_count: number;
    readonly open_access: OpenAccess;
    // charges
    readonly apc_list: Apc | null;
    readonly apc_paid: Apc | null;
    // metrics
    readonly fwci: number | null;
    readonly cited_by_count: number;
    readonly citation_normalized_percentile: CitationNormalizedPercentile | null;
    readonly cited_by_percentile_year: CitedByPercentileYear | null;
    readonly counts_by_year: readonly CountsByYear[];
    readonly referenced_works_count: number;
    readonly referenced_works: readonly string[];
    readonly related_works: readonly string[];
    // flags
    readonly has_fulltext: boolean;
    readonly is_retracted: boolean;
    readonly is_paratext: boolean;
    readonly is_traditional: boolean;
    /** Legacy OpenAlex flag; replaced upstream by `corpus`. */
    readonly is_xpac: boolean;
    // classification
    readonly primary_topic: Topic | null;
    readonly topics: readonly Topic[];
    readonly keywords: readonly Keyword[];
    /** Legacy OpenAlex concepts list; replaced upstream by `topics`. */
    readonly concepts: readonly Concept[];
    readonly mesh: readonly MeshTag[];
    readonly sustainable_development_goals: readonly SustainableDevelopmentGoal[];
    /** Legacy OpenAlex SDG field; kept in raw payload only. */
    readonly sustainable_development_goals_aurora?: readonly SustainableDevelopmentGoal[];
    readonly study_designs?: readonly StudyDesign[];
    // funding
    readonly awards: readonly Award[];
    readonly funders: readonly Funder[];
    // content
    readonly has_content: HasContent;
    readonly content_urls: ContentUrls | null;
    // provenance
    readonly updated_date: string;
    readonly created_date: string;

    // select-only: never present in default queries
    readonly relevance_score?: number;
    readonly sources?: readonly DehydratedSource[];
    readonly type_crossref?: string | null;
    readonly institution_assertions?: readonly DehydratedInstitution[];
    readonly is_authors_truncated?: boolean;
    readonly fulltext_origin?: string | null;
    readonly datasets?: readonly string[];
    readonly versions?: readonly string[];
    readonly cited_by_api_url?: string;
};
