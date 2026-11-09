// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import type { Budget } from '../content/types.js';
import { encodeDoi } from '../identifiers/doi.js';
import {
    API_BASE_URL,
    CONTENT_BASE_URL,
    DEFAULT_CONTENT_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    USER_AGENT,
} from '../utils/constants.js';
import { createError, type OpenAlexError, type OpenAlexErrorCode, type TransportErrorCode } from '../utils/errors.js';
import { type Err, err, ok, type Result } from '../utils/result.js';
import { label } from '../utils/values.js';
import type { OpenAlexWork } from '../work/api-types.js';
import {
    extractErrorBody,
    HTTP_STATUS,
    isResponseLike,
    isSuccessStatus,
    parseBudget,
    type ResponseLike,
    readBody,
    retryDelay,
    summarizeBody,
    toStatusError,
} from './response.js';

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

/** Request options controlling transport and authentication parameters. */
export type RequestOptions = {
    readonly apiKey?: string | undefined;
    readonly timeoutMs?: number | undefined;
    readonly fetchFn?: typeof fetch | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly clientSignal?: AbortSignal | undefined;
};

/** Transport result: parsed body and budget headers, or a transport error or the endpoint's 404 error. */
export type Fetched<T, N extends OpenAlexErrorCode> = Result<
    { body: T; budget: Budget | null },
    TransportErrorCode | N
>;

/** Filter field of a works list request; DOI and id filters cannot be combined. */
export type WorkFilterField = 'doi' | 'openalex';

/** Body of a works list request; only the fields batch lookup reads. */
export type WorkList = {
    readonly meta?: { readonly count?: number };
    readonly results: readonly OpenAlexWork[];
};

type BodyReader<T> = (response: ResponseLike) => Promise<Result<T, 'PARSE'>>;

// -------------------------------------------------------------------
// --- 2. Constants
// -------------------------------------------------------------------

const WORKS_PATH = '/works';
const RATE_LIMIT_PATH = '/rate-limit';
/** Most values one filter accepts; 101 returns HTTP 400. */
export const MAX_FILTER_VALUES = 100;
/**
 * **Works per list page**: documented maximum (`per_page=100`).
 *
 * - one DOI can match multiple works, so a 100-key chunk can span multiple pages
 */
export const LIST_PAGE_SIZE = 100;
/** Basic paging serves at most this many results: `page * per_page` must not exceed it. */
export const MAX_LIST_RESULTS = 10_000;
/** Most cited first, ties by ascending W id (verified stable across pages), so a capped list keeps the works single lookup would pick. */
const LIST_SORT = 'cited_by_count:desc';
const FILTER_OR = '|';
const ACCEPT_JSON = 'application/json';
const ACCEPT_PDF = 'application/pdf';
const ACCEPT_XML = 'application/xml';
/** Content host names TEI format after tool that produced it. */
const XML_EXTENSION = 'grobid-xml';
/** "%PDF-"; must appear within the first PDF_HEADER_WINDOW bytes. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;
const PDF_HEADER_WINDOW = 1024;
/** How much of an unexpected body goes into the PARSE message. */
const SNIFF_PREVIEW_LENGTH = 200;
/** XML starts with `<` after an optional BOM and whitespace. */
const MATCH_XML_START = /^\uFEFF?\s*</;
/** HTML error page (CDN error page, login wall) also starts with `<` but is not TEI XML; may follow an XML prolog or comments. */
const MATCH_HTML_START =
    /^\uFEFF?(?:\s|<!--[\s\S]*?-->|<\?xml[\s\S]*?\?>)*<(?:!doctype\s+html|html[\s>]|head[\s>]|body[\s>])/i;

// -------------------------------------------------------------------
// --- 3. Exported Functions
// -------------------------------------------------------------------

/**
 * **Execute JSON request**: generic transport handler for JSON endpoints.
 *
 * - dispatches GET request with authorization and timeout
 * - extracts budget headers from response
 * @internal - exported for testing only
 */
export function requestJson<T, N extends OpenAlexErrorCode>(
    path: string,
    options: RequestOptions,
    notFoundError: OpenAlexError<N>,
): Promise<Fetched<T, N>> {
    return send(`${API_BASE_URL}${path}`, ACCEPT_JSON, options, notFoundError, readJson<T>, DEFAULT_TIMEOUT_MS);
}

/** Performs GET request for OpenAlex work record by DOI. */
export function requestWork(doi: string, options: RequestOptions): Promise<Fetched<OpenAlexWork, 'NOT_FOUND'>> {
    return requestJson(
        `${WORKS_PATH}/${encodeDoi(doi)}`,
        options,
        createError('NOT_FOUND', { doi, status: HTTP_STATUS.NOT_FOUND }),
    );
}

/** Performs GET request for OpenAlex work record by normalized W id; follows merged ids. */
export function requestWorkById(workId: string, options: RequestOptions): Promise<Fetched<OpenAlexWork, 'NOT_FOUND'>> {
    return requestJson(
        `${WORKS_PATH}/${workId}`,
        options,
        createError('NOT_FOUND', { workId, status: HTTP_STATUS.NOT_FOUND }),
    );
}

/**
 * **List works by filter**: one page of the works matching up to MAX_FILTER_VALUES DOIs or W ids.
 *
 * - values are OR-joined with `|`; each value is percent-encoded
 * - LIST_PAGE_SIZE works per page, `page` counts from 1 (basic paging, no key needed)
 * - sorted by cited_by_count, most cited first; every page costs one list credit, an empty one too;
 *   missing values are absent from the results
 * - a 404 is reported as HTTP, since a list request has no single missing record
 */
export async function requestWorks(
    field: WorkFilterField,
    values: readonly string[],
    options: RequestOptions,
    page = 1,
): Promise<Fetched<WorkList, 'HTTP'>> {
    const filter = values.map(encodeURIComponent).join(FILTER_OR);
    const fetched = await requestJson<WorkList, 'HTTP'>(
        `${WORKS_PATH}?filter=${field}:${filter}&per_page=${LIST_PAGE_SIZE}&page=${page}&sort=${LIST_SORT}`,
        options,
        createError('HTTP', { status: HTTP_STATUS.NOT_FOUND, body: 'the works list endpoint was not found' }),
    );
    if (fetched.ok && !Array.isArray(fetched.data.body.results)) {
        const error = createError('PARSE', { body: 'the works list has no results array' });
        return err({ ...error, budget: fetched.data.budget });
    }
    return fetched;
}

/** Performs GET request for daily rate limit budget status. */
export function requestBudget(options: RequestOptions): Promise<Fetched<unknown, 'HTTP'>> {
    return requestJson(
        RATE_LIMIT_PATH,
        options,
        createError('HTTP', { status: HTTP_STATUS.NOT_FOUND, body: 'the rate-limit endpoint was not found' }),
    );
}

/** Performs GET request for work full-text PDF binary. */
export function requestPdf(workId: string, options: RequestOptions): Promise<Fetched<Uint8Array, 'NO_CONTENT'>> {
    return send(
        contentUrl(workId, 'pdf'),
        ACCEPT_PDF,
        options,
        createError('NO_CONTENT', { workId, format: 'pdf', status: HTTP_STATUS.NOT_FOUND }),
        readBytes,
        DEFAULT_CONTENT_TIMEOUT_MS,
    );
}

/** Performs GET request for work full-text TEI XML string. */
export function requestXml(workId: string, options: RequestOptions): Promise<Fetched<string, 'NO_CONTENT'>> {
    return send(
        contentUrl(workId, XML_EXTENSION),
        ACCEPT_XML,
        options,
        createError('NO_CONTENT', { workId, format: 'xml', status: HTTP_STATUS.NOT_FOUND }),
        readText,
        DEFAULT_CONTENT_TIMEOUT_MS,
    );
}

// -------------------------------------------------------------------
// --- 4. Private Functions
// -------------------------------------------------------------------

function describeCause(cause: unknown): string {
    return cause instanceof Error ? cause.message : label(cause);
}

function contentUrl(workId: string, extension: string): string {
    return `${CONTENT_BASE_URL}${WORKS_PATH}/${workId}.${extension}`;
}

function hasPdfHeader(bytes: Uint8Array): boolean {
    const last = Math.min(bytes.length, PDF_HEADER_WINDOW) - PDF_MAGIC.length;
    for (let i = 0; i <= last; i++) {
        if (PDF_MAGIC.every((b, j) => bytes[i + j] === b)) {
            return true;
        }
    }
    return false;
}

/** Parses JSON response body and validates object structure. */
async function readJson<T>(response: ResponseLike): Promise<Result<T, 'PARSE'>> {
    const text: unknown = await response.text();
    if (typeof text !== 'string') {
        return err(createError('PARSE', { body: 'the response has no text body' }));
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (cause) {
        return err(createError('PARSE', { body: `not JSON: ${summarizeBody(text)}` }, cause));
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return err(createError('PARSE', { body: `not a JSON object: ${summarizeBody(text)}` }));
    }
    return ok(parsed as T);
}

async function readBytes(response: ResponseLike): Promise<Result<Uint8Array, 'PARSE'>> {
    if (typeof response.arrayBuffer !== 'function') {
        return err(createError('PARSE', { body: 'the response has no binary body' }));
    }
    const buffer: unknown = await response.arrayBuffer();
    if (!(buffer instanceof ArrayBuffer) && !ArrayBuffer.isView(buffer)) {
        return err(createError('PARSE', { body: 'the response has no binary body' }));
    }
    const bytes = ArrayBuffer.isView(buffer)
        ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        : new Uint8Array(buffer);
    if (!hasPdfHeader(bytes)) {
        const preview = new TextDecoder().decode(bytes.subarray(0, SNIFF_PREVIEW_LENGTH));
        return err(createError('PARSE', { body: `expected a PDF, got: ${summarizeBody(preview) || '(empty body)'}` }));
    }
    return ok(bytes);
}

async function readText(response: ResponseLike): Promise<Result<string, 'PARSE'>> {
    const text: unknown = await response.text();
    if (typeof text !== 'string') {
        return err(createError('PARSE', { body: 'the response has no text body' }));
    }
    if (!MATCH_XML_START.test(text) || MATCH_HTML_START.test(text)) {
        const preview = text.slice(0, SNIFF_PREVIEW_LENGTH);
        return err(createError('PARSE', { body: `expected XML, got: ${summarizeBody(preview) || '(empty body)'}` }));
    }
    return ok(text);
}

/**
 * **Execute HTTP request**: dispatches fetch with timeout, cancellation, and error handling.
 *
 * - injects Authorization and User-Agent headers
 * - races execution against caller and client AbortSignals and timeoutMs
 * - returns non-throwing Fetched envelope with parsed body and budget
 */
async function send<T, N extends OpenAlexErrorCode>(
    url: string,
    accept: string,
    options: RequestOptions,
    notFoundError: OpenAlexError<N>,
    read: BodyReader<T>,
    defaultTimeoutMs: number,
): Promise<Fetched<T, N>> {
    const timeoutMs = Math.min(options.timeoutMs ?? defaultTimeoutMs, MAX_TIMEOUT_MS);

    const fetchFn = options.fetchFn ?? globalThis.fetch;
    if (typeof fetchFn !== 'function') {
        return err(createError('NETWORK', { reason: 'fetch is not available in this runtime' }));
    }

    const headers: Record<string, string> = {
        accept,
        // Browsers forbid setting User-Agent and drop it silently; never an error.
        'user-agent': USER_AGENT,
    };
    const apiKey = (options.apiKey ?? '').trim();
    if (apiKey !== '') {
        headers.authorization = `Bearer ${apiKey}`;
    }

    const controller = new AbortController();
    let timedOut = false;
    let abortedByCaller = false;
    let abortReason: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Set only once the listener is attached, so cleanup never touches a signal without it.
    let listening: AbortSignal | undefined;
    // Set once fetch resolved with a response, so every later error carries its budget headers.
    let received: ResponseLike | undefined;

    function onAbort(event: Event): void {
        if (timedOut) {
            return;
        }
        clearTimeout(timer);
        abortedByCaller = true;
        abortReason = (event.target as AbortSignal).reason;
        controller.abort(abortReason);
    }

    /** Budget of received response; null when none arrived or its headers throw (keeps `send` non-throwing). */
    function receivedBudget(): Budget | null {
        if (received === undefined) {
            return null;
        }
        try {
            return parseBudget(received);
        } catch {
            return null;
        }
    }

    /** Timer or caller abort wins over whatever fetch or a body reader produced afterwards; keeps budget of a received response. */
    function interrupted(cause?: unknown): Err<'TIMEOUT' | 'ABORTED'> | null {
        if (timedOut) {
            return err({ ...createError('TIMEOUT', { timeoutMs }, cause), budget: receivedBudget() });
        }
        if (abortedByCaller) {
            return err({ ...createError('ABORTED', {}, abortReason), budget: receivedBudget() });
        }
        return null;
    }

    try {
        const callerSignals = [options.clientSignal, options.signal].filter(
            (signal): signal is AbortSignal => signal !== undefined,
        );
        if (callerSignals.length > 0) {
            // A per-request composite: concurrent requests sharing one signal add no listeners to
            // it, so Node 22 never warns about "11 abort listeners added to [AbortSignal]".
            const callerSignal = AbortSignal.any(callerSignals);
            if (callerSignal.aborted) {
                return err(createError('ABORTED', {}, callerSignal.reason));
            }
            callerSignal.addEventListener('abort', onAbort, { once: true });
            listening = callerSignal;
        }

        timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);

        const response: unknown = await fetchFn(url, { method: 'GET', headers, signal: controller.signal });
        if (isResponseLike(response)) {
            received = response;
        }
        const afterFetch = interrupted();
        if (afterFetch !== null) {
            return afterFetch;
        }

        if (!isResponseLike(response)) {
            return err(createError('NETWORK', { reason: 'fetch did not return a Response' }, response));
        }

        const status = response.status;
        if (!isSuccessStatus(status)) {
            const body = await readBody(response);
            // readBody swallows the abort, so an interrupted error body must be checked here.
            return (
                interrupted() ??
                err({
                    ...toStatusError(status, extractErrorBody(body), retryDelay(response), notFoundError),
                    budget: parseBudget(response),
                })
            );
        }

        // Reading the body is still inside the timer and caller signals.
        const body = await read(response);
        const afterRead = interrupted();
        if (afterRead !== null) {
            return afterRead;
        }
        if (!body.ok) {
            return err({ ...body.error, budget: parseBudget(response) });
        }
        return ok({ body: body.data, budget: parseBudget(response) });
    } catch (cause) {
        return (
            interrupted(cause) ??
            err({ ...createError('NETWORK', { reason: describeCause(cause) }, cause), budget: receivedBudget() })
        );
    } finally {
        clearTimeout(timer);
        listening?.removeEventListener('abort', onAbort);
    }
}
