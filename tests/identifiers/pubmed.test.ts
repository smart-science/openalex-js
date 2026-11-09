// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';

import { normalizePmcid, normalizePmid } from '../../src/identifiers/pubmed.js';
import { HOSTILE_VALUES } from '../helpers.js';

describe('normalizePmid', () => {
    const accepted: readonly [unknown, string][] = [
        ['https://pubmed.ncbi.nlm.nih.gov/99000001', '99000001'],
        ['https://pubmed.ncbi.nlm.nih.gov/99000001/', '99000001'],
        ['http://pubmed.ncbi.nlm.nih.gov/99000001', '99000001'],
        ['https://www.pubmed.ncbi.nlm.nih.gov/99000001', '99000001'],
        ['HTTPS://PUBMED.NCBI.NLM.NIH.GOV/99000001', '99000001'],
        // The legacy PubMed path, still emitted by older records and third-party citations.
        ['https://www.ncbi.nlm.nih.gov/pubmed/99000001', '99000001'],
        ['https://ncbi.nlm.nih.gov/pubmed/99000001/', '99000001'],
        // A query string or fragment is decoration, never part of the id.
        ['https://pubmed.ncbi.nlm.nih.gov/99000001/?report=abstract', '99000001'],
        ['https://pubmed.ncbi.nlm.nih.gov/99000001?from_term=cancer', '99000001'],
        ['https://pubmed.ncbi.nlm.nih.gov/99000001/#abstract', '99000001'],
        // A label in front of a URL: the decoration is stripped after the label.
        ['pmid:https://pubmed.ncbi.nlm.nih.gov/99000001', '99000001'],
        ['pmid:https://pubmed.ncbi.nlm.nih.gov/99000001?from_term=cancer', '99000001'],
        ['pmid:99000001', '99000001'],
        ['PMID: 99000001', '99000001'],
        ['urn:pmid:99000001', '99000001'],
        ['  99000001  ', '99000001'],
        ['  https://pubmed.ncbi.nlm.nih.gov/99000001/  ', '99000001'],
        ['99000001', '99000001'],
        // A JSON number is coerced rather than dropped.
        [99000001, '99000001'],
    ];

    for (const [input, expected] of accepted) {
        test(`${JSON.stringify(input)} → ${expected}`, () => {
            expect(normalizePmid(input)).toBe(expected);
        });
    }

    const rejected: readonly unknown[] = [
        '',
        '   ',
        'no-digits-here',
        'PMC9900001',
        '99000001x',
        'x99000001',
        '239 037 48',
        '23.903748',
        '-99000001',
        null,
        undefined,
        true,
        {},
        [],
        Number.NaN,
        Number.POSITIVE_INFINITY,
        99000001.5,
        'https://pubmed.ncbi.nlm.nih.gov/',
        'https://example.com/99000001',
        'https://example.com/pubmed/99000001',
        // A path segment past the accession is a different resource, not the id.
        'https://pubmed.ncbi.nlm.nih.gov/99000001/citedby',
        // The accession lives in the path; a query parameter is not a substitute for it.
        'https://pubmed.ncbi.nlm.nih.gov/?term=99000001',
        // An accession is a positive integer assigned in sequence.
        '0',
        0,
        '00',
        '007',
        -99000001,
        // `?`/`#` and a trailing `/` are only decoration on a URL; in a bare value they are corruption.
        '99000001?report=abstract',
        '99000001#abstract',
        '99000001/',
    ];

    for (const input of rejected) {
        test(`${String(typeof input)} ${JSON.stringify(input) ?? 'undefined'} → null`, () => {
            expect(normalizePmid(input)).toBeNull();
        });
    }

    test('a fractional number is not an identifier', () => {
        expect(normalizePmid(99000001.5)).toBeNull();
    });

    test('an unsafe integer is rejected, not rounded', () => {
        expect(normalizePmid(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
        expect(normalizePmcid(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
    });

    test('never throws for any hostile value', () => {
        for (const value of HOSTILE_VALUES) {
            expect(() => normalizePmid(value)).not.toThrow();
        }
    });
});

describe('normalizePmcid', () => {
    const accepted: readonly [unknown, string][] = [
        ['https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9900001', 'PMC9900001'],
        ['https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9900001/', 'PMC9900001'],
        ['https://ncbi.nlm.nih.gov/pmc/articles/PMC9900001', 'PMC9900001'],
        ['http://www.ncbi.nlm.nih.gov/pmc/articles/PMC9900001//', 'PMC9900001'],
        // The current PMC host, which NCBI moved articles to.
        ['https://pmc.ncbi.nlm.nih.gov/articles/PMC9900001/', 'PMC9900001'],
        ['https://pmc.ncbi.nlm.nih.gov/articles/PMC9900001', 'PMC9900001'],
        ['http://pmc.ncbi.nlm.nih.gov/articles/pmc9900001//', 'PMC9900001'],
        // A query string or fragment is decoration, never part of the id.
        ['https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9900001/#sec1', 'PMC9900001'],
        ['https://pmc.ncbi.nlm.nih.gov/articles/PMC9900001/?report=classic', 'PMC9900001'],
        ['PMC9900001', 'PMC9900001'],
        ['pmc9900001', 'PMC9900001'],
        ['  PMC9900001  ', 'PMC9900001'],
        ['  https://pmc.ncbi.nlm.nih.gov/articles/PMC9900001/  ', 'PMC9900001'],
        ['pmcid:PMC9900001', 'PMC9900001'],
        ['PMCID: PMC9900001', 'PMC9900001'],
        ['urn:pmc:9900001', 'PMC9900001'],
        // The PMC prefix is restored when the value carries only digits.
        ['9900001', 'PMC9900001'],
        [9900001, 'PMC9900001'],
        ['pmc:9900001', 'PMC9900001'],
        // A label in front of a URL, as normalizePmid accepts it.
        ['pmcid:https://pmc.ncbi.nlm.nih.gov/articles/PMC9900001', 'PMC9900001'],
        ['pmcid:https://pmc.ncbi.nlm.nih.gov/articles/PMC9900001/?report=classic', 'PMC9900001'],
    ];

    for (const [input, expected] of accepted) {
        test(`${JSON.stringify(input)} → ${expected}`, () => {
            expect(normalizePmcid(input)).toBe(expected);
        });
    }

    const rejected: readonly unknown[] = [
        '',
        '   ',
        'no-digits-here',
        'PMC',
        'PMCX9900001',
        'PMC 9900001',
        'PMC9900001x',
        null,
        undefined,
        true,
        {},
        [],
        Number.NaN,
        'https://www.ncbi.nlm.nih.gov/pmc/articles/',
        'https://pmc.ncbi.nlm.nih.gov/articles/',
        // `/articles/` is part of the PMC path; the accession off the host root is not an id.
        'https://pmc.ncbi.nlm.nih.gov/PMC9900001',
        'https://example.com/articles/PMC9900001',
        // An accession is a positive integer assigned in sequence.
        'PMC0',
        'PMC007',
        '0',
        0,
        '007',
        -9900001,
        // `?`/`#` and a trailing `/` are only decoration on a URL; in a bare value they are corruption.
        'PMC9900001?report=classic',
        'PMC9900001#sec1',
        'PMC9900001/',
    ];

    for (const input of rejected) {
        test(`${String(typeof input)} ${JSON.stringify(input) ?? 'undefined'} → null`, () => {
            expect(normalizePmcid(input)).toBeNull();
        });
    }

    test('a lowercase URL form is uppercased to the canonical accession', () => {
        expect(normalizePmcid('https://www.ncbi.nlm.nih.gov/pmc/articles/pmc9900001')).toBe('PMC9900001');
    });

    test('never throws for any hostile value', () => {
        for (const value of HOSTILE_VALUES) {
            expect(() => normalizePmcid(value)).not.toThrow();
        }
    });
});
