// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import * as api from '../src/index.js';
import { loadPackageJson } from './helpers.js';

const EXPECTED_RUNTIME_EXPORTS = [
    'API_BASE_URL',
    'CONTENT_BASE_URL',
    'DEFAULT_CONTENT_TIMEOUT_MS',
    'DEFAULT_TIMEOUT_MS',
    'FIELD_NAMES',
    'MAX_FILTER_VALUES',
    'PACKAGE_VERSION',
    'SEMANTIC_MAP',
    'applyRename',
    'createOpenAlex',
    'isFieldName',
    'normalizeDoi',
    'normalizeWorkId',
    'reconstructAbstract',
    'toWorkRecord',
];

describe('runtime export surface', () => {
    test('expected names and nothing else', () => {
        expect(Object.keys(api).sort()).toEqual([...EXPECTED_RUNTIME_EXPORTS].sort());
    });

    test('internal helpers do not leak', () => {
        for (const name of ['createError', 'ERROR_MESSAGES', 'ok', 'err', 'request', 'requestWork']) {
            expect(Object.keys(api), `${name} must stay internal`).not.toContain(name);
        }
    });

    test('no standalone lookups: all requests require client queue', () => {
        for (const name of ['fetchDoi', 'fetchWorkById', 'fetchContent', 'fetchBudget']) {
            expect(Object.keys(api)).not.toContain(name);
        }
    });

    test('there is no default export', () => {
        expect(Object.keys(api)).not.toContain('default');
    });

    test('PACKAGE_VERSION matches package.json', async () => {
        const pkg = await loadPackageJson();
        expect(api.PACKAGE_VERSION).toBe(pkg.version as string);
        expect(pkg.name).toBe('@smart-science/openalex');
    });
});

describe('the surface works end to end from the entry point alone', () => {
    test('every export is usable', async () => {
        expect(api.normalizeDoi('https://doi.org/10.5555/ALPHA00001')).toBe('10.5555/alpha00001');
        expect(api.normalizeWorkId('https://openalex.org/W9000000011')).toBe('W9000000011');
        expect(api.reconstructAbstract({ a: [0], b: [1] })).toBe('a b');

        const record = api.toWorkRecord({ id: 'W1' } as Parameters<typeof api.toWorkRecord>[0]);
        expect(record?.id).toBe('W1');
        expect(api.toWorkRecord({} as Parameters<typeof api.toWorkRecord>[0])).toBeNull();

        const renamed = api.applyRename(record as NonNullable<typeof record>, { ref_title: 'title' });
        expect(renamed.ok).toBe(true);

        const client = api.createOpenAlex();
        expect((await client.fetchDoi('not-a-doi')).ok).toBe(false);
        expect((await client.fetchWorkById('not-an-id')).ok).toBe(false);
        expect((await client.fetchContent('W1')).ok).toBe(false);
        expect((await client.fetchBudget()).ok).toBe(false);
        expect((await api.createOpenAlex({ apiKey: 'k' }).fetchContent('not-an-id')).ok).toBe(false);

        expect(api.API_BASE_URL).toBe('https://api.openalex.org');
        expect(api.CONTENT_BASE_URL).toBe('https://content.openalex.org');
        expect(api.DEFAULT_TIMEOUT_MS).toBe(10_000);
        expect(api.DEFAULT_CONTENT_TIMEOUT_MS).toBe(60_000);
        expect(api.isFieldName('id')).toBe(true);
        expect(api.FIELD_NAMES.length).toBe(141);
    });
});
