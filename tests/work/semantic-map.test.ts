// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';

import type { WorkRecord } from '../../src/work/record-types.js';
import { applyRename, validateRenameMap } from '../../src/work/rename.js';
import { SEMANTIC_MAP } from '../../src/work/semantic-map.js';
import { toWorkRecord } from '../../src/work/to-record.js';
import { loadWork, okOf } from '../helpers.js';

async function record(): Promise<WorkRecord> {
    const shaped = toWorkRecord(await loadWork('work-article'));
    if (shaped === null) {
        throw new Error('toWorkRecord rejected the fixture');
    }
    return shaped;
}

describe('SEMANTIC_MAP', () => {
    test('is a valid rename map without collisions', () => {
        expect(validateRenameMap(SEMANTIC_MAP)).toBeNull();
    });

    test('puts the shared names on a record and moves the keyword objects', async () => {
        const source = await record();
        const data = okOf(applyRename(source, SEMANTIC_MAP)).data as Record<string, unknown>;
        expect(data.year).toBe(source.publication_year);
        expect(data.container_title).toBe(source.journal);
        expect(data.openalex_id).toBe(source.id);
        expect(data.keywords).toBe(source.keyword_names);
        expect(data.keywords_detailed).toBe(source.keywords);
        expect(data.title).toBe(source.title);
        expect('publication_year' in data).toBe(false);
        expect('keyword_names' in data).toBe(false);
    });
});
