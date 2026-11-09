// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import type { RenameMap } from './rename.js';

// -------------------------------------------------------------------
// --- 1. Constants
// -------------------------------------------------------------------

/**
 * **Shared semantic map**: rename map from field names shared with smart-ris records to canonical WorkRecord fields.
 *
 * - pass as `rename` to receive records under shared names; unmapped fields keep canonical names
 * - identity entries (`doi`, `title`, …) list shared fields OpenAlex delivers under the same name
 * - `keywords` holds keyword names; keyword objects move to `keywords_detailed`, matching `authors_detailed`
 * - shared fields OpenAlex has no value for (`wos_ut`, `article_number`, `isbn`) are absent
 */
export const SEMANTIC_MAP = {
    doi: 'doi',
    pmid: 'ids_pmid',
    openalex_id: 'id',
    title: 'title',
    abstract: 'abstract',
    authors: 'authors',
    keywords: 'keyword_names',
    keywords_detailed: 'keywords',
    language: 'language',
    year: 'publication_year',
    publication_date: 'publication_date',
    container_title: 'journal',
    volume: 'biblio_volume',
    issue: 'biblio_issue',
    pages: 'pages',
    publisher: 'primary_location_source_host_organization_name',
    issn: 'primary_location_source_issn',
    url: 'primary_location_landing_page_url',
    pdf_url: 'best_oa_location_pdf_url',
    is_oa: 'open_access_is_oa',
    version_type: 'primary_location_version',
} as const satisfies RenameMap;
