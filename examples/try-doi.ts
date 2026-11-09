// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

/**
 * **Playground for single-DOI lookup**: calls real API.
 *
 * - `bun run try` fetches default DOI
 * - `bun run try 10.1371/journal.pone.0000308` fetches given DOI
 * - `bun run try 10.1038/nature12373 --raw` prints raw API response
 * - reads optional `OPENALEX_API_KEY` from environment
 */
import { createOpenAlex } from '../src/index.js';

// -------------------------------------------------------------------
// --- 1. Constants
// -------------------------------------------------------------------

const args = Bun.argv.slice(2).filter((arg) => arg !== '--raw');
const DOI = args[0] ?? '10.1038/nature12373';
const API_KEY = (Bun.env.OPENALEX_API_KEY ?? '').trim();
const SHOW_RAW = Bun.argv.includes('--raw');

// -------------------------------------------------------------------
// --- 2. Private Functions
// -------------------------------------------------------------------

function heading(text: string): void {
    console.log(`\n\x1b[1m${text}\x1b[0m`);
}

function line(label: string, value: unknown): void {
    const rendered =
        value === null || value === undefined
            ? '\x1b[2mnull\x1b[0m'
            : Array.isArray(value)
              ? value.length === 0
                  ? '\x1b[2m(empty)\x1b[0m'
                  : value.join(' · ')
              : String(value);
    console.log(`  ${label.padEnd(22)} ${rendered}`);
}

const started = Date.now();
const result = await createOpenAlex(API_KEY === '' ? {} : { apiKey: API_KEY }).fetchDoi(DOI);
const elapsed = Date.now() - started;

if (!result.ok) {
    heading(`✗ ${result.error.code}  (${elapsed}ms)`);
    line('message', result.error.message);
    line('status', result.error.status);
    line('retryAfterSeconds', result.error.retryAfterSeconds);
    console.log('\nNothing was thrown — this is an ordinary return value.\n');
} else {
    const { record: data, raw } = result.data;

    heading(`✓ ${data.title ?? '(untitled)'}  (${elapsed}ms)`);

    heading('identifiers');
    line('id', data.id);
    line('doi', data.doi);
    line('ids_pmid', data.ids_pmid);
    line('ids_pmcid', data.ids_pmcid);

    heading('bibliographic');
    line('type', data.type);
    line('language', data.language);
    line('publication_year', data.publication_year);
    line('publication_date', data.publication_date);
    line('journal', data.journal);
    line('source_type', data.source_type);
    line('publisher', data.primary_location_source_host_organization_name);
    line('issn', [...data.primary_location_source_issn]);
    line('issn_l', data.primary_location_source_issn_l);
    line('volume / issue', `${data.biblio_volume ?? '—'} / ${data.biblio_issue ?? '—'}`);
    line('pages', data.pages);

    heading(`authors (${data.authors.length})`);
    line('first_author', data.first_author);
    for (const author of data.authors_detailed) {
        const marks = [author.position, author.is_corresponding ? 'corresponding' : null]
            .filter((mark) => mark !== null)
            .join(', ');
        line(`  ${author.name ?? '(unnamed)'}`, `[${marks}] ${author.countries.join(', ')}`);
    }

    heading('open access & content');
    line('is_oa / oa_status', `${data.open_access_is_oa} / ${data.open_access_oa_status ?? '—'}`);
    line('has_content_pdf', data.has_content_pdf);
    line('has_content_grobid_xml', data.has_content_grobid_xml);
    line('oa_url', data.open_access_oa_url);
    line('pdf_url', data.best_oa_location_pdf_url);
    line('landing_page_url', data.best_oa_location_landing_page_url);
    line('license / version', `${data.best_oa_location_license ?? '—'} / ${data.best_oa_location_version ?? '—'}`);
    line('oa_locations', data.oa_locations.length);
    for (const location of data.oa_locations) {
        line(`  ${location.source_name ?? '(unknown source)'}`, location.pdf_url ?? location.landing_page_url);
    }

    heading('metrics & classification');
    line('cited_by_count', data.cited_by_count);
    line('referenced_works_count', data.referenced_works_count);
    line('fwci', data.fwci);
    line('is_retracted', data.is_retracted);
    line('is_paratext', data.is_paratext);
    line('is_xpac', data.is_xpac);
    line('primary_topic', data.primary_topic_display_name);
    line('topic_names', [...data.topic_names]);
    line('keyword_names', [...data.keyword_names]);
    line('mesh_terms', [...data.mesh_terms]);
    line('funder_names', [...data.funder_names]);

    heading('abstract');
    console.log(
        data.abstract === null ? '  \x1b[2m(none — OpenAlex has no inverted index)\x1b[0m' : `  ${data.abstract}`,
    );

    heading('provenance');
    line('updated_date', data.updated_date);
    line('created_date', data.created_date);
    line('raw keys', Object.keys(raw).length);

    if (SHOW_RAW) {
        heading('raw (untouched API response)');
        console.log(JSON.stringify(raw, null, 2));
    }
    console.log('');
}
