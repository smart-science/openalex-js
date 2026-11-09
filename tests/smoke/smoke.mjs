// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as pkg from '@smart-science/openalex';
import manifest from '@smart-science/openalex/package.json' with { type: 'json' };

// The runtime surface is exactly these names; anything else is public API by accident.
assert.deepEqual(Object.keys(pkg).sort(), [
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
]);

assert.equal(pkg.API_BASE_URL, 'https://api.openalex.org');
assert.equal(pkg.CONTENT_BASE_URL, 'https://content.openalex.org');
assert.equal(pkg.DEFAULT_TIMEOUT_MS, 10_000);
assert.equal(pkg.DEFAULT_CONTENT_TIMEOUT_MS, 60_000);
assert.equal(pkg.PACKAGE_VERSION, manifest.version);
assert.equal(pkg.MAX_FILTER_VALUES, 100);
assert.equal(pkg.normalizeDoi('https://doi.org/10.5555/ALPHA00001'), '10.5555/alpha00001');
assert.equal(pkg.normalizeWorkId('https://openalex.org/w9000000001'), 'W9000000001');
assert.equal(pkg.isFieldName('id'), true);
assert.equal(pkg.isFieldName('notAField'), false);
assert.ok(Array.isArray(pkg.FIELD_NAMES) && pkg.FIELD_NAMES.length > 0);
assert.equal(pkg.reconstructAbstract({ hello: [0], world: [1] }), 'hello world');

const work = JSON.parse(await readFile(new URL('../fixtures/work-article.json', import.meta.url), 'utf8'));
const fetchFn = async () => new Response(JSON.stringify(work), { status: 200 });

const record = pkg.toWorkRecord(work);
assert.equal(record.id, 'W9000000001');
assert.equal(typeof record.title, 'string');

const renamed = pkg.applyRename(record, { headline: 'title' });
assert.equal(renamed.ok, true);
assert.equal(renamed.data.headline, record.title);

const client = pkg.createOpenAlex({ fetchFn });
const viaClient = await client.fetchDoi('10.5555/alpha00001');
assert.equal(viaClient.ok, true, JSON.stringify(viaClient.error));
assert.equal(viaClient.data.record.title, record.title);

// The key-only client methods: one download and one budget read, both through the stub.
const contentFetch = async (url) =>
    String(url).endsWith('/rate-limit')
        ? new Response(JSON.stringify({ rate_limit: { daily_budget_usd: 1, daily_remaining_usd: 0.99 } }))
        : new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), { headers: { 'X-RateLimit-Cost-USD': '0.01' } });
const keyed = pkg.createOpenAlex({ apiKey: 'smoke', fetchFn: contentFetch });
assert.deepEqual(Object.keys(keyed).sort(), ['fetchBudget', 'fetchContent', 'fetchDoi', 'fetchWorkById']);
const pdf = await keyed.fetchContent('W9000000001');
assert.equal(pdf.ok, true, JSON.stringify(pdf.error));
assert.ok(pdf.data.pdf instanceof Uint8Array);
assert.equal(pdf.data.budget.cost_usd, 0.01);
const budget = await keyed.fetchBudget();
assert.equal(budget.ok, true, JSON.stringify(budget.error));
assert.equal(budget.data.daily_remaining_usd, 0.99);

assert.equal(typeof (await client.fetchDoi('nope')).error.retryable, 'boolean');
assert.equal(pkg.fetchDoi, undefined);
