// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

/**
 * **Playground for key-only client methods**: calls real API and spends real budget.
 *
 * - `bun run try:content` downloads W3038568908 as PDF and XML ($0.02)
 * - `bun run try:content W2741809807` requests a work without content (free 404)
 * - reads `OPENALEX_API_KEY` from environment and passes it explicitly to `createOpenAlex`
 */
import { createOpenAlex } from '../src/index.js';

// -------------------------------------------------------------------
// --- 1. Constants
// -------------------------------------------------------------------

const WORK_ID = Bun.argv[2] ?? 'W3038568908';
const API_KEY = (Bun.env.OPENALEX_API_KEY ?? '').trim();

if (API_KEY === '') {
    console.error('Set OPENALEX_API_KEY (e.g. in .env) — content downloads require a key.');
    process.exit(1);
}

const oa = createOpenAlex({ apiKey: API_KEY, timeoutMs: 60_000 });

const before = await oa.fetchBudget();
console.log('budget before', before.ok ? before.data : before.error);

const pdf = await oa.fetchContent(WORK_ID);
if (pdf.ok) {
    const magic = new TextDecoder().decode(pdf.data.pdf.subarray(0, 5));
    console.log(`pdf  ${pdf.data.pdf.byteLength} bytes, starts with ${JSON.stringify(magic)}`, pdf.data.budget);
} else {
    console.log('pdf ', pdf.error);
}

const xml = await oa.fetchContent(WORK_ID, { format: 'xml' });
if (xml.ok) {
    console.log(`xml  ${xml.data.xml.length} chars, has <TEI: ${xml.data.xml.includes('<TEI')}`, xml.data.budget);
} else {
    console.log('xml ', xml.error);
}

const doi = await oa.fetchContent('10.1585/pfr.15.2402039');
console.log('doi  refused before any request:', doi.ok ? 'UNEXPECTED ok' : doi.error.code);
