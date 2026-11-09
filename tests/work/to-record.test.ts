// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import { asObject } from '../../src/utils/values.js';
import type { OpenAlexWork } from '../../src/work/api-types.js';
import { type Schema, WORK_SCHEMA } from '../../src/work/flat-schema.js';
import type { WorkRecord } from '../../src/work/record-types.js';
import { FIELD_NAMES, isFieldName } from '../../src/work/record-types.js';
import { toWorkRecord as shapeWork } from '../../src/work/to-record.js';
import { asWork, findUndefinedPaths, loadWork, loadWorkJson, stableJson, WORK_FIXTURE_NAMES } from '../helpers.js';

function toWorkRecord(work: OpenAlexWork): WorkRecord {
    const bag = asObject(work);
    const record = shapeWork(bag !== null && !('id' in bag) ? asWork({ id: 'W1', ...bag }) : work);
    if (record === null) {
        throw new Error('toWorkRecord rejected the work');
    }
    return record;
}

describe('WorkRecord shape', () => {
    test('FIELD_NAMES lists all 141 canonical fields', () => {
        expect(FIELD_NAMES).toHaveLength(141);
        expect(new Set(FIELD_NAMES).size).toBe(141);
    });

    test('FIELD_NAMES contains every documented field', () => {
        expect(([...FIELD_NAMES] as string[]).sort()).toEqual([...FIELD_NAMES].sort());
    });

    test('isFieldName accepts canonical names and rejects everything else', () => {
        for (const name of FIELD_NAMES) {
            expect(isFieldName(name), name).toBe(true);
        }
        for (const bad of [
            'titel',
            'jahr',
            '',
            'Title',
            '__proto__',
            'toString',
            'constructor',
            'openalexId',
            'doiUrl',
        ]) {
            expect(isFieldName(bad), bad).toBe(false);
        }
    });

    test('isFieldName never throws on non-string input', () => {
        for (const bad of [undefined, null, 42, {}, [], true, () => 'title']) {
            expect(() => isFieldName(bad)).not.toThrow();
            expect(isFieldName(bad)).toBe(false);
        }
    });

    test('every fixture produces exactly the canonical key set — no more, no less', async () => {
        for (const name of WORK_FIXTURE_NAMES) {
            const record = toWorkRecord(await loadWork(name));
            expect(Object.keys(record).sort(), name).toEqual([...FIELD_NAMES].sort());
        }
    });
});

describe('completeness across all four fixtures', () => {
    const SELECT_ONLY_KEYS = new Set([
        'relevance_score',
        'sources',
        'type_crossref',
        'institution_assertions',
        'is_authors_truncated',
        'fulltext_origin',
        'datasets',
        'versions',
        'cited_by_api_url',
        'abstract_inverted_index',
    ]);

    function assertLeafKeysPresent(raw: Record<string, unknown>, record: Record<string, unknown>, fixtureName: string) {
        function checkRaw(obj: Record<string, unknown>, prefix: string, schemaSub: Schema) {
            for (const [key, value] of Object.entries(obj)) {
                if (prefix === '' && SELECT_ONLY_KEYS.has(key)) {
                    continue;
                }
                const path = prefix ? `${prefix}_${key}` : key;
                const schemaNode = schemaSub[key];

                if (schemaNode && typeof schemaNode === 'object' && schemaNode.kind === 'obj') {
                    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                        checkRaw(value as Record<string, unknown>, path, schemaNode.children);
                    } else {
                        // value is null or missing; assert that children exist in flat record
                        for (const childKey of Object.keys(schemaNode.children)) {
                            const childPath = `${path}_${childKey}`;
                            const childNode = schemaNode.children[childKey];
                            if (typeof childNode === 'object' && childNode.kind === 'obj') {
                                for (const grandKey of Object.keys(childNode.children)) {
                                    expect(
                                        `${childPath}_${grandKey}` in record,
                                        `${fixtureName}: ${childPath}_${grandKey} must exist`,
                                    ).toBe(true);
                                }
                            } else {
                                expect(childPath in record, `${fixtureName}: ${childPath} must exist`).toBe(true);
                            }
                        }
                    }
                } else if (schemaNode && typeof schemaNode === 'object' && schemaNode.kind === 'list') {
                    expect(path in record, `${fixtureName}: array ${path} must exist in record`).toBe(true);
                    const recordArr = record[path];
                    if (Array.isArray(value) && Array.isArray(recordArr) && value.length > 0) {
                        for (let i = 0; i < Math.min(value.length, 3); i++) {
                            const rawElem = value[i];
                            const recElem = recordArr[i];
                            if (
                                typeof rawElem === 'object' &&
                                rawElem !== null &&
                                typeof recElem === 'object' &&
                                recElem !== null
                            ) {
                                checkElem(
                                    rawElem as Record<string, unknown>,
                                    recElem as Record<string, unknown>,
                                    `${path}[${i}]`,
                                    schemaNode.children,
                                );
                            }
                        }
                    }
                } else {
                    expect(path in record, `${fixtureName}: leaf ${path} must exist in record`).toBe(true);
                }
            }
        }

        function checkElem(
            rawObj: Record<string, unknown>,
            recObj: Record<string, unknown>,
            elemPrefix: string,
            itemSchema: Schema,
        ) {
            for (const [key, value] of Object.entries(rawObj)) {
                const subNode = itemSchema[key];
                if (subNode && typeof subNode === 'object' && subNode.kind === 'obj') {
                    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                        for (const childKey of Object.keys(value as Record<string, unknown>)) {
                            expect(
                                `${key}_${childKey}` in recObj,
                                `${fixtureName}: ${elemPrefix}.${key}_${childKey} must exist`,
                            ).toBe(true);
                        }
                    }
                } else {
                    expect(key in recObj, `${fixtureName}: ${elemPrefix}.${key} must exist`).toBe(true);
                }
            }
        }

        checkRaw(raw, '', WORK_SCHEMA);
    }

    for (const name of WORK_FIXTURE_NAMES) {
        test(`all raw leaves in ${name} map to flat record`, async () => {
            const raw = (await loadWorkJson(name)) as Record<string, unknown>;
            const record = toWorkRecord(asWork(raw)) as unknown as Record<string, unknown>;
            assertLeafKeysPresent(raw, record, name);
        });
    }
});

describe('fixture work-article (journal article, bronze OA)', () => {
    test('exact values of the core fields', async () => {
        const raw = await loadWork('work-article');
        const record = toWorkRecord(raw);

        expect(record.id).toBe('W9000000001');
        expect(record.doi).toBe('10.5555/alpha00001');
        expect(record.ids_pmid).toBe('99000001');
        expect(record.ids_pmcid).toBeNull();
        expect(record.authorships[0]?.author_id).toBe('A9000000001');
        expect(record.authorships[0]?.author_orcid).toBe('0000-0000-0000-0001');
        expect(record.primary_location_source_id).toBe('S9000000001');
        expect(record.primary_location_license_id).toBeNull();
        expect(record.locations[4]?.license_id).toBe('cc-by');
        expect(record.has_content_pdf).toBe(raw.has_content?.pdf ?? false);
        expect(record.has_content_grobid_xml).toBe(raw.has_content?.grobid_xml ?? false);
        expect(record.referenced_works[0]).toBe('W9100000001');
        expect(record.primary_topic_subfield_id).toBe('2505');
    });

    test('bibliographic fields', async () => {
        const record = toWorkRecord(await loadWork('work-article'));
        expect(record.title).toBe('Example Article Alpha: a made-up study');
        expect(record.type).toBe('article');
        expect(record.language).toBe('en');
        expect(record.publication_year).toBe(2013);
        expect(record.publication_date).toBe('2013-07-30');
    });

    test('abstract is null when the inverted index is null', async () => {
        const record = toWorkRecord(await loadWork('work-article'));
        expect(record.abstract).toBeNull();
    });

    test('authors are display names, in order, not deduped', async () => {
        const record = toWorkRecord(await loadWork('work-article'));
        expect(record.authors).toEqual([
            'Alpha Beta',
            'Gamma D. Delta',
            'Epsilon Z. Zeta',
            'E. T. Theta',
            'I.‐K. Lambda',
            'Mu Nu Xi',
            'Omicron Pi',
            'Rho S. Sigma',
        ]);
        expect(record.first_author).toBe('Alpha Beta');
    });

    test('authors_detailed carries orcid, position, correspondence, affiliations, countries', async () => {
        const record = toWorkRecord(await loadWork('work-article'));
        expect(record.authors_detailed).toHaveLength(8);

        const first = record.authors_detailed[0];
        expect(first?.name).toBe('Alpha Beta');
        expect(first?.orcid).toBe('0000-0000-0000-0001');
        expect(first?.position).toBe('first');
        expect(first?.is_corresponding).toBe(false);
        expect(first?.countries).toEqual(['US']);
        expect(first?.affiliations).toEqual([
            'Department Alpha, Institution Alpha, City Alpha, Region Alpha 00001, Country Alpha',
            'Department Alpha, Institution Alpha, City Alpha, 00001, Region Alpha, Country Alpha',
        ]);

        expect(record.authors_detailed[3]?.orcid).toBeNull();
        expect(record.authors_detailed[6]?.is_corresponding).toBe(true);
        expect(record.authors_detailed[7]?.position).toBe('last');
        expect(record.authors_detailed[1]?.position).toBe('middle');
        expect(record.authors_detailed[5]?.countries).toEqual(['HK']);
    });

    test('source fields', async () => {
        const record = toWorkRecord(await loadWork('work-article'));
        expect(record.journal).toBe('Journal Alpha');
        expect(record.source_type).toBe('journal');
        expect(record.primary_location_source_display_name).toBe('Journal Alpha');
        expect(record.primary_location_source_host_organization_name).toBe('Publisher Alpha');
        expect(record.primary_location_source_issn).toEqual(['0000-0001', '0000-0002']);
        expect(record.primary_location_source_issn_l).toBe('0000-0001');
    });

    test('pagination — a real range', async () => {
        const record = toWorkRecord(await loadWork('work-article'));
        expect(record.biblio_volume).toBe('12');
        expect(record.biblio_issue).toBe('3456');
        expect(record.biblio_first_page).toBe('54');
        expect(record.biblio_last_page).toBe('58');
        expect(record.pages).toBe('54-58');
    });

    test('open access fields', async () => {
        const record = toWorkRecord(await loadWork('work-article'));
        expect(record.open_access_is_oa).toBe(true);
        expect(record.open_access_oa_status).toBe('bronze');
        expect(record.open_access_oa_url).toBe('https://example.org/articles/alpha00001.pdf');
        expect(record.best_oa_location_pdf_url).toBe('https://example.org/articles/alpha00001.pdf');
        expect(record.best_oa_location_landing_page_url).toBe('https://doi.org/10.5555/alpha00001');
        expect(record.best_oa_location_license).toBeNull();
        expect(record.best_oa_location_version).toBe('publishedVersion');
    });

    test('oa_locations holds every OA location, in source order', async () => {
        const raw = await loadWork('work-article');
        const record = toWorkRecord(raw);
        expect(raw.locations).toHaveLength(6);
        expect(record.oa_locations).toHaveLength(4);
        expect(record.oa_locations.map((l) => l.landing_page_url)).toEqual([
            'https://doi.org/10.5555/alpha00001',
            'http://example.org/abs/0000.00001',
            'https://example.org/pmc/articles/9900001',
            'http://example.org/urn-3:EXAMPLE.Repos:00000001',
        ]);
    });

    test('each oa_location is fully mapped', async () => {
        const record = toWorkRecord(await loadWork('work-article'));
        expect(record.oa_locations[0]).toEqual({
            doi: null,
            landing_page_url: 'https://doi.org/10.5555/alpha00001',
            pdf_url: 'https://example.org/articles/alpha00001.pdf',
            license: null,
            version: 'publishedVersion',
            source_name: 'Journal Alpha',
            source_type: 'journal',
            is_published: true,
        });
        expect(record.oa_locations[1]).toEqual({
            doi: null,
            landing_page_url: 'http://example.org/abs/0000.00001',
            pdf_url: 'https://example.org/pdf/0000.00001',
            license: null,
            version: 'submittedVersion',
            source_name: 'Repository Beta',
            source_type: 'repository',
            is_published: false,
        });
        expect(record.oa_locations[3]?.license).toBe('cc-by');
        expect(record.oa_locations[3]?.source_name).toBe('Repository Delta');
    });

    test('metrics and classification', async () => {
        const record = toWorkRecord(await loadWork('work-article'));
        expect(record.cited_by_count).toBe(1989);
        expect(record.referenced_works_count).toBe(36);
        expect(record.fwci).toBe(50.1343);
        expect(record.is_retracted).toBe(false);
        expect(record.is_paratext).toBe(false);
        expect(record.primary_topic_display_name).toBe('Diamond and Carbon-based Materials Research');
        expect(record.topic_names).toEqual([
            'Diamond and Carbon-based Materials Research',
            'Advanced Fiber Laser Technologies',
            'Nonlinear Optical Materials Studies',
        ]);
        expect(record.keyword_names).toEqual([
            'Diamond',
            'Thermometer',
            'Nanotechnology',
            'Nanoscopic scale',
            'Nanometre',
            'Materials science',
            'Physics',
            'Optics',
        ]);
    });

    test('mesh_terms are descriptor names, deduped, first-occurrence order', async () => {
        const raw = await loadWork('work-article');
        const record = toWorkRecord(raw);
        expect(raw.mesh).toHaveLength(42);
        expect(record.mesh_terms).toEqual([
            'Cell Survival',
            'Color',
            'Fibroblasts',
            'Gold',
            'Humans',
            'Nitrogen',
            'Temperature',
            'Thermometers',
            'Nanotechnology',
            'Metal Nanoparticles',
            'Nanodiamonds',
            'Single-Cell Analysis',
            'Thermometry',
        ]);
        expect(new Set(record.mesh_terms).size).toBe(record.mesh_terms.length);
    });

    test('funder_names are display names from funders[], not the awards fallback', async () => {
        const record = toWorkRecord(await loadWork('work-article'));
        expect(record.funder_names).toEqual([
            'Funder Epsilon',
            'Funder Gamma',
            'Funder Alpha',
            'Funder Zeta',
            'Funder Eta',
            'Funder Theta',
            'Funder Delta',
            'Funder Beta',
            'Funder Iota',
        ]);
    });

    test('provenance dates are passed through', async () => {
        const record = toWorkRecord(await loadWork('work-article'));
        expect(record.updated_date).toBe('2026-09-09T07:26:56.047234');
        expect(record.created_date).toBe('2025-10-10T00:00:00');
    });
});

describe('fixture work-open-access (journal article, gold OA)', () => {
    test('identifiers and title', async () => {
        const record = toWorkRecord(await loadWork('work-open-access'));
        expect(record.id).toBe('W9000000002');
        expect(record.doi).toBe('10.5555/journal.beta.0000002');
        expect(record.ids_pmid).toBe('99000002');
        expect(record.ids_pmcid).toBeNull();
        expect(record.title).toBe('Example Article Beta: A Made-up Open Access Study');
    });

    test('the abstract is reconstructed automatically', async () => {
        const record = toWorkRecord(await loadWork('work-open-access'));
        expect(record.abstract).not.toBeNull();
        expect(record.abstract).toHaveLength(479);
        expect(record.abstract?.startsWith('BACKGROUND: This made-up abstract')).toBe(true);
        expect(record.abstract).not.toContain('  ');
    });

    test('single-page biblio collapses to one page, not "e123-e123"', async () => {
        const record = toWorkRecord(await loadWork('work-open-access'));
        expect(record.biblio_first_page).toBe('e123');
        expect(record.biblio_last_page).toBe('e123');
        expect(record.pages).toBe('e123');
    });

    test('gold OA fields', async () => {
        const record = toWorkRecord(await loadWork('work-open-access'));
        expect(record.open_access_is_oa).toBe(true);
        expect(record.open_access_oa_status).toBe('gold');
        expect(record.open_access_oa_url).toBe('https://doi.org/10.5555/journal.beta.0000002');
        expect(record.best_oa_location_license).toBe('cc-by');
        expect(record.best_oa_location_version).toBe('publishedVersion');
        expect(record.best_oa_location_pdf_url).toBeNull();
        expect(record.best_oa_location_landing_page_url).toBe('https://doi.org/10.5555/journal.beta.0000002');
    });

    test('oa_locations keeps duplicates — it is never deduplicated', async () => {
        const raw = await loadWork('work-open-access');
        const record = toWorkRecord(raw);
        expect(raw.locations).toHaveLength(8);
        expect(record.oa_locations).toHaveLength(5);
        const duplicated = record.oa_locations.filter(
            (l) => l.landing_page_url === 'https://example.org/pmc/articles/9900002',
        );
        expect(duplicated).toHaveLength(2);
        expect(duplicated[0]?.source_name).toBe('Repository Eta');
        expect(duplicated[1]?.source_name).toBe('Repository Gamma');
    });

    test('source and author fields', async () => {
        const record = toWorkRecord(await loadWork('work-open-access'));
        expect(record.journal).toBe('Journal Beta');
        expect(record.primary_location_source_host_organization_name).toBe('Publisher Gamma');
        expect(record.primary_location_source_issn).toEqual(['0000-0004']);
        expect(record.primary_location_source_issn_l).toBe('0000-0004');
        expect(record.authors).toEqual(['Tau Upsilon', 'Phi Chi', 'Psi B. Omega']);
        expect(record.first_author).toBe('Tau Upsilon');
        expect(record.authors_detailed[0]?.is_corresponding).toBe(true);
        expect(record.authors_detailed[1]?.orcid).toBeNull();
    });

    test('mesh_terms deduped from 52 raw entries', async () => {
        const raw = await loadWork('work-open-access');
        const record = toWorkRecord(raw);
        expect(raw.mesh).toHaveLength(52);
        expect(record.mesh_terms).toEqual([
            'Clinical Trials as Topic',
            'Cost-Benefit Analysis',
            'Humans',
            'Neoplasms',
            'Periodicals as Topic',
            'Publications',
            'Regression Analysis',
            'Internet',
            'Oligonucleotide Array Sequence Analysis',
            'Information Dissemination',
            'Biomedical Research',
            'Journal Impact Factor',
        ]);
    });

    test('funder_names deduped from funders[]', async () => {
        const record = toWorkRecord(await loadWork('work-open-access'));
        expect(record.funder_names).toEqual(['Funder Alpha', 'Funder Kappa']);
    });

    test('metrics', async () => {
        const record = toWorkRecord(await loadWork('work-open-access'));
        expect(record.cited_by_count).toBe(910);
        expect(record.referenced_works_count).toBe(40);
        expect(record.fwci).toBe(72.2205);
        expect(record.publication_year).toBe(2007);
    });
});

describe('fixture work-legacy (closed access, sparse)', () => {
    test('closed access leaves the whole OA group null or false', async () => {
        const raw = await loadWork('work-legacy');
        const record = toWorkRecord(raw);
        expect(record.open_access_is_oa).toBe(false);
        expect(record.open_access_oa_status).toBe('closed');
        expect(record.open_access_oa_url).toBeNull();
        expect(record.best_oa_location_pdf_url).toBeNull();
        expect(record.best_oa_location_landing_page_url).toBeNull();
        expect(record.best_oa_location_license).toBeNull();
        expect(record.best_oa_location_version).toBeNull();
        expect(record.oa_locations).toEqual([]);
    });

    test('the paywalled landing page is not promoted into best_oa_location', async () => {
        const raw = await loadWork('work-legacy');
        const record = toWorkRecord(raw);
        expect(raw.best_oa_location).toBeNull();
        expect(raw.primary_location?.landing_page_url).toBe('https://doi.org/10.5555/gamma.000.0003');
        expect(record.best_oa_location_landing_page_url).toBeNull();
        expect(record.primary_location_landing_page_url).toBe('https://doi.org/10.5555/gamma.000.0003');
    });

    test('empty classification arrays are [] and never undefined', async () => {
        const record = toWorkRecord(await loadWork('work-legacy'));
        expect(record.mesh_terms).toEqual([]);
        expect(record.funder_names).toEqual([]);
    });

    test('a single author with no institutions', async () => {
        const record = toWorkRecord(await loadWork('work-legacy'));
        expect(record.authors).toEqual(['A. B. Gamma']);
        expect(record.first_author).toBe('A. B. Gamma');
        expect(record.authors_detailed).toHaveLength(1);
        expect(record.authors_detailed[0]?.countries).toEqual([]);
        expect(record.authors_detailed[0]?.affiliations).toEqual(['Laboratory Alpha, City Delta, Region Delta']);
        expect(record.authors_detailed[0]?.orcid).toBeNull();
        expect(record.authors_detailed[0]?.is_corresponding).toBe(true);
    });

    test('bibliographic and metric fields', async () => {
        const record = toWorkRecord(await loadWork('work-legacy'));
        expect(record.doi).toBe('10.5555/gamma.000.0003');
        expect(record.ids_pmid).toBeNull();
        expect(record.publication_year).toBe(1958);
        expect(record.publication_date).toBe('1958-03-01');
        expect(record.journal).toBe('Journal Gamma');
        expect(record.primary_location_source_host_organization_name).toBe('Publisher Delta');
        expect(record.pages).toBe('1001-1014');
        expect(record.cited_by_count).toBe(12461);
        expect(record.referenced_works_count).toBe(12);
        expect(record.fwci).toBe(10.4017);
    });

    test('the abstract is reconstructed', async () => {
        const record = toWorkRecord(await loadWork('work-legacy'));
        expect(record.abstract).toHaveLength(318);
        expect(record.abstract?.startsWith('This made-up abstract presents a simple model')).toBe(true);
    });
});

describe('fixture work-preprint (repository preprint, green OA)', () => {
    test('an all-null biblio yields null pagination and null pages', async () => {
        const record = toWorkRecord(await loadWork('work-preprint'));
        expect(record.biblio_volume).toBeNull();
        expect(record.biblio_issue).toBeNull();
        expect(record.biblio_first_page).toBeNull();
        expect(record.biblio_last_page).toBeNull();
        expect(record.pages).toBeNull();
    });

    test('green OA fields', async () => {
        const record = toWorkRecord(await loadWork('work-preprint'));
        expect(record.open_access_is_oa).toBe(true);
        expect(record.open_access_oa_status).toBe('green');
        expect(record.open_access_oa_url).toBe('https://example.org/pdf/0000.00004');
        expect(record.best_oa_location_pdf_url).toBe('https://example.org/pdf/0000.00004');
        expect(record.best_oa_location_landing_page_url).toBe('http://example.org/abs/0000.00004');
        expect(record.best_oa_location_license).toBe('cc-by');
        expect(record.best_oa_location_version).toBe('submittedVersion');
        expect(record.type).toBe('preprint');
    });

    test('a null raw is_published in oa_locations remains null', async () => {
        const raw = await loadWork('work-preprint');
        const record = toWorkRecord(raw);
        expect(raw.locations?.[1]?.is_published).toBeNull();
        expect(record.oa_locations).toHaveLength(2);
        expect(record.oa_locations[1]?.is_published).toBeNull();
        expect(record.oa_locations[0]?.is_published).toBe(false);
    });

    test('a null raw version widens to null, not to a broken enum', async () => {
        const record = toWorkRecord(await loadWork('work-preprint'));
        expect(record.oa_locations[1]?.version).toBeNull();
        expect(record.oa_locations[0]?.version).toBe('submittedVersion');
    });

    test('sourceName falls back to the source display name when raw_source_name is null', async () => {
        const record = toWorkRecord(await loadWork('work-preprint'));
        expect(record.oa_locations[1]?.source_name).toBe('Repository Beta');
        expect(record.oa_locations[1]?.source_type).toBe('repository');
    });

    test('authors with no affiliations or countries get empty arrays', async () => {
        const record = toWorkRecord(await loadWork('work-preprint'));
        expect(record.authors).toHaveLength(8);
        expect(record.authors[0]).toBe('Beta Gamma');
        expect(record.authors[7]).toBe('Rho Tau');
        expect(record.authors_detailed[0]?.affiliations).toEqual([]);
        expect(record.authors_detailed[0]?.countries).toEqual([]);
    });

    test('a null fwci and a zero reference count', async () => {
        const record = toWorkRecord(await loadWork('work-preprint'));
        expect(record.fwci).toBeNull();
        expect(record.referenced_works_count).toBe(0);
        expect(record.cited_by_count).toBe(530);
    });

    test('identifiers with no pmid and no mag', async () => {
        const record = toWorkRecord(await loadWork('work-preprint'));
        expect(record.doi).toBe('10.5555/delta.0000.00004');
        expect(record.ids_pmid).toBeNull();
        expect(record.ids_pmcid).toBeNull();
        expect(record.id).toBe('W9000000004');
    });

    test('the abstract is reconstructed', async () => {
        const record = toWorkRecord(await loadWork('work-preprint'));
        expect(record.abstract).toHaveLength(463);
    });
});

describe('invariants across all four fixtures', () => {
    test('no field is ever undefined', async () => {
        for (const name of WORK_FIXTURE_NAMES) {
            const record = toWorkRecord(await loadWork(name));
            expect(findUndefinedPaths(record), name).toEqual([]);
        }
    });

    test('every array field is an array', async () => {
        for (const name of WORK_FIXTURE_NAMES) {
            const record = toWorkRecord(await loadWork(name));
            for (const field of [
                'authors',
                'authors_detailed',
                'oa_locations',
                'keyword_names',
                'topic_names',
                'mesh_terms',
                'funder_names',
                'authorships',
                'institutions',
                'locations',
                'counts_by_year',
                'topics',
                'keywords',
                'concepts',
                'mesh',
                'sustainable_development_goals',
                'awards',
                'funders',
                'primary_location_source_issn',
                'best_oa_location_source_issn',
                'indexed_in',
                'corresponding_author_ids',
                'corresponding_institution_ids',
                'referenced_works',
                'related_works',
            ] as const) {
                expect(Array.isArray(record[field]), `${name}.${field}`).toBe(true);
            }
        }
    });

    test('the raw payload is never mutated', async () => {
        for (const name of WORK_FIXTURE_NAMES) {
            const raw = await loadWork(name);
            const before = stableJson(raw);
            toWorkRecord(raw);
            expect(stableJson(raw), name).toBe(before);
        }
    });

    test('no returned array aliases a raw array', async () => {
        for (const name of WORK_FIXTURE_NAMES) {
            const raw = await loadWork(name);
            const record = toWorkRecord(raw);
            const rawSource = raw.primary_location?.source;
            if (rawSource?.issn) {
                expect(record.primary_location_source_issn, name).not.toBe(rawSource.issn);
            }
            const firstAuthorship = raw.authorships?.[0];
            if (firstAuthorship) {
                expect(record.authors_detailed[0]?.countries, name).not.toBe(firstAuthorship.countries);
                expect(record.authors_detailed[0]?.affiliations, name).not.toBe(
                    firstAuthorship.raw_affiliation_strings,
                );
            }
            expect(record.oa_locations as unknown, name).not.toBe(raw.locations);
            expect(record.locations as unknown, name).not.toBe(raw.locations);
        }
    });

    test('mutating the returned record does not reach the raw payload', async () => {
        const raw = await loadWork('work-article');
        const record = toWorkRecord(raw);
        (record.primary_location_source_issn as string[]).push('9999-9999');
        expect(raw.primary_location?.source?.issn).toEqual(['0000-0001', '0000-0002']);
    });

    test('string fields are trimmed and never blank', async () => {
        for (const name of WORK_FIXTURE_NAMES) {
            const record = toWorkRecord(await loadWork(name)) as unknown as Record<string, unknown>;
            for (const [key, value] of Object.entries(record)) {
                if (typeof value !== 'string') {
                    continue;
                }
                expect(value, `${name}.${key}`).toBe(value.trim());
                expect(value.length, `${name}.${key}`).toBeGreaterThan(0);
            }
        }
    });

    test('every string in every string array is non-blank', async () => {
        for (const name of WORK_FIXTURE_NAMES) {
            const record = toWorkRecord(await loadWork(name));
            const arrays = [
                record.authors,
                record.primary_location_source_issn,
                record.keyword_names,
                record.topic_names,
                record.mesh_terms,
                record.funder_names,
            ];
            for (const array of arrays) {
                for (const value of array) {
                    expect(typeof value).toBe('string');
                    expect(value.trim().length, `${name}: "${value}"`).toBeGreaterThan(0);
                }
            }
        }
    });

    test('deduped arrays hold no repeats, authors may', async () => {
        for (const name of WORK_FIXTURE_NAMES) {
            const record = toWorkRecord(await loadWork(name));
            for (const field of ['keyword_names', 'topic_names', 'mesh_terms', 'funder_names'] as const) {
                const values = record[field];
                expect(new Set(values).size, `${name}.${field}`).toBe(values.length);
            }
        }
    });

    test('oa_locations mirrors exactly the raw locations flagged is_oa', async () => {
        for (const name of WORK_FIXTURE_NAMES) {
            const raw = await loadWork(name);
            const record = toWorkRecord(raw);
            const expected = (raw.locations ?? []).filter((l) => l.is_oa === true);
            expect(record.oa_locations.length, name).toBe(expected.length);
        }
    });

    test('calling twice gives an equal but independent record', async () => {
        const raw = await loadWork('work-article');
        const a = toWorkRecord(raw);
        const b = toWorkRecord(raw);
        expect(a).toEqual(b);
        expect(a).not.toBe(b);
        expect(a.authors).not.toBe(b.authors);
    });

    test('the record is not frozen', async () => {
        const record = toWorkRecord(await loadWork('work-article'));
        expect(Object.isFrozen(record)).toBe(false);
    });

    test('concepts and is_xpac are included in the flat record', async () => {
        const raw = await loadWorkJson('work-article');
        const record = toWorkRecord(asWork(raw));
        expect(Array.isArray(record.concepts)).toBe(true);
        expect(typeof record.is_xpac).toBe('boolean');
    });
});

describe('defensive shaping — never throws, never undefined', () => {
    const hostile: readonly [string, unknown][] = [
        ['an empty object', {}],
        ['null', null],
        ['undefined', undefined],
        ['an empty array', []],
        ['a populated array', [1, 2, 3]],
        ['a string', 'not a work'],
        ['a number', 42],
        ['true', true],
        ['a function', () => ({})],
        ['a Date', new Date(0)],
    ];

    for (const [label, value] of hostile) {
        test(`${label} is not a work: null, never a half-empty record`, () => {
            expect(shapeWork(asWork(value))).toBeNull();
        });
    }

    test('a work id is required and normalized; anything else rejects the work', () => {
        expect(shapeWork(asWork({ id: 'https://openalex.org/W9000000001' }))?.id).toBe('W9000000001');
        expect(shapeWork(asWork({ id: 'w42' }))?.id).toBe('W42');
        for (const id of [null, 42, '', 'A9000000001', 'https://openalex.org/A1', 'https://example.org/W1']) {
            expect(shapeWork(asWork({ id, title: 'kept out' }))).toBeNull();
        }
    });

    test('a work with only an id is a complete record with no undefined anywhere', () => {
        const record = shapeWork(asWork({ id: 'W1' }));
        expect(Object.keys(record ?? {}).sort()).toEqual([...FIELD_NAMES].sort());
        expect(findUndefinedPaths(record)).toEqual([]);
    });

    test('a throwing getter rejects the work instead of throwing', () => {
        const hostileWork = {
            id: 'W1',
            get title(): never {
                throw new Error('boom');
            },
        };
        expect(shapeWork(asWork(hostileWork))).toBeNull();
    });

    test('an id-only work yields the documented defaults', () => {
        const record = toWorkRecord(asWork({}));
        expect(record.id).toBe('W1');
        expect(record.doi).toBeNull();
        expect(record.ids_pmid).toBeNull();
        expect(record.ids_pmcid).toBeNull();
        expect(record.title).toBeNull();
        expect(record.abstract).toBeNull();
        expect(record.authors).toEqual([]);
        expect(record.authors_detailed).toEqual([]);
        expect(record.first_author).toBeNull();
        expect(record.primary_location_source_issn).toEqual([]);
        expect(record.pages).toBeNull();
        expect(record.open_access_is_oa).toBe(false);
        expect(record.oa_locations).toEqual([]);
        expect(record.cited_by_count).toBeNull();
        expect(record.referenced_works_count).toBeNull();
        expect(record.fwci).toBeNull();
        expect(record.is_retracted).toBe(false);
        expect(record.is_paratext).toBe(false);
        expect(record.is_xpac).toBe(false);
        expect(record.keyword_names).toEqual([]);
        expect(record.topic_names).toEqual([]);
        expect(record.mesh_terms).toEqual([]);
        expect(record.funder_names).toEqual([]);
        expect(record.primary_topic_display_name).toBeNull();
        expect(record.updated_date).toBeNull();
        expect(record.created_date).toBeNull();
    });

    test('wrongly typed fields degrade to null or [] rather than crashing', () => {
        const record = toWorkRecord(
            asWork({
                id: 'W1',
                doi: {},
                title: 42,
                display_name: [],
                ids: 'not an object',
                biblio: [],
                authorships: 'nope',
                locations: {},
                best_oa_location: 'nope',
                open_access: 5,
                primary_location: 7,
                mesh: 'nope',
                topics: 3,
                keywords: null,
                funders: false,
                awards: 'nope',
                cited_by_count: 'many',
                referenced_works_count: {},
                referenced_works: 'nope',
                fwci: 'high',
                publication_year: '2013',
                is_retracted: 'true',
                is_paratext: 1,
            }),
        );
        expect(record.doi).toBeNull();
        expect(record.title).toBeNull();
        expect(record.publication_year).toBeNull();
        expect(record.authors).toEqual([]);
        expect(record.authors_detailed).toEqual([]);
        expect(record.oa_locations).toEqual([]);
        expect(record.mesh_terms).toEqual([]);
        expect(record.topic_names).toEqual([]);
        expect(record.keyword_names).toEqual([]);
        expect(record.funder_names).toEqual([]);
        expect(record.cited_by_count).toBeNull();
        expect(record.referenced_works_count).toBeNull();
        expect(record.fwci).toBeNull();
        expect(record.is_retracted).toBe(false);
        expect(record.is_paratext).toBe(false);
        expect(record.open_access_is_oa).toBe(false);
        expect(findUndefinedPaths(record)).toEqual([]);
    });

    test('a partially broken authorship does not lose the good ones', () => {
        const record = toWorkRecord(
            asWork({
                authorships: [
                    null,
                    'nope',
                    { author: { display_name: 'Real Person' }, author_position: 'first' },
                    { author: null, raw_author_name: 'Fallback Person' },
                    { author: {}, raw_author_name: null }, // no name -> dropped from authors & authors_detailed
                ],
            }),
        );
        expect(record.authors).toEqual(['Real Person', 'Fallback Person']);
        expect(record.authors_detailed).toHaveLength(2);
        expect(record.authors_detailed[0]?.name).toBe('Real Person');
        expect(record.authors_detailed[1]?.name).toBe('Fallback Person');
        expect(record.authorships).toHaveLength(5);
        expect(findUndefinedPaths(record)).toEqual([]);
    });

    test('a broken location does not lose the good ones', () => {
        const record = toWorkRecord(
            asWork({
                locations: [null, 'nope', { is_oa: true, landing_page_url: 'https://ok.test' }, { is_oa: 'true' }],
            }),
        );
        expect(record.oa_locations).toHaveLength(1);
        expect(record.oa_locations[0]?.landing_page_url).toBe('https://ok.test');
        expect(record.oa_locations[0]?.is_published).toBeNull();
    });

    test('nullable parents rule: primary_location: null leaves all children null and arrays empty', () => {
        const record = toWorkRecord(asWork({ primary_location: null }));
        expect(record.primary_location_id).toBeNull();
        expect(record.primary_location_is_oa).toBeNull();
        expect(record.primary_location_landing_page_url).toBeNull();
        expect(record.primary_location_pdf_url).toBeNull();
        expect(record.primary_location_source_id).toBeNull();
        expect(record.primary_location_source_display_name).toBeNull();
        expect(record.primary_location_source_issn_l).toBeNull();
        expect(record.primary_location_source_issn).toEqual([]);
        expect(record.primary_location_source_is_oa).toBeNull();
        expect(record.primary_location_source_is_in_doaj).toBeNull();
        expect(record.primary_location_source_is_core).toBeNull();
        expect(record.primary_location_source_host_organization).toBeNull();
        expect(record.primary_location_source_host_organization_name).toBeNull();
        expect(record.primary_location_source_host_organization_lineage).toEqual([]);
        expect(record.primary_location_source_host_organization_lineage_names).toEqual([]);
        expect(record.primary_location_source_type).toBeNull();
        expect(record.primary_location_license).toBeNull();
        expect(record.primary_location_license_id).toBeNull();
        expect(record.primary_location_version).toBeNull();
        expect(record.primary_location_is_accepted).toBeNull();
        expect(record.primary_location_is_published).toBeNull();
        expect(record.primary_location_raw_source_name).toBeNull();
        expect(record.primary_location_raw_type).toBeNull();
    });
});

describe('identifier rules', () => {
    test('doi is normalized bare DOI from raw doi', () => {
        expect(toWorkRecord(asWork({ doi: 'https://doi.org/10.5555/ALPHA00001' })).doi).toBe('10.5555/alpha00001');
        expect(toWorkRecord(asWork({ doi: '10.5555/x' })).doi).toBe('10.5555/x');
    });

    test('an unnormalizable doi is null', () => {
        const record = toWorkRecord(asWork({ doi: 'garbage' }));
        expect(record.doi).toBeNull();
    });

    test('ids_pmid accepts every documented form', () => {
        const pmidOf = (value: unknown) => toWorkRecord(asWork({ ids: { pmid: value } })).ids_pmid;
        expect(pmidOf('https://pubmed.ncbi.nlm.nih.gov/99000001')).toBe('99000001');
        expect(pmidOf('https://pubmed.ncbi.nlm.nih.gov/99000001/')).toBe('99000001');
        expect(pmidOf('pmid:99000001')).toBe('99000001');
        expect(pmidOf('PMID: 99000001')).toBe('99000001');
        expect(pmidOf('99000001')).toBe('99000001');
        expect(pmidOf('  99000001  ')).toBe('99000001');
    });

    test('ids_pmid must be digits-only after stripping, else null', () => {
        const pmidOf = (value: unknown) => toWorkRecord(asWork({ ids: { pmid: value } })).ids_pmid;
        expect(pmidOf('')).toBeNull();
        expect(pmidOf('   ')).toBeNull();
        expect(pmidOf('no-digits-here')).toBeNull();
        expect(pmidOf(null)).toBeNull();
        expect(pmidOf(undefined)).toBeNull();
        expect(pmidOf('PMC9900001')).toBeNull();
    });

    test('a numeric ids.pmid is coerced, not discarded', () => {
        expect(toWorkRecord(asWork({ ids: { pmid: 99000001 } })).ids_pmid).toBe('99000001');
        expect(toWorkRecord(asWork({ ids: { pmcid: 9900001 } })).ids_pmcid).toBe('PMC9900001');
        expect(toWorkRecord(asWork({ ids: { mag: 2159974629 } })).ids_mag).toBe('2159974629');
        expect(toWorkRecord(asWork({ ids: { mag: 0 } })).ids_mag).toBeNull();
        expect(toWorkRecord(asWork({ ids: { mag: -1 } })).ids_mag).toBeNull();
    });

    test('ids_pmcid accepts every documented form and keeps the PMC prefix', () => {
        const pmcidOf = (value: unknown) => toWorkRecord(asWork({ ids: { pmcid: value } })).ids_pmcid;
        expect(pmcidOf('https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9900001')).toBe('PMC9900001');
        expect(pmcidOf('https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9900001/')).toBe('PMC9900001');
        expect(pmcidOf('pmcid:PMC9900001')).toBe('PMC9900001');
        expect(pmcidOf('PMC9900001')).toBe('PMC9900001');
    });

    test('a bare number in the ids.pmcid slot gains the PMC prefix', () => {
        expect(toWorkRecord(asWork({ ids: { pmcid: '9900001' } })).ids_pmcid).toBe('PMC9900001');
        expect(
            toWorkRecord(asWork({ ids: { pmcid: 'https://www.ncbi.nlm.nih.gov/pmc/articles/9900001' } })).ids_pmcid,
        ).toBe('PMC9900001');
    });

    test('an ids_pmcid with no digits is null', () => {
        const pmcidOf = (value: unknown) => toWorkRecord(asWork({ ids: { pmcid: value } })).ids_pmcid;
        expect(pmcidOf('')).toBeNull();
        expect(pmcidOf('   ')).toBeNull();
        expect(pmcidOf('PMC')).toBeNull();
        expect(pmcidOf(null)).toBeNull();
        expect(pmcidOf(undefined)).toBeNull();
    });
});

describe('title, dates and metrics', () => {
    test('title is the raw title trimmed with no fallback to display_name', () => {
        expect(toWorkRecord(asWork({ title: null, display_name: 'Fallback' })).title).toBeNull();
        expect(toWorkRecord(asWork({ title: 'Primary', display_name: 'Fallback' })).title).toBe('Primary');
    });

    test('a blank title becomes null', () => {
        expect(toWorkRecord(asWork({ title: '   ', display_name: 'Fallback' })).title).toBeNull();
        expect(toWorkRecord(asWork({ title: '  Spaced Out  ' })).title).toBe('Spaced Out');
    });

    test('publication_year survives only as a finite number', () => {
        expect(toWorkRecord(asWork({ publication_year: 2013 })).publication_year).toBe(2013);
        expect(toWorkRecord(asWork({ publication_year: '2013' })).publication_year).toBeNull();
        expect(toWorkRecord(asWork({ publication_year: Number.NaN })).publication_year).toBeNull();
        expect(toWorkRecord(asWork({ publication_year: Number.POSITIVE_INFINITY })).publication_year).toBeNull();
        expect(toWorkRecord(asWork({ publication_year: null })).publication_year).toBeNull();
    });

    test('cited_by_count is a finite number, else null', () => {
        expect(toWorkRecord(asWork({ cited_by_count: 7 })).cited_by_count).toBe(7);
        expect(toWorkRecord(asWork({ cited_by_count: 0 })).cited_by_count).toBe(0);
        expect(toWorkRecord(asWork({ cited_by_count: '7' })).cited_by_count).toBeNull();
        expect(toWorkRecord(asWork({ cited_by_count: null })).cited_by_count).toBeNull();
        expect(toWorkRecord(asWork({ cited_by_count: Number.NaN })).cited_by_count).toBeNull();
    });

    test('referenced_works_count is a finite number without fallback', () => {
        expect(toWorkRecord(asWork({ referenced_works_count: 5 })).referenced_works_count).toBe(5);
        expect(toWorkRecord(asWork({ referenced_works: ['a', 'b', 'c'] })).referenced_works_count).toBeNull();
        expect(toWorkRecord(asWork({})).referenced_works_count).toBeNull();
    });

    test('fwci survives only as a finite number', () => {
        expect(toWorkRecord(asWork({ fwci: 1.5 })).fwci).toBe(1.5);
        expect(toWorkRecord(asWork({ fwci: 0 })).fwci).toBe(0);
        expect(toWorkRecord(asWork({ fwci: 'high' })).fwci).toBeNull();
        expect(toWorkRecord(asWork({ fwci: null })).fwci).toBeNull();
    });

    test('is_retracted, is_paratext, is_traditional, and is_xpac are strict === true', () => {
        expect(toWorkRecord(asWork({ is_retracted: true })).is_retracted).toBe(true);
        expect(toWorkRecord(asWork({ is_retracted: 'true' })).is_retracted).toBe(false);
        expect(toWorkRecord(asWork({ is_retracted: 1 })).is_retracted).toBe(false);
        expect(toWorkRecord(asWork({ is_paratext: true })).is_paratext).toBe(true);
        expect(toWorkRecord(asWork({ is_paratext: null })).is_paratext).toBe(false);
        expect(toWorkRecord(asWork({ is_traditional: true })).is_traditional).toBe(true);
        expect(toWorkRecord(asWork({ is_traditional: null })).is_traditional).toBe(false);
        expect(toWorkRecord(asWork({ is_xpac: true })).is_xpac).toBe(true);
        expect(toWorkRecord(asWork({ is_xpac: null })).is_xpac).toBe(false);
    });

    test('provenance dates pass through, blank becomes null', () => {
        expect(toWorkRecord(asWork({ updated_date: '2026-09-09T07:26:56' })).updated_date).toBe('2026-09-09T07:26:56');
        expect(toWorkRecord(asWork({ updated_date: '  ' })).updated_date).toBeNull();
        expect(toWorkRecord(asWork({ created_date: null })).created_date).toBeNull();
    });

    test('language and type blank becomes null', () => {
        expect(toWorkRecord(asWork({ language: '' })).language).toBeNull();
        expect(toWorkRecord(asWork({ type: '   ' })).type).toBeNull();
        expect(toWorkRecord(asWork({ language: 'en' })).language).toBe('en');
    });
});

describe('pagination rule', () => {
    const pagesOf = (first: unknown, last: unknown) =>
        toWorkRecord(asWork({ biblio: { first_page: first, last_page: last } })).pages;

    test('both present and different → a range', () => {
        expect(pagesOf('54', '58')).toBe('54-58');
    });

    test('both present and equal → the single page', () => {
        expect(pagesOf('e308', 'e308')).toBe('e308');
        expect(pagesOf('12', '12')).toBe('12');
    });

    test('only the first page → that page', () => {
        expect(pagesOf('54', null)).toBe('54');
        expect(pagesOf('54', undefined)).toBe('54');
        expect(pagesOf('54', '  ')).toBe('54');
    });

    test('only the last page → that page', () => {
        expect(pagesOf(null, '58')).toBe('58');
        expect(pagesOf('', '58')).toBe('58');
    });

    test('neither → null', () => {
        expect(pagesOf(null, null)).toBeNull();
        expect(pagesOf(undefined, undefined)).toBeNull();
        expect(pagesOf('  ', '')).toBeNull();
    });

    test('a missing biblio leaves every pagination field null', () => {
        const record = toWorkRecord(asWork({}));
        expect(record.biblio_volume).toBeNull();
        expect(record.biblio_issue).toBeNull();
        expect(record.biblio_first_page).toBeNull();
        expect(record.biblio_last_page).toBeNull();
        expect(record.pages).toBeNull();
    });

    test('non-string biblio members do not leak into pages', () => {
        expect(toWorkRecord(asWork({ biblio: { first_page: 54, last_page: 58 } })).pages).toBeNull();
    });
});

describe('source derived fields', () => {
    test('journal falls back to raw_source_name', () => {
        expect(toWorkRecord(asWork({ primary_location: { source: { display_name: 'Journal Alpha' } } })).journal).toBe(
            'Journal Alpha',
        );
        expect(
            toWorkRecord(asWork({ primary_location: { source: null, raw_source_name: 'Raw Journal' } })).journal,
        ).toBe('Raw Journal');
        expect(toWorkRecord(asWork({ primary_location: null })).journal).toBeNull();
    });

    test('a blank source display name falls through', () => {
        expect(
            toWorkRecord(asWork({ primary_location: { source: { display_name: '  ' }, raw_source_name: 'Raw' } }))
                .journal,
        ).toBe('Raw');
    });

    test('source_type falls back to raw_type', () => {
        expect(toWorkRecord(asWork({ primary_location: { source: { type: 'journal' } } })).source_type).toBe('journal');
        expect(
            toWorkRecord(asWork({ primary_location: { source: null, raw_type: 'journal-article' } })).source_type,
        ).toBe('journal-article');
    });
});

describe('author rules', () => {
    test('unnamed authors are dropped from authors and authors_detailed', () => {
        const record = toWorkRecord(
            asWork({
                authorships: [
                    { author: { display_name: 'Display Name' }, raw_author_name: 'Raw Name' },
                    { author: { display_name: '   ' }, raw_author_name: 'Raw Only' },
                    { author: {}, raw_author_name: null }, // no usable name
                ],
            }),
        );
        expect(record.authors).toEqual(['Display Name', 'Raw Only']);
        expect(record.authors_detailed).toHaveLength(2);
        expect(record.authors_detailed[0]?.name).toBe('Display Name');
        expect(record.authors_detailed[1]?.name).toBe('Raw Only');
        expect(record.authorships).toHaveLength(3); // raw-faithful authorships keeps all 3
    });

    test('authors are not deduplicated — order and repeats are meaningful', () => {
        const record = toWorkRecord(
            asWork({
                authorships: [
                    { author: { display_name: 'Same Person' } },
                    { author: { display_name: 'Other' } },
                    { author: { display_name: 'Same Person' } },
                ],
            }),
        );
        expect(record.authors).toEqual(['Same Person', 'Other', 'Same Person']);
    });

    test('first_author is the first author with position first, else authors[0]', () => {
        expect(
            toWorkRecord(
                asWork({
                    authorships: [
                        { author: { display_name: 'B' }, author_position: 'middle' },
                        { author: { display_name: 'A' }, author_position: 'first' },
                    ],
                }),
            ).first_author,
        ).toBe('A');

        expect(toWorkRecord(asWork({ authorships: [{ author: { display_name: 'A' } }] })).first_author).toBe('A');
        expect(toWorkRecord(asWork({ authorships: [] })).first_author).toBeNull();
        expect(toWorkRecord(asWork({})).first_author).toBeNull();
    });

    test('first_author is null when the declared first authorship has no name', () => {
        expect(
            toWorkRecord(
                asWork({
                    authorships: [
                        { author_position: 'first' },
                        { author: { display_name: 'B' }, author_position: 'middle' },
                    ],
                }),
            ).first_author,
        ).toBeNull();

        const record = toWorkRecord(
            asWork({
                authorships: [
                    { author: { display_name: null }, raw_author_name: null, author_position: 'first' },
                    { author: { display_name: 'B' }, author_position: 'middle' },
                ],
            }),
        );
        expect(record.first_author).toBeNull();
        expect(record.authors).toEqual(['B']);
    });

    test('first_author falls back to authors[0] when no authorship declares first', () => {
        expect(
            toWorkRecord(
                asWork({
                    authorships: [
                        { author: { display_name: 'B' }, author_position: 'middle' },
                        { author: { display_name: 'C' }, author_position: 'last' },
                    ],
                }),
            ).first_author,
        ).toBe('B');

        expect(
            toWorkRecord(
                asWork({
                    authorships: [
                        { author: { display_name: 'A' }, author_position: 'first' },
                        { author: { display_name: 'B' }, author_position: 'middle' },
                    ],
                }),
            ).first_author,
        ).toBe('A');
    });

    test('an unrecognised author_position falls back to middle', () => {
        const record = toWorkRecord(
            asWork({
                authorships: [
                    { author: { display_name: 'A' }, author_position: 'first' },
                    { author: { display_name: 'B' }, author_position: 'FIRST' },
                    { author: { display_name: 'C' }, author_position: 'corresponding' },
                    { author: { display_name: 'D' } },
                    { author: { display_name: 'E' }, author_position: null },
                    { author: { display_name: 'F' }, author_position: 'last' },
                ],
            }),
        );
        expect(record.authors_detailed.map((a) => a.position)).toEqual([
            'first',
            'middle',
            'middle',
            'middle',
            'middle',
            'last',
        ]);
    });

    test('is_corresponding is strict === true', () => {
        const record = toWorkRecord(
            asWork({
                authorships: [
                    { author: { display_name: 'A' }, is_corresponding: true },
                    { author: { display_name: 'B' }, is_corresponding: 'true' },
                    { author: { display_name: 'C' } },
                ],
            }),
        );
        expect(record.authors_detailed.map((a) => a.is_corresponding)).toEqual([true, false, false]);
    });

    test('orcid is bare normalized identifier, falls back to raw_orcid', () => {
        const record = toWorkRecord(
            asWork({
                authorships: [
                    { author: { display_name: 'A', orcid: 'https://orcid.org/0000-0000-0000-0021' } },
                    { author: { display_name: 'B', orcid: null }, raw_orcid: 'https://orcid.org/0000-0001-2345-6789' },
                    { author: { display_name: 'C', orcid: '   ' }, raw_orcid: null },
                    { author: { display_name: 'D', orcid: '' }, raw_orcid: 'https://orcid.org/0000-0001-2345-6789' },
                ],
            }),
        );
        expect(record.authors_detailed[3]?.orcid).toBe('0000-0001-2345-6789');
        expect(record.authors_detailed[0]?.orcid).toBe('0000-0000-0000-0021');
        expect(record.authors_detailed[1]?.orcid).toBe('0000-0001-2345-6789');
        expect(record.authors_detailed[2]?.orcid).toBeNull();
    });

    test('affiliations use the first non-empty source in the chain', () => {
        const fromRaw = toWorkRecord(
            asWork({
                authorships: [
                    {
                        author: { display_name: 'A' },
                        raw_affiliation_strings: ['Raw Affiliation'],
                        affiliations: [{ raw_affiliation_string: 'Structured Affiliation' }],
                        institutions: [{ display_name: 'Institution' }],
                    },
                ],
            }),
        );
        expect(fromRaw.authors_detailed[0]?.affiliations).toEqual(['Raw Affiliation']);

        const fromStructured = toWorkRecord(
            asWork({
                authorships: [
                    {
                        author: { display_name: 'A' },
                        raw_affiliation_strings: [],
                        affiliations: [{ raw_affiliation_string: 'Structured Affiliation' }],
                        institutions: [{ display_name: 'Institution' }],
                    },
                ],
            }),
        );
        expect(fromStructured.authors_detailed[0]?.affiliations).toEqual(['Structured Affiliation']);

        const fromInstitutions = toWorkRecord(
            asWork({
                authorships: [
                    {
                        author: { display_name: 'A' },
                        raw_affiliation_strings: [],
                        affiliations: [],
                        institutions: [{ display_name: 'Institution' }],
                    },
                ],
            }),
        );
        expect(fromInstitutions.authors_detailed[0]?.affiliations).toEqual(['Institution']);

        const none = toWorkRecord(asWork({ authorships: [{ author: { display_name: 'A' } }] }));
        expect(none.authors_detailed[0]?.affiliations).toEqual([]);
    });

    test('countries use countries[] then institutions[].country_code', () => {
        const fromCountries = toWorkRecord(
            asWork({
                authorships: [
                    {
                        author: { display_name: 'A' },
                        countries: ['US'],
                        institutions: [{ country_code: 'DE' }],
                    },
                ],
            }),
        );
        expect(fromCountries.authors_detailed[0]?.countries).toEqual(['US']);

        const fromInstitutions = toWorkRecord(
            asWork({
                authorships: [{ author: { display_name: 'A' }, countries: [], institutions: [{ country_code: 'DE' }] }],
            }),
        );
        expect(fromInstitutions.authors_detailed[0]?.countries).toEqual(['DE']);

        const none = toWorkRecord(asWork({ authorships: [{ author: { display_name: 'A' } }] }));
        expect(none.authors_detailed[0]?.countries).toEqual([]);
    });

    test('affiliations and countries are deduped and blank-free', () => {
        const record = toWorkRecord(
            asWork({
                authorships: [
                    {
                        author: { display_name: 'A' },
                        countries: ['US', 'US', '  ', 'DE'],
                        raw_affiliation_strings: ['Institution Alpha', 'Institution Alpha', ''],
                    },
                ],
            }),
        );
        expect(record.authors_detailed[0]?.countries).toEqual(['US', 'DE']);
        expect(record.authors_detailed[0]?.affiliations).toEqual(['Institution Alpha']);
    });
});

describe('classification rules', () => {
    test('topic_names, primary_topic_display_name and keyword_names', () => {
        const record = toWorkRecord(
            asWork({
                primary_topic: { display_name: 'Primary Topic', id: 'https://openalex.org/T1' },
                topics: [{ display_name: 'Topic A' }, { display_name: 'Topic B' }],
                keywords: [{ display_name: 'Keyword A' }],
            }),
        );
        expect(record.primary_topic_display_name).toBe('Primary Topic');
        expect(record.topic_names).toEqual(['Topic A', 'Topic B']);
        expect(record.keyword_names).toEqual(['Keyword A']);
    });

    test('topic_names, keyword_names and mesh_terms are deduped in first-occurrence order', () => {
        const record = toWorkRecord(
            asWork({
                topics: [{ display_name: 'B' }, { display_name: 'A' }, { display_name: 'B' }],
                keywords: [{ display_name: 'K' }, { display_name: 'K' }],
                mesh: [
                    { descriptor_name: 'Humans', qualifier_name: 'genetics' },
                    { descriptor_name: 'Humans', qualifier_name: 'metabolism' },
                    { descriptor_name: 'Mice' },
                ],
            }),
        );
        expect(record.topic_names).toEqual(['B', 'A']);
        expect(record.keyword_names).toEqual(['K']);
        expect(record.mesh_terms).toEqual(['Humans', 'Mice']);
    });

    test('mesh qualifiers are ignored entirely in mesh_terms', () => {
        const record = toWorkRecord(asWork({ mesh: [{ descriptor_name: 'Humans', qualifier_name: 'genetics' }] }));
        expect(record.mesh_terms).toEqual(['Humans']);
        expect(JSON.stringify(record.mesh_terms)).not.toContain('genetics');
    });

    test('blank and missing display names are dropped from derived lists', () => {
        const record = toWorkRecord(
            asWork({
                topics: [{ display_name: '  ' }, { display_name: 'Good' }, {}, null],
                keywords: [{ display_name: null }],
                mesh: [{ descriptor_name: '' }, { descriptor_name: 'Good Term' }],
            }),
        );
        expect(record.topic_names).toEqual(['Good']);
        expect(record.keyword_names).toEqual([]);
        expect(record.mesh_terms).toEqual(['Good Term']);
    });

    test('primary_topic_display_name is null when absent or blank', () => {
        expect(toWorkRecord(asWork({ primary_topic: null })).primary_topic_display_name).toBeNull();
        expect(toWorkRecord(asWork({ primary_topic: { display_name: ' ' } })).primary_topic_display_name).toBeNull();
        expect(toWorkRecord(asWork({ primary_topic: 'Topic' })).primary_topic_display_name).toBeNull();
    });

    test('funder_names fall back to awards[].funder_display_name only when funders yields nothing', () => {
        const fromFunders = toWorkRecord(
            asWork({
                funders: [{ display_name: 'Funder A' }],
                awards: [{ funder_display_name: 'Award Funder' }],
            }),
        );
        expect(fromFunders.funder_names).toEqual(['Funder A']);

        const fromAwards = toWorkRecord(
            asWork({
                funders: [],
                awards: [{ funder_display_name: 'Award Funder' }, { funder_display_name: 'Award Funder' }],
            }),
        );
        expect(fromAwards.funder_names).toEqual(['Award Funder']);

        const fromAwardsWhenFundersAreBlank = toWorkRecord(
            asWork({
                funders: [{ display_name: '  ' }],
                awards: [{ funder_display_name: 'Award Funder' }],
            }),
        );
        expect(fromAwardsWhenFundersAreBlank.funder_names).toEqual(['Award Funder']);

        expect(toWorkRecord(asWork({ funders: [], awards: [] })).funder_names).toEqual([]);
    });

    test('funder IDs never leak into the funder_names array', () => {
        const record = toWorkRecord(asWork({ funders: [{ id: 'https://openalex.org/F1', display_name: 'Funder A' }] }));
        expect(record.funder_names).toEqual(['Funder A']);
    });
});

describe('open-access rules', () => {
    test('open_access_is_oa comes directly from open_access.is_oa without location fallback', () => {
        expect(toWorkRecord(asWork({ open_access: { is_oa: true } })).open_access_is_oa).toBe(true);
        expect(toWorkRecord(asWork({ open_access: { is_oa: false } })).open_access_is_oa).toBe(false);
        expect(toWorkRecord(asWork({ open_access: { is_oa: 'true' } })).open_access_is_oa).toBe(false);
        expect(toWorkRecord(asWork({ locations: [{ is_oa: true }] })).open_access_is_oa).toBe(false);
    });

    test('oa_locations includes only strictly is_oa === true entries', () => {
        const record = toWorkRecord(
            asWork({
                locations: [
                    { is_oa: true, landing_page_url: 'https://a.test' },
                    { is_oa: false, landing_page_url: 'https://b.test' },
                    { is_oa: 'true', landing_page_url: 'https://c.test' },
                    { is_oa: 1, landing_page_url: 'https://d.test' },
                    { landing_page_url: 'https://e.test' },
                ],
            }),
        );
        expect(record.oa_locations.map((l) => l.landing_page_url)).toEqual(['https://a.test']);
    });

    test('an oa_location with nothing but is_oa still has every key, none undefined', () => {
        const record = toWorkRecord(asWork({ locations: [{ is_oa: true }] }));
        expect(record.oa_locations[0]).toEqual({
            doi: null,
            landing_page_url: null,
            pdf_url: null,
            license: null,
            version: null,
            source_name: null,
            source_type: null,
            is_published: null,
        });
    });

    test('an unknown upstream version string is preserved, not narrowed away', () => {
        const record = toWorkRecord(asWork({ locations: [{ is_oa: true, version: 'someFutureVersion' }] }));
        expect(record.oa_locations[0]?.version).toBe('someFutureVersion');
    });

    test('a non-array locations field yields []', () => {
        expect(toWorkRecord(asWork({ locations: 'nope' })).oa_locations).toEqual([]);
        expect(toWorkRecord(asWork({ locations: null })).oa_locations).toEqual([]);
    });
});

describe('record DOIs go through the same prefix-only normalization as input', () => {
    test('a DOI ending in punctuation or an unbalanced parenthesis stays intact', () => {
        for (const doi of ['10.1234/abc.', '10.1234/abc)', '10.1234/a(b', '10.1234/abc;', '10.1234/a%2fb']) {
            const record = toWorkRecord(
                asWork({ doi: `https://doi.org/${doi}`, ids: { doi: `https://doi.org/${doi}` } }),
            );
            expect(record.doi).toBe(doi);
            expect(record.ids_doi).toBe(doi);
        }
    });

    test('a SICI DOI keeps every special character', () => {
        const doi = '10.5555/(sici)1097-0258(19980815/30)17:15/16<1661::aid-sim968>3.0.co;2-2';
        expect(toWorkRecord(asWork({ doi: `https://doi.org/${doi.toUpperCase()}` })).doi).toBe(doi);
    });

    test('something that is not a DOI is null', () => {
        for (const doi of ['https://doi.org/', 'not a doi', 'https://example.org/10.1234/x', 42]) {
            expect(toWorkRecord(asWork({ doi })).doi).toBeNull();
        }
    });
});

describe('volume, study designs, location DOIs, listed_in, observed ORCIDs', () => {
    const location = {
        is_oa: true,
        doi: 'https://doi.org/10.5555/epsilon.0000.00005',
        landing_page_url: 'https://example.org/abs/0000.00005',
        source: {
            id: 'https://openalex.org/S1',
            display_name: 'Repository Alpha',
            listed_in: ['doaj', ' ', 'cwts-core'],
        },
    };
    const record = toWorkRecord(
        asWork({
            volume: { id: 'https://openalex.org/W9000000014', display_name: 'The Book' },
            study_designs: [{ id: 'https://openalex.org/study-designs/rct', display_name: 'RCT' }],
            primary_location: location,
            best_oa_location: location,
            locations: [location],
            authorships: [
                {
                    author: {
                        display_name: 'A',
                        observed_orcids: ['https://orcid.org/0000-0000-0000-0001', null, '0000-0000-0000-0002'],
                    },
                },
            ],
        }),
    );

    test('the containing work flattens to volume_*', () => {
        expect(record.volume_id).toBe('W9000000014');
        expect(record.volume_display_name).toBe('The Book');
        expect(toWorkRecord(asWork({ volume: null })).volume_id).toBeNull();
    });

    test('volume_id is a work id: normalized like id, null when it is not one', () => {
        const lower = toWorkRecord(asWork({ volume: { id: 'https://openalex.org/w123', display_name: 'B' } }));
        expect(lower.volume_id).toBe('W123');
        expect(toWorkRecord(asWork({ volume: { id: 'not-a-work', display_name: 'B' } })).volume_id).toBeNull();
    });

    test('study designs keep their bare ids', () => {
        expect(record.study_designs).toEqual([{ id: 'rct', display_name: 'RCT' }]);
    });

    test('each location carries its own DOI, also on the OA list', () => {
        expect(record.primary_location_doi).toBe('10.5555/epsilon.0000.00005');
        expect(record.best_oa_location_doi).toBe('10.5555/epsilon.0000.00005');
        expect(record.locations[0]?.doi).toBe('10.5555/epsilon.0000.00005');
        expect(record.oa_locations[0]?.doi).toBe('10.5555/epsilon.0000.00005');
    });

    test('listed_in drops blanks', () => {
        expect(record.primary_location_source_listed_in).toEqual(['doaj', 'cwts-core']);
        expect(toWorkRecord(asWork({ primary_location: null })).primary_location_source_listed_in).toEqual([]);
    });

    test('observed ORCIDs are bare and blank-free', () => {
        expect(record.authorships[0]?.author_observed_orcids).toEqual(['0000-0000-0000-0001', '0000-0000-0000-0002']);
    });
});

describe('string arrays are deduplicated, first occurrence wins', () => {
    test('texts, refs and orcids leaves drop repeats after normalization', () => {
        const record = toWorkRecord(
            asWork({
                indexed_in: ['crossref', 'pubmed', 'crossref'],
                corresponding_author_ids: ['https://openalex.org/A2', 'A1', 'A2'],
                authorships: [
                    {
                        author: {
                            display_name: 'A',
                            observed_orcids: ['https://orcid.org/0000-0000-0000-0001', '0000-0000-0000-0001'],
                        },
                    },
                ],
            }),
        );
        expect(record.indexed_in).toEqual(['crossref', 'pubmed']);
        expect(record.corresponding_author_ids).toEqual(['A2', 'A1']);
        expect(record.authorships[0]?.author_observed_orcids).toEqual(['0000-0000-0000-0001']);
    });
});

describe('work ids inside the record match record.id', () => {
    const record = toWorkRecord(
        asWork({
            ids: { openalex: 'https://openalex.org/w9000000011' },
            referenced_works: ['https://openalex.org/w1', 'W2', 'https://openalex.org/W1', 'nope', null],
            related_works: ['w3', 'https://openalex.org/authors/A1', 'W3'],
        }),
    );

    test('ids_openalex is an uppercase W id', () => {
        expect(record.ids_openalex).toBe('W9000000011');
        expect(toWorkRecord(asWork({ ids: { openalex: 'nope' } })).ids_openalex).toBeNull();
    });

    test('referenced_works and related_works are uppercase, valid and deduped', () => {
        expect(record.referenced_works).toEqual(['W1', 'W2']);
        expect(record.related_works).toEqual(['W3']);
    });
});
