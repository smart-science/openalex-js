// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';

import { createOpenAlex } from '../../src/index.js';
import { unmappedFields } from '../work/unmapped-fields.js';

const DOIS = [
    '10.1038/nature12373',
    '10.1038/s41586-020-2649-2',
    '10.1056/nejmoa2034577',
    '10.48550/arxiv.2404.19756',
    '10.1103/physrev.109.1492',
    '10.1371/journal.pone.0000308',
    '10.1002/(sici)1097-0258(19980815/30)17:15/16<1661::aid-sim968>3.0.co;2-2',
];

const apiKey = Bun.env.OPENALEX_API_KEY;
const openAlex = createOpenAlex(apiKey ? { apiKey } : {});

describe.skipIf(Bun.env.OPENALEX_LIVE !== '1')('live: every upstream field is mapped', () => {
    for (const doi of DOIS) {
        test(doi, async () => {
            const result = await openAlex.fetchDoi(doi);
            if (!result.ok) {
                throw new Error(`${result.error.code}: ${result.error.message}`);
            }
            expect(unmappedFields(result.data.raw)).toEqual([]);
        }, 30_000);
    }
});
