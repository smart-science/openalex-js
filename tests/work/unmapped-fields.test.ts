// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';

import { loadWork } from '../helpers.js';
import { unmappedFields } from './unmapped-fields.js';

const FIXTURES = ['work-article', 'work-legacy', 'work-open-access', 'work-preprint'] as const;

describe('unmappedFields', () => {
    for (const name of FIXTURES) {
        test(`${name} has no field outside the flat schema`, async () => {
            expect(unmappedFields(await loadWork(name))).toEqual([]);
        });
    }

    test('reports new fields at every depth', () => {
        const raw = {
            id: 'https://openalex.org/W1',
            brand_new: 1,
            primary_location: { is_oa: true, source: { id: 'S1', new_source_flag: true } },
            authorships: [{ author: { id: 'A1', new_author_field: 'x' } }, { new_authorship_field: 2 }],
            abstract_inverted_index: { a: [0] },
        };
        expect(unmappedFields(raw)).toEqual([
            'authorships[].author.new_author_field',
            'authorships[].new_authorship_field',
            'brand_new',
            'primary_location.source.new_source_flag',
        ]);
    });

    test('null objects and non-array lists are skipped, not reported', () => {
        expect(unmappedFields({ primary_location: null, locations: null, authorships: 'x' })).toEqual([]);
    });
});
