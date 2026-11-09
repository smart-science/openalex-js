// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createOpenAlex } from '../src/client.js';
import {
    abortableFetch,
    asOptions,
    errorOf,
    type FetchTrap,
    installGlobalFetchTrap,
    jsonResponse,
    makeFetch,
    type RecordedTimer,
    recordTimers,
    SINGLE_ATTEMPT,
    textResponse,
} from './helpers.js';

const KEY = 'SECRET';
const WORK_ID = 'W9000000012';
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x00, 0xff]); // %PDF-1.4…
const TEI = '<?xml version="1.0"?><TEI xmlns="http://www.tei-c.org/ns/1.0"><text/></TEI>';
const BUDGET_HEADERS = {
    'X-RateLimit-Cost-USD': '0.01',
    'X-RateLimit-Remaining-USD': '0.98',
    'X-RateLimit-Limit-USD': '1',
    'X-RateLimit-Reset': '35563',
};

let trap: FetchTrap;

beforeEach(() => {
    trap = installGlobalFetchTrap();
});

afterEach(() => {
    trap.assertUntouched();
    trap.restore();
});

function pdfFetch() {
    return makeFetch(
        () =>
            new Response(PDF_BYTES, { status: 200, headers: { 'content-type': 'application/pdf', ...BUDGET_HEADERS } }),
    );
}

function okData<T>(result: { ok: boolean; data?: T; error?: unknown }): T {
    if (!result.ok) {
        throw new Error(`expected ok:true, got ${JSON.stringify(result.error)}`);
    }
    return result.data as T;
}

describe('fetchContent — downloads', () => {
    test('a PDF by default: one request to the content host, bytes intact, xml null', async () => {
        const { fn, calls } = pdfFetch();
        const oa = createOpenAlex({ apiKey: KEY, fetchFn: fn });
        const result = await oa.fetchContent(WORK_ID);
        const data = okData(result);

        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe(`https://content.openalex.org/works/${WORK_ID}.pdf`);
        expect(calls[0]?.headers.get('Authorization')).toBe(`Bearer ${KEY}`);
        expect(calls[0]?.headers.get('Accept')).toBe('application/pdf');
        expect(data.format).toBe('pdf');
        expect(data.workId).toBe(WORK_ID);
        expect(data.pdf).toBeInstanceOf(Uint8Array);
        expect([...(data.pdf ?? [])]).toEqual([...PDF_BYTES]);
        expect(data.xml).toBeNull();
    });

    test('the envelope carries exactly ok and data', async () => {
        const oa = createOpenAlex({ apiKey: KEY, fetchFn: pdfFetch().fn });
        expect(Object.keys(await oa.fetchContent(WORK_ID)).sort()).toEqual(['data', 'ok']);
    });

    test('TEI XML as a decoded string, pdf null', async () => {
        const { fn, calls } = makeFetch(() =>
            textResponse(TEI, { headers: { 'content-type': 'application/xml; charset=utf-8' } }),
        );
        const oa = createOpenAlex({ apiKey: KEY, fetchFn: fn });
        const data = okData(await oa.fetchContent(WORK_ID, { format: 'xml' }));

        expect(calls[0]?.url).toBe(`https://content.openalex.org/works/${WORK_ID}.grobid-xml`);
        expect(calls[0]?.headers.get('Accept')).toBe('application/xml');
        expect(data.format).toBe('xml');
        expect(data.xml).toBe(TEI);
        expect(data.pdf).toBeNull();
    });

    test('budget is parsed from the response headers', async () => {
        const oa = createOpenAlex({ apiKey: KEY, fetchFn: pdfFetch().fn });
        const data = okData(await oa.fetchContent(WORK_ID));
        expect(data.budget).toEqual({
            cost_usd: 0.01,
            daily_remaining_usd: 0.98,
            daily_budget_usd: 1,
            prepaid_remaining_usd: null,
            resets_in_seconds: 35563,
        });
    });

    test('budget is null when the response carries no budget headers', async () => {
        const { fn } = makeFetch(() => new Response(PDF_BYTES, { status: 200 }));
        const oa = createOpenAlex({ apiKey: KEY, fetchFn: fn });
        expect(okData(await oa.fetchContent(WORK_ID)).budget).toBeNull();
    });

    test('every accepted work id form produces the identical request', async () => {
        const urls: string[] = [];
        for (const form of [WORK_ID, WORK_ID.toLowerCase(), `https://openalex.org/${WORK_ID}`, `  ${WORK_ID}  `]) {
            const { fn, calls } = pdfFetch();
            const result = await createOpenAlex({ apiKey: KEY, fetchFn: fn }).fetchContent(form);
            expect(result.ok, form).toBe(true);
            urls.push(calls[0]?.url ?? '');
        }
        expect(new Set(urls)).toEqual(new Set([`https://content.openalex.org/works/${WORK_ID}.pdf`]));
    });

    test('the destructured method works without `this` binding', async () => {
        const { fetchContent } = createOpenAlex({ apiKey: KEY, fetchFn: pdfFetch().fn });
        expect((await fetchContent(WORK_ID)).ok).toBe(true);
    });

    test('a per-call fetchFn and timeoutMs override the factory', async () => {
        const factory = pdfFetch();
        const perCall = pdfFetch();
        const oa = createOpenAlex({ apiKey: KEY, fetchFn: factory.fn });
        expect((await oa.fetchContent(WORK_ID, { fetchFn: perCall.fn, timeoutMs: 5_000 })).ok).toBe(true);
        expect(factory.calls).toHaveLength(0);
        expect(perCall.calls).toHaveLength(1);
    });
});

describe('fetchContent — refused before a socket opens', () => {
    test('a client without a key returns INVALID_OPTIONS', async () => {
        const { fn, calls } = pdfFetch();
        const error = errorOf(await createOpenAlex({ fetchFn: fn }).fetchContent(WORK_ID));
        expect(error.code).toBe('INVALID_OPTIONS');
        expect(error.message).toBe(
            'Invalid option "apiKey": is required for content downloads (OpenAlex rejects them without a key)',
        );
        expect(calls).toHaveLength(0);
    });

    test('a DOI in any form is INVALID_ID, never resolved behind the caller’s back', async () => {
        const { fn, calls } = pdfFetch();
        const oa = createOpenAlex({ apiKey: KEY, fetchFn: fn });
        for (const input of ['10.5555/alpha00001', 'https://doi.org/10.5555/alpha00001', 'doi:10.5555/x']) {
            const error = errorOf(await oa.fetchContent(input));
            expect(error.code, input).toBe('INVALID_ID');
            expect(error.message).toContain('resolve a DOI with fetchDoi and pass record.id');
        }
        expect(calls).toHaveLength(0);
    });

    test('anything else that is not a work id is INVALID_ID', async () => {
        const { fn, calls } = pdfFetch();
        const oa = createOpenAlex({ apiKey: KEY, fetchFn: fn });
        for (const input of ['', 'W', 'A123', 'W12x', 'https://example.org/W1', 42, null]) {
            expect(errorOf(await oa.fetchContent(input as string)).code, String(input)).toBe('INVALID_ID');
        }
        expect(calls).toHaveLength(0);
    });

    test('an unknown format is INVALID_OPTIONS', async () => {
        const { fn, calls } = pdfFetch();
        const oa = createOpenAlex({ apiKey: KEY, fetchFn: fn });
        const error = errorOf(await oa.fetchContent(WORK_ID, asOptions({ format: 'tei' })));
        expect(error.message).toBe('Invalid option "format": must be "pdf" or "xml"');
        expect(calls).toHaveLength(0);
    });

    test('a rename map passed per call is ignored, not INVALID_OPTIONS', async () => {
        const { fn, calls } = pdfFetch();
        const oa = createOpenAlex({ apiKey: KEY, fetchFn: fn });
        const res = await oa.fetchContent(WORK_ID, asOptions({ rename: { ref_title: 'title' } }));
        expect(res.ok).toBe(true);
        expect(calls).toHaveLength(1);
    });

    test('apiKey passed per call is ignored and the factory key is sent', async () => {
        const { fn, calls } = pdfFetch();
        const oa = createOpenAlex({ apiKey: KEY, fetchFn: fn });
        const res = await oa.fetchContent(WORK_ID, asOptions({ apiKey: 'DIFFERENT' }));
        expect(res.ok).toBe(true);
        expect(calls[0]?.headers.get('Authorization')).toBe(`Bearer ${KEY}`);
    });
});

describe('fetchContent — errors', () => {
    test('404 is NO_CONTENT, naming the work and format', async () => {
        const { fn, calls } = makeFetch(() =>
            jsonResponse({ error: 'Work not found in content index', work_id: WORK_ID }, { status: 404 }),
        );
        const oa = createOpenAlex({ apiKey: KEY, fetchFn: fn });
        const pdf = errorOf(await oa.fetchContent(WORK_ID));
        expect(pdf.code).toBe('NO_CONTENT');
        expect(pdf.status).toBe(404);
        expect(pdf.message).toBe(`OpenAlex has no PDF for work ${WORK_ID}`);
        expect(errorOf(await oa.fetchContent(WORK_ID, { format: 'xml' })).message).toBe(
            `OpenAlex has no TEI XML for work ${WORK_ID}`,
        );
        expect(calls).toHaveLength(2);
    });

    test('429 — burst or exhausted budget alike — is RATE_LIMITED with retryAfterSeconds', async () => {
        const { fn, calls } = makeFetch(() =>
            jsonResponse({ error: 'Rate limit exceeded' }, { status: 429, headers: { 'Retry-After': '30' } }),
        );
        const oa = createOpenAlex({ apiKey: KEY, fetchFn: fn, limiterOptions: SINGLE_ATTEMPT });
        const error = errorOf(await oa.fetchContent(WORK_ID));
        expect(error.code).toBe('RATE_LIMITED');
        expect(error.retryAfterSeconds).toBe(30);
        expect(calls).toHaveLength(1);
    });

    test('401 is AUTH', async () => {
        const { fn } = makeFetch(() =>
            jsonResponse({ error: 'Invalid or missing API key', message: 'API key not found' }, { status: 401 }),
        );
        expect(errorOf(await createOpenAlex({ apiKey: 'bogus', fetchFn: fn }).fetchContent(WORK_ID)).code).toBe('AUTH');
    });

    test('a 200 whose body cannot be read as bytes is PARSE, not a throw', async () => {
        const { fn } = makeFetch(() => ({ status: 200, text: async () => '' }));
        expect(errorOf(await createOpenAlex({ apiKey: KEY, fetchFn: fn }).fetchContent(WORK_ID)).code).toBe('PARSE');
    });

    test('PDF body sniffing: junk in the first 1 KiB preceding %PDF- is accepted', async () => {
        const leadingJunk = new TextEncoder().encode('// Some leading junk comment or preamble\n');
        const combined = new Uint8Array(leadingJunk.length + PDF_BYTES.length);
        combined.set(leadingJunk, 0);
        combined.set(PDF_BYTES, leadingJunk.length);

        const { fn } = makeFetch(() => new Response(combined, { status: 200 }));
        const oa = createOpenAlex({ apiKey: KEY, fetchFn: fn });
        const result = await oa.fetchContent(WORK_ID);
        expect(result.ok).toBe(true);
        expect(okData(result).pdf).toEqual(combined);
    });

    test('PDF body sniffing: %PDF- beyond 1024-byte window is rejected as PARSE', async () => {
        const padding = new Uint8Array(1100);
        const combined = new Uint8Array(padding.length + PDF_BYTES.length);
        combined.set(padding, 0);
        combined.set(PDF_BYTES, padding.length);

        const { fn } = makeFetch(() => new Response(combined, { status: 200 }));
        const oa = createOpenAlex({ apiKey: KEY, fetchFn: fn });
        const error = errorOf(await oa.fetchContent(WORK_ID));
        expect(error.code).toBe('PARSE');
        expect(error.status).toBeNull();
        expect(error.message).toContain('expected a PDF');
    });

    test('PDF body sniffing: HTML, JSON, or empty 200 body is PARSE', async () => {
        const bodies = [
            '<!doctype html><html><body>An error occurred</body></html>',
            JSON.stringify({ error: 'file not ready' }),
            '',
        ];
        for (const body of bodies) {
            const { fn } = makeFetch(() => textResponse(body));
            const oa = createOpenAlex({ apiKey: KEY, fetchFn: fn });
            const error = errorOf(await oa.fetchContent(WORK_ID));
            expect(error.code, body).toBe('PARSE');
            expect(error.status, body).toBeNull();
            expect(error.message, body).toContain('expected a PDF');
        }
    });

    test('PDF body sniffing: an arrayBuffer() that is not binary is PARSE', async () => {
        for (const value of [Symbol('x'), 1n, 1024]) {
            const { fn } = makeFetch(() => ({
                status: 200,
                headers: new Headers(),
                text: async () => '',
                arrayBuffer: async () => value,
            }));
            const error = errorOf(await createOpenAlex({ apiKey: KEY, fetchFn: fn }).fetchContent(WORK_ID));
            expect(error.code).toBe('PARSE');
            expect(error.retryable).toBe(false);
        }
    });

    test('a whitespace-only body reads as (empty body)', async () => {
        const { fn } = makeFetch(() => textResponse('   '));
        const oa = createOpenAlex({ apiKey: KEY, fetchFn: fn });
        expect(errorOf(await oa.fetchContent(WORK_ID)).message).toContain('expected a PDF, got: (empty body)');
        expect(errorOf(await oa.fetchContent(WORK_ID, { format: 'xml' })).message).toContain(
            'expected XML, got: (empty body)',
        );
    });

    test('XML body sniffing: BOM and leading whitespace before < are accepted', async () => {
        const xmlWithBom =
            '\uFEFF   \n  <?xml version="1.0"?><!-- grobid --><TEI xmlns="http://www.tei-c.org/ns/1.0"><text/></TEI>';
        const { fn } = makeFetch(() => textResponse(xmlWithBom));
        const oa = createOpenAlex({ apiKey: KEY, fetchFn: fn });
        const result = await oa.fetchContent(WORK_ID, { format: 'xml' });
        expect(result.ok).toBe(true);
        expect(okData(result).xml).toBe(xmlWithBom);
    });

    test('XML body sniffing: HTML, JSON, or empty 200 body is rejected as PARSE', async () => {
        const bodies = [
            '<!DOCTYPE html><html><body>Not XML</body></html>',
            '   <html lang="en"><body>Not XML</body></html>',
            '<?xml version="1.0"?>\n<!DOCTYPE html><html><body>Login</body></html>',
            '<!-- CDN error -->\n<html><body>502</body></html>',
            '<body>error</body>',
            '{"error":"not found"}',
            '   ',
            '',
        ];
        for (const body of bodies) {
            const { fn } = makeFetch(() => textResponse(body));
            const oa = createOpenAlex({ apiKey: KEY, fetchFn: fn });
            const error = errorOf(await oa.fetchContent(WORK_ID, { format: 'xml' }));
            expect(error.code, body).toBe('PARSE');
            expect(error.status, body).toBeNull();
            expect(error.message, body).toContain('expected XML');
        }
    });

    test('a timeout is TIMEOUT', async () => {
        const { fn } = abortableFetch();
        const error = errorOf(
            await createOpenAlex({ apiKey: KEY, fetchFn: fn, limiterOptions: SINGLE_ATTEMPT }).fetchContent(WORK_ID, {
                timeoutMs: 10,
            }),
        );
        expect(error.code).toBe('TIMEOUT');
    });

    test('explicit factory timeout applies to fetchContent', async () => {
        const { fn } = abortableFetch(500);
        const oa = createOpenAlex({ apiKey: KEY, fetchFn: fn, timeoutMs: 15, limiterOptions: SINGLE_ATTEMPT });
        const error = errorOf(await oa.fetchContent(WORK_ID));
        expect(error.code).toBe('TIMEOUT');
        expect(error.message).toBe('Request timed out after 15ms');
    });

    test('default timeout is 60s for fetchContent when omitted', async () => {
        // The request sets its timeout timer right before it calls fetchFn.
        const { timers, restore } = recordTimers();
        try {
            let timeout: RecordedTimer | undefined;
            let called: () => void = () => {};
            const fetched = new Promise<void>((resolve) => {
                called = resolve;
            });
            const { fn } = makeFetch(
                (call: { signal: AbortSignal | null }) =>
                    new Promise((_resolve, reject) => {
                        timeout = timers.at(-1);
                        called();
                        call.signal?.addEventListener('abort', () => {
                            const reason = call.signal?.reason;
                            reject(reason instanceof Error ? reason : new Error('aborted'));
                        });
                    }),
            );
            const oa = createOpenAlex({ apiKey: KEY, fetchFn: fn, limiterOptions: SINGLE_ATTEMPT });
            const pending = oa.fetchContent(WORK_ID);
            await fetched;
            expect(timeout?.ms).toBe(60_000);

            timeout?.fire();
            const error = errorOf(await pending);
            expect(error.code).toBe('TIMEOUT');
            expect(error.message).toBe('Request timed out after 60000ms');
        } finally {
            restore();
        }
    });

    test('an aborted signal is ABORTED', async () => {
        const { fn, calls } = pdfFetch();
        const oa = createOpenAlex({ apiKey: KEY, fetchFn: fn });
        expect(errorOf(await oa.fetchContent(WORK_ID, { signal: AbortSignal.abort() })).code).toBe('ABORTED');
        expect(calls).toHaveLength(0);
    });
});

const RATE_LIMIT_BODY = {
    api_key: 'Fb2...RHa',
    rate_limit: {
        daily_budget_usd: 1,
        daily_used_usd: 0.02,
        daily_remaining_usd: 0.98,
        prepaid_balance_usd: 0,
        prepaid_remaining_usd: 0,
        resets_at: '2026-09-23T00:00:00.000Z',
        resets_in_seconds: 35546,
        endpoint_costs_usd: { singleton: 0, list: 0.0001, search: 0.001, content: 0.01 },
    },
};

describe('fetchBudget', () => {
    test('shapes GET /rate-limit, one request with the key', async () => {
        const { fn, calls } = makeFetch(() => jsonResponse(RATE_LIMIT_BODY));
        const data = okData(await createOpenAlex({ apiKey: KEY, fetchFn: fn }).fetchBudget());
        expect(data).toEqual({
            daily_budget_usd: 1,
            daily_used_usd: 0.02,
            daily_remaining_usd: 0.98,
            prepaid_remaining_usd: 0,
            resets_at: '2026-09-23T00:00:00.000Z',
            resets_in_seconds: 35546,
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe('https://api.openalex.org/rate-limit');
        expect(calls[0]?.headers.get('Authorization')).toBe(`Bearer ${KEY}`);
    });

    test('missing fields are null, not undefined', async () => {
        const { fn } = makeFetch(() => jsonResponse({ rate_limit: {} }));
        const data = okData(await createOpenAlex({ apiKey: KEY, fetchFn: fn }).fetchBudget());
        expect(Object.values(data as object).every((value) => value === null)).toBe(true);
    });

    test('a body without rate_limit is PARSE', async () => {
        const { fn } = makeFetch(() => jsonResponse({ something: 'else' }));
        expect(errorOf(await createOpenAlex({ apiKey: KEY, fetchFn: fn }).fetchBudget()).code).toBe('PARSE');
    });

    test('a PARSE for a malformed body keeps the budget headers of the response', async () => {
        const headers = { 'X-RateLimit-Cost-USD': '0', 'X-RateLimit-Remaining-USD': '0.7' };
        const { fn } = makeFetch(() => jsonResponse({ something: 'else' }, { headers }));
        const error = errorOf(await createOpenAlex({ apiKey: KEY, fetchFn: fn }).fetchBudget());
        expect(error.code).toBe('PARSE');
        expect(error.budget?.daily_remaining_usd).toBe(0.7);
    });

    test('a client without a key returns INVALID_OPTIONS without a request', async () => {
        const { fn, calls } = makeFetch(() => jsonResponse(RATE_LIMIT_BODY));
        const error = errorOf(await createOpenAlex({ fetchFn: fn }).fetchBudget());
        expect(error.code).toBe('INVALID_OPTIONS');
        expect(error.message).toContain('is required for fetchBudget');
        expect(calls).toHaveLength(0);
    });

    test('a per-call apiKey is ignored, factory key is sent', async () => {
        const { fn, calls } = makeFetch(() => jsonResponse(RATE_LIMIT_BODY));
        const res = await createOpenAlex({ apiKey: KEY, fetchFn: fn }).fetchBudget(asOptions({ apiKey: 'OTHER' }));
        expect(res.ok).toBe(true);
        expect(calls[0]?.headers.get('Authorization')).toBe(`Bearer ${KEY}`);
    });

    test('format passed to fetchBudget is ignored', async () => {
        const { fn, calls } = makeFetch(() => jsonResponse(RATE_LIMIT_BODY));
        const res = await createOpenAlex({ apiKey: KEY, fetchFn: fn }).fetchBudget(asOptions({ format: 'pdf' }));
        expect(res.ok).toBe(true);
        expect(calls).toHaveLength(1);
    });

    test('singleBelow, even invalid, is not read by fetchBudget or fetchContent', async () => {
        const budget = makeFetch(() => jsonResponse(RATE_LIMIT_BODY));
        const oa = createOpenAlex({ apiKey: KEY, fetchFn: budget.fn });
        expect((await oa.fetchBudget(asOptions({ singleBelow: -1 }))).ok).toBe(true);
        const content = pdfFetch();
        const res = await createOpenAlex({ apiKey: KEY, fetchFn: content.fn }).fetchContent(
            WORK_ID,
            asOptions({ singleBelow: -1 }),
        );
        expect(res.ok).toBe(true);
    });

    test('reads https://api.openalex.org/rate-limit', async () => {
        const { fn, calls } = makeFetch(() => jsonResponse(RATE_LIMIT_BODY));
        await createOpenAlex({ apiKey: KEY, fetchFn: fn }).fetchBudget();
        expect(calls[0]?.url).toBe('https://api.openalex.org/rate-limit');
    });
});

describe('fetchContent and fetchBudget — client key and queue settings', () => {
    test('an empty or blank factory key throws at createOpenAlex and nothing is sent', () => {
        const { fn, calls } = pdfFetch();
        for (const apiKey of ['', '   ']) {
            expect(() => createOpenAlex({ apiKey, fetchFn: fn })).toThrow(TypeError);
        }
        expect(calls).toHaveLength(0);
    });

    test('factory limits and limiterOptions apply to content and budget requests', async () => {
        const pdf = pdfFetch();
        const content = await createOpenAlex({
            apiKey: KEY,
            fetchFn: pdf.fn,
            limits: { concurrency: 1 },
            limiterOptions: SINGLE_ATTEMPT,
        }).fetchContent(WORK_ID);
        expect(content.ok).toBe(true);
        const budget = makeFetch(() => textResponse('x', { status: 503 }));
        const error = errorOf(
            await createOpenAlex({
                apiKey: KEY,
                fetchFn: budget.fn,
                limits: { rps: 100 },
                limiterOptions: SINGLE_ATTEMPT,
            }).fetchBudget(),
        );
        expect(error.status).toBe(503);
        expect(budget.calls).toHaveLength(1);
    });

    test('invalid factory limits throw at createOpenAlex without a request', () => {
        const pdf = pdfFetch();
        expect(() => createOpenAlex({ apiKey: KEY, fetchFn: pdf.fn, limits: { rps: 0 } })).toThrow(TypeError);
        expect(pdf.calls).toHaveLength(0);
    });

    test('limits passed per call are ignored, not INVALID_OPTIONS', async () => {
        const pdf = pdfFetch();
        const content = createOpenAlex({ apiKey: KEY, fetchFn: pdf.fn });
        expect((await content.fetchContent(WORK_ID, asOptions({ limits: { rps: 0 } }))).ok).toBe(true);
        const budget = makeFetch(() => jsonResponse(RATE_LIMIT_BODY));
        const client = createOpenAlex({ apiKey: KEY, fetchFn: budget.fn });
        expect((await client.fetchBudget(asOptions({ limits: { rps: 0 } }))).ok).toBe(true);
        expect(pdf.calls).toHaveLength(1);
        expect(budget.calls).toHaveLength(1);
    });
});
