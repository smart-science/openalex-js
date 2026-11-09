// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';

import { encodeDoi, normalizeDoi } from '../../src/identifiers/doi.js';
import { asDoi } from '../helpers.js';

const CANONICAL = '10.5555/alpha00001';

const EQUIVALENT_FORMS = [
    '10.5555/alpha00001',
    '10.5555/ALPHA00001',
    'https://doi.org/10.5555/alpha00001',
    'http://doi.org/10.5555/alpha00001',
    'https://dx.doi.org/10.5555/alpha00001',
    'http://dx.doi.org/10.5555/alpha00001',
    'https://www.doi.org/10.5555/alpha00001',
    'doi.org/10.5555/alpha00001',
    'HTTPS://DOI.ORG/10.5555/ALPHA00001',
    'doi:10.5555/alpha00001',
    'DOI: 10.5555/alpha00001',
    'DOI 10.5555/alpha00001',
    'DOI:\t10.5555/alpha00001',
    '\n\t 10.5555/alpha00001 \r\n',
    '  DOI: HTTPS://DX.DOI.ORG/10.5555/ALPHA00001  ',
    'https://doi.org/doi:10.5555/alpha00001',
    'https://doi.org/DOI: 10.5555/alpha00001',
];

const EMOJI_DOI = '10.1000/a\u{1F600}';

describe('normalizeDoi — every prefix form collapses to one output', () => {
    for (const form of EQUIVALENT_FORMS) {
        test(JSON.stringify(form), () => {
            expect(normalizeDoi(form)).toBe(CANONICAL);
        });
    }

    test('normalization is idempotent', () => {
        for (const form of EQUIVALENT_FORMS) {
            const once = normalizeDoi(form) as string;
            expect(normalizeDoi(once), form).toBe(once);
        }
    });

    test('the fixture DOIs all normalize', () => {
        expect(normalizeDoi('https://doi.org/10.5555/journal.beta.0000002')).toBe('10.5555/journal.beta.0000002');
        expect(normalizeDoi('https://doi.org/10.5555/gamma.000.0003')).toBe('10.5555/gamma.000.0003');
        expect(normalizeDoi('https://doi.org/10.5555/Delta.0000.00004')).toBe('10.5555/delta.0000.00004');
    });
});

describe('normalizeDoi — the suffix is kept exactly (lowercased)', () => {
    const kept: readonly string[] = [
        '10.1000/182.',
        '10.1000/182)',
        '10.1000/182,',
        '10.1000/182;',
        '10.1000/...',
        '10.5555/s0140-6736(03)12113-7',
        '10.5555/(sici)1097-0258(19980815)17:15<1661::aid-sim968>3.0.co;2-2',
        '10.1000/xyz;(1)#a?b&c',
        '10.1000/xyz?via=ihub',
        '10.1234/foo%2e',
        '10.5555/%zz',
        '10.5555/alpha 00001',
        EMOJI_DOI,
    ];

    for (const doi of kept) {
        test(JSON.stringify(doi), () => {
            expect(normalizeDoi(doi)).toBe(doi);
            expect(normalizeDoi(`https://doi.org/${doi}`)).toBe(doi);
        });
    }

    test('a resolver URL keeps its query string and fragment — they may belong to the DOI', () => {
        expect(normalizeDoi('https://doi.org/10.1000/xyz?via=ihub#s2')).toBe('10.1000/xyz?via=ihub#s2');
        expect(normalizeDoi('https://doi.org/doi:10.1000/xyz?via=ihub#s2')).toBe('10.1000/xyz?via=ihub#s2');
    });
});

describe('normalizeDoi — what is not a plausible DOI', () => {
    const invalid: readonly [string, string][] = [
        ['not-a-doi', 'no registrant prefix'],
        ['', 'empty'],
        ['   ', 'whitespace only'],
        ['10.5555', 'no suffix'],
        ['10.5555/', 'empty suffix'],
        ['https://doi.org/', 'a bare resolver URL'],
        ['10.123/x', 'registrant prefix too short'],
        ['10.1234567890/x', 'registrant prefix too long'],
        ['11.5555/alpha00001', 'not a DOI namespace'],
        ['10.5555%2Falpha00001', 'percent-encoded slash — no decoding'],
        ['10.5555/alpha\t00001', 'control character'],
        ['10.5555/alpha\n00001', 'control character'],
        ['10.5555/alpha\u0000', 'NUL'],
        ['10.1000/a\ud800', 'lone surrogate'],
        ['https://example.org/10.5555/alpha00001', 'not a doi.org URL'],
    ];

    for (const [input, why] of invalid) {
        test(`${JSON.stringify(input)} → null (${why})`, () => {
            expect(normalizeDoi(input)).toBeNull();
        });
    }
});

describe('normalizeDoi handles hostile input safely', () => {
    const hostile: readonly [string, unknown][] = [
        ['undefined', undefined],
        ['null', null],
        ['a number', 10.5555],
        ['NaN', Number.NaN],
        ['true', true],
        ['an array', ['10.5555/alpha00001']],
        ['a plain object', { doi: '10.5555/alpha00001' }],
        ['a function', () => '10.5555/alpha00001'],
        ['a Date', new Date(0)],
    ];

    for (const [label, value] of hostile) {
        test(`${label} returns null and does not throw`, () => {
            expect(() => normalizeDoi(asDoi(value))).not.toThrow();
            expect(normalizeDoi(asDoi(value))).toBeNull();
        });
    }
});

describe('encodeDoi path building', () => {
    test('prefixes doi: and percent-encodes the slash', () => {
        expect(encodeDoi('10.5555/alpha00001')).toBe('doi:10.5555%2Falpha00001');
        expect(encodeDoi('10.5555/journal.beta.0000002')).toBe('doi:10.5555%2Fjournal.beta.0000002');
        expect(encodeDoi('')).toBe('doi:');
    });

    test('round-trips: decoding the encoded part returns the DOI', () => {
        const dois = [
            '10.5555/alpha00001',
            '10.5555/s0140-6736(03)12113-7',
            '10.1000/abc;def#ghi?jkl&mno',
            '10.5555/(sici)1097-0258(19980815)17:15<1661::aid-sim968>3.0.co;2-2',
            '10.5555/%zz',
            '10.5555/alpha 00001',
            EMOJI_DOI,
        ];
        for (const doi of dois) {
            expect(decodeURIComponent(encodeDoi(doi).slice('doi:'.length)), doi).toBe(doi);
        }
    });

    test('produced path is a single URL segment without query or fragment', () => {
        const path = encodeDoi('10.1000/abc?def#ghi&jkl');
        expect(path).toContain('%3F');
        expect(path).toContain('%23');
        expect(path).toContain('%26');

        const url = new URL(`https://api.openalex.org/works/${encodeDoi('10.5555/s0140-6736(03)12113-7')}`);
        expect(url.search).toBe('');
        expect(url.hash).toBe('');
        expect(url.pathname.split('/')).toHaveLength(3);
    });

    test('never throws on hostile input', () => {
        for (const value of [undefined, null, 42, {}]) {
            expect(() => encodeDoi(asDoi(value))).not.toThrow();
        }
    });
});
