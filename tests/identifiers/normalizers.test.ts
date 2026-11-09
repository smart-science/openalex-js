// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import { normalizeOrcid, normalizeRor, normalizeWikidata, stripOpenAlexUrl } from '../../src/identifiers/bare-ids.js';

describe('identifier normalizers', () => {
    describe('stripOpenAlexUrl', () => {
        const cases: readonly [unknown, string | null][] = [
            ['https://openalex.org/W9000000011', 'W9000000011'],
            ['http://openalex.org/W9000000011', 'W9000000011'],
            ['https://www.openalex.org/W9000000011', 'W9000000011'],
            ['https://api.openalex.org/works/W9000000011', 'W9000000011'],
            ['https://openalex.org/subfields/1703', '1703'],
            ['https://openalex.org/licenses/cc-by', 'cc-by'],
            ['https://openalex.org/W9000000011/', 'W9000000011'],
            ['https://openalex.org/W9000000011?select=id,title#sec', 'W9000000011'],
            ['W9000000011', 'W9000000011'],
            ['  W9000000011  ', 'W9000000011'],
            ['https://openalex.org', null],
            ['https://openalex.org/', null],
            ['https://openalex.org?foo=1', null],
            ['https://openalex.org#x', null],
            ['not an openalex url', 'not an openalex url'],
            ['', null],
            ['   ', null],
            [null, null],
            [undefined, null],
            [123, null],
            [{}, null],
        ];

        for (const [input, expected] of cases) {
            test(`stripOpenAlexUrl(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, () => {
                expect(stripOpenAlexUrl(input)).toBe(expected);
            });
        }
    });

    describe('normalizeOrcid', () => {
        const cases: readonly [unknown, string | null][] = [
            ['https://orcid.org/0000-0000-0000-0013', '0000-0000-0000-0013'],
            ['http://orcid.org/0000-0000-0000-0013', '0000-0000-0000-0013'],
            ['https://www.orcid.org/0000-0000-0000-0013', '0000-0000-0000-0013'],
            ['https://orcid.org/0000-0000-0000-0013/', '0000-0000-0000-0013'],
            ['https://orcid.org/0000-0000-0000-0013?v=1#hash', '0000-0000-0000-0013'],
            ['0000-0000-0000-0013', '0000-0000-0000-0013'],
            ['  0000-0000-0000-0013  ', '0000-0000-0000-0013'],
            ['https://orcid.org', null],
            ['https://orcid.org/', null],
            ['https://orcid.org#top', null],
            ['https://orcid.org//0000-0000-0000-0013', '0000-0000-0000-0013'],
            ['custom-identifier', 'custom-identifier'],
            ['', null],
            ['   ', null],
            [null, null],
            [undefined, null],
            [42, null],
        ];

        for (const [input, expected] of cases) {
            test(`normalizeOrcid(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, () => {
                expect(normalizeOrcid(input)).toBe(expected);
            });
        }
    });

    describe('normalizeRor', () => {
        const cases: readonly [unknown, string | null][] = [
            ['https://ror.org/000000001', '000000001'],
            ['http://ror.org/000000001', '000000001'],
            ['https://www.ror.org/000000001/', '000000001'],
            ['https://ror.org/000000001?search=true', '000000001'],
            ['000000001', '000000001'],
            ['  000000001  ', '000000001'],
            ['https://ror.org', null],
            ['https://ror.org/', null],
            ['https://ror.org//000000001', '000000001'],
            ['custom-ror', 'custom-ror'],
            ['', null],
            ['   ', null],
            [null, null],
            [undefined, null],
            [true, null],
        ];

        for (const [input, expected] of cases) {
            test(`normalizeRor(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, () => {
                expect(normalizeRor(input)).toBe(expected);
            });
        }
    });

    describe('normalizeWikidata', () => {
        const cases: readonly [unknown, string | null][] = [
            ['https://www.wikidata.org/wiki/Q21198', 'Q21198'],
            ['https://wikidata.org/wiki/Q21198', 'Q21198'],
            ['http://www.wikidata.org/wiki/Q21198/', 'Q21198'],
            ['https://www.wikidata.org/wiki/Q21198?foo=bar', 'Q21198'],
            ['Q21198', 'Q21198'],
            ['  Q21198  ', 'Q21198'],
            ['https://wikidata.org', null],
            ['https://wikidata.org/', null],
            ['https://wikidata.org/wiki', null],
            ['https://wikidata.org/wiki/', null],
            ['wikidata-custom', 'wikidata-custom'],
            ['', null],
            ['   ', null],
            [null, null],
            [undefined, null],
            [99, null],
        ];

        for (const [input, expected] of cases) {
            test(`normalizeWikidata(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, () => {
                expect(normalizeWikidata(input)).toBe(expected);
            });
        }
    });
});
