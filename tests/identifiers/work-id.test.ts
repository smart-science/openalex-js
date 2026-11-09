// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';

import { normalizeWorkId } from '../../src/identifiers/work-id.js';
import { HOSTILE_VALUES } from '../helpers.js';

describe('normalizeWorkId', () => {
    test('accepts the bare id, any case, and the URL form raw.id uses', () => {
        for (const input of [
            'W9000000012',
            'w9000000012',
            '  W9000000012 ',
            'https://openalex.org/W9000000012',
            'http://openalex.org/w9000000012',
            'https://www.openalex.org/W9000000012',
            'https://openalex.org/works/W9000000012',
            'https://api.openalex.org/works/W9000000012',
            'https://openalex.org/works/W9000000012/',
            'https://openalex.org/W9000000012?utm_source=share',
            'https://openalex.org/works/W9000000012/?utm_source=share',
            'https://openalex.org/W9000000012#abstract',
        ]) {
            expect(normalizeWorkId(input), input).toBe('W9000000012');
        }
    });

    test('rejects DOIs and other entity ids', () => {
        for (const input of [
            '10.5555/alpha00001',
            'doi:10.5555/alpha00001',
            'https://doi.org/10.5555/alpha00001',
            'A9000000099',
            'https://openalex.org/A9000000099',
            'W',
            'W-1',
            'W1.5',
            // The number is a positive integer without leading zeros.
            'W0',
            'w0',
            'W00',
            'W007',
            'https://openalex.org/W0',
            'https://example.org/W1',
            'https://openalex.org/authors/W1',
            // A bare value carries no URL decoration: `?`, `#` and `/` there are corruption.
            'W1?utm_source=share',
            'W1#abstract',
            'W1/',
            'openalex.org/W1',
        ]) {
            expect(normalizeWorkId(input), input).toBeNull();
        }
    });

    test('never throws on hostile input', () => {
        for (const value of HOSTILE_VALUES) {
            expect(() => normalizeWorkId(value)).not.toThrow();
            if (typeof value !== 'string') {
                expect(normalizeWorkId(value)).toBeNull();
            }
        }
    });
});
