// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { type BatchKind, toEntries } from './batch/chunk.js';
import { resolveBatch } from './batch/run.js';
import type { BatchErrorCode, BatchResult } from './batch/types.js';
import { toBudgetStatus } from './content/to-budget.js';
import type { Budget, BudgetStatus, ContentData, PdfContent, XmlContent } from './content/types.js';
import { normalizeDoi } from './identifiers/doi.js';
import { normalizeWorkId } from './identifiers/work-id.js';
import {
    BUDGET_KEYS,
    type BudgetCallOptions,
    type CallOptions,
    CONTENT_KEYS,
    type ContentCallOptions,
    type ContentOptions,
    configError,
    DOI_KEYS,
    type DoiCallOptions,
    type MergedOptions,
    mergeCall,
    type OpenAlexOptions,
    type PlainOptions,
    type RenameOptions,
    snapshotFactoryOptions,
    WORK_KEYS,
    type WorkIdCallOptions,
} from './options.js';
import { combineSignals, createRequestQueues, type Lane, type RequestQueues, schedule } from './transport/limiter.js';
import {
    type Fetched,
    type RequestOptions,
    requestBudget,
    requestPdf,
    requestWork,
    requestWorkById,
    requestXml,
} from './transport/request.js';
import { summarizeBody } from './transport/response.js';
import {
    createError,
    type FetchBudgetErrorCode,
    type FetchContentErrorCode,
    type FetchDoiErrorCode,
    type FetchWorkErrorCode,
    invalidOption,
    type OpenAlexError,
    type OpenAlexErrorCode,
} from './utils/errors.js';
import { err, ok, type Result } from './utils/result.js';
import { label } from './utils/values.js';
import type { OpenAlexWork } from './work/api-types.js';
import type { WorkRecord } from './work/record-types.js';
import { type Renamed, type RenameMap, renameFields, validateRenameMap } from './work/rename.js';
import { toWorkRecord } from './work/to-record.js';

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

export type {
    BudgetCallOptions,
    CallOptions,
    ContentCallOptions,
    ContentOptions,
    DoiCallOptions,
    OpenAlexOptions,
    PlainOptions,
    RenameOptions,
    WorkIdCallOptions,
};

/** Success payload containing flattened record, untouched raw response, and optional budget headers. */
export type WorkData<T> = {
    /** Normalized lookup DOI; may differ from record.doi if merged (e.g. arXiv preprint). */
    readonly requestedDoi: string;
    readonly record: T;
    readonly raw: OpenAlexWork;
    readonly budget: Budget | null;
};

/** Success payload of fetchWorkById; like WorkData, with the requested W id. */
export type WorkIdData<T> = {
    /** Normalized lookup id; differs from record.id when the work was merged into another. */
    readonly requestedId: string;
    readonly record: T;
    readonly raw: OpenAlexWork;
    readonly budget: Budget | null;
};

/** Payload of a lookup by kind. */
type DataOf<K extends BatchKind, T> = K extends 'doi' ? WorkData<T> : WorkIdData<T>;

/**
 * **Lookup signature**: the output type follows the input type.
 *
 * - a string returns Result; an array returns BatchResult with works and errors keyed by input
 * - a literal rename map types data.record as Renamed<M>
 */
type Lookup<K extends BatchKind, C extends OpenAlexErrorCode, T, O> = {
    /** One value, without rename map. */
    (input: string, opts?: PlainOptions<O>): Promise<Result<DataOf<K, T>, C>>;
    /** Array of values, without rename map. */
    (inputs: readonly string[], opts?: PlainOptions<O>): Promise<BatchResult<DataOf<K, T>, C>>;
    /** Value or array not known statically, without rename map. */
    (
        input: string | readonly string[],
        opts?: PlainOptions<O>,
    ): Promise<Result<DataOf<K, T>, C> | BatchResult<DataOf<K, T>, C>>;
    /** One value, with literal rename map. */
    <const M extends RenameMap>(input: string, opts: RenameOptions<M, O>): Promise<Result<DataOf<K, Renamed<M>>, C>>;
    /** Array of values, with literal rename map. */
    <const M extends RenameMap>(
        inputs: readonly string[],
        opts: RenameOptions<M, O>,
    ): Promise<BatchResult<DataOf<K, Renamed<M>>, C>>;
    /** Value or array not known statically, with literal rename map. */
    <const M extends RenameMap>(
        input: string | readonly string[],
        opts: RenameOptions<M, O>,
    ): Promise<Result<DataOf<K, Renamed<M>>, C> | BatchResult<DataOf<K, Renamed<M>>, C>>;
};

/** Lookup function signature for one DOI or an array of DOIs. */
export type FetchDoi<T = WorkRecord, O = DoiCallOptions> = Lookup<'doi', FetchDoiErrorCode, T, O>;

/** Lookup function signature for one work ID or an array of work IDs. */
export type FetchWorkById<T = WorkRecord, O = WorkIdCallOptions> = Lookup<'id', FetchWorkErrorCode, T, O>;

type ContentResult<D> = Promise<Result<D, FetchContentErrorCode>>;

/** Downloads one work's full text into memory with the client's API key. */
export type FetchContent = {
    (workId: string, opts?: ContentCallOptions & { readonly format?: 'pdf' | undefined }): ContentResult<PdfContent>;
    (workId: string, opts: ContentCallOptions & { readonly format: 'xml' }): ContentResult<XmlContent>;
    (workId: string, opts: ContentCallOptions): ContentResult<ContentData>;
};

/** Reads daily budget status for the API key from GET /rate-limit. */
export type FetchBudget = (opts?: BudgetCallOptions) => Promise<Result<BudgetStatus, FetchBudgetErrorCode>>;

/** Client instance returned by createOpenAlex. */
export type OpenAlex<T = WorkRecord> = {
    readonly fetchDoi: FetchDoi<T>;
    readonly fetchWorkById: FetchWorkById<T>;
    readonly fetchContent: FetchContent;
    readonly fetchBudget: FetchBudget;
};

type CreateOpenAlex = {
    (opts?: PlainOptions<OpenAlexOptions>): OpenAlex;
    <const M extends RenameMap>(opts: RenameOptions<M, OpenAlexOptions>): OpenAlex<Renamed<M>>;
};

/** Runtime payload and error codes of either lookup. */
type LookupData = WorkData<WorkRecord> | WorkIdData<WorkRecord>;
type LookupErrorCode = FetchDoiErrorCode | FetchWorkErrorCode;
type LookupResult = Result<LookupData, LookupErrorCode>;
type BatchError = OpenAlexError<BatchErrorCode<LookupErrorCode>>;

// -------------------------------------------------------------------
// --- 2. Exported Functions
// -------------------------------------------------------------------

/**
 * **Create OpenAlex client**: instantiates pre-configured client instance.
 *
 * - validates options snapshot once at creation
 * - binds API key, timeout, signal, fetchFn, strategy, fallbackOnRateLimit, and rename defaults
 * - creates rate-limited free and paid queues shared by all requests on this client
 * - provides fetchDoi, fetchWorkById, fetchContent, and fetchBudget methods
 * - returns frozen plain object safe for destructuring
 * @throws {TypeError} on invalid options configuration
 */
export const createOpenAlex: CreateOpenAlex = createOpenAlexImpl as CreateOpenAlex;

// -------------------------------------------------------------------
// --- 3. Private Functions
// -------------------------------------------------------------------

/**
 * **Dispatches lookup** by input type.
 *
 * - arrays go to lookupBatch, everything else to lookupOne
 * - array that throws while being copied returns INVALID_DOI / INVALID_ID for the whole call
 * - invalid options return immediately for strings and arrays
 */
function lookup(
    kind: BatchKind,
    input: unknown,
    merged: Result<MergedOptions, 'INVALID_OPTIONS'>,
    queues: RequestQueues,
): Promise<LookupResult | BatchResult<LookupData, LookupErrorCode>> {
    let inputs: readonly unknown[] | null;
    try {
        // Snapshot: hostile array (revoked Proxy, throwing getter or trap) fails here instead of mid-batch.
        inputs = Array.isArray(input) ? Array.from(input) : null;
    } catch {
        return Promise.resolve(err(invalidInput(kind, input)));
    }
    if (inputs !== null) {
        return merged.ok ? lookupBatch(kind, inputs, merged.data, queues) : Promise.resolve(merged);
    }
    return merged.ok ? lookupOne(kind, input, merged.data, queues) : Promise.resolve(merged);
}

async function lookupOne(
    kind: BatchKind,
    input: unknown,
    settings: MergedOptions,
    queues: RequestQueues,
): Promise<LookupResult> {
    const key = normalizeKey(kind, input);
    if (key === null) {
        return err(invalidInput(kind, input));
    }
    const renameError = settings.rename === undefined ? null : validateRenameMap(settings.rename);
    if (renameError !== null) {
        return err(renameError);
    }
    const response = await send(settings, queues, 'free', (options) =>
        kind === 'doi' ? requestWork(key, options) : requestWorkById(key, options),
    );
    return toLookupData(kind, key, response, settings.rename);
}

/**
 * **Looks up array** of DOIs or W ids.
 *
 * - works and errors keyed by input, in input order (integer-like strings come first); duplicate keys share one request
 * - invalid inputs become errors without requests; 404 becomes null work
 * - invalid input labelled like a valid one (e.g. `new String('W1')`) yields to it
 * - fails whole result on invalid options/rename map or when no input is in works
 */
async function lookupBatch(
    kind: BatchKind,
    inputs: readonly unknown[],
    settings: MergedOptions,
    queues: RequestQueues,
): Promise<BatchResult<LookupData, LookupErrorCode>> {
    const renameError = settings.rename === undefined ? null : validateRenameMap(settings.rename);
    if (renameError !== null) {
        return err(renameError);
    }
    const entries = toEntries(inputs, kind);
    const resolved = await resolveBatch(kind, entries, {
        queues,
        request: settings as RequestOptions,
        strategy: settings.strategy ?? 'batch',
        fallbackOnRateLimit: settings.fallbackOnRateLimit ?? false,
        singleBelow: settings.singleBelow ?? 0,
    });
    // Null prototype: an input such as "__proto__" stays an ordinary key.
    const works: Record<string, LookupData | null> = Object.create(null);
    const errors: Record<string, BatchError> = Object.create(null);
    // In input order: object key order puts integer-like keys first.
    const failed: BatchError[] = [];
    // A valid input claims its label even when an invalid input with the same label comes first.
    const valid = new Set(entries.filter((entry) => entry.key !== null).map((entry) => entry.input));
    entries.forEach((entry, position) => {
        if (entry.key === null && valid.has(entry.input)) {
            return;
        }
        if (Object.hasOwn(works, entry.input) || Object.hasOwn(errors, entry.input)) {
            return;
        }
        const response = entry.key === null ? undefined : resolved.results.get(entry.key);
        const result =
            entry.key === null || response === undefined
                ? err(invalidInput(kind, inputs[position]))
                : toLookupData(kind, entry.key, response, settings.rename);
        if (result.ok) {
            works[entry.input] = result.data;
        } else if (result.error.code === 'NOT_FOUND') {
            works[entry.input] = null;
        } else {
            errors[entry.input] = result.error as BatchError;
            failed.push(result.error as BatchError);
        }
    });
    if (failed.length > 0 && Object.keys(works).length === 0) {
        return err({ ...mostCommonError(failed), budget: resolved.budget });
    }
    return ok({ works, errors, budget: resolved.budget, requests: resolved.requests });
}

/** Most common error by code and status; request errors precede invalid inputs, ties pick first. */
function mostCommonError(errors: readonly BatchError[]): BatchError {
    const requestErrors = errors.filter((error) => error.code !== 'INVALID_DOI' && error.code !== 'INVALID_ID');
    const candidates = requestErrors.length > 0 ? requestErrors : errors;
    const counts = new Map<string, { error: BatchError; count: number }>();
    for (const error of candidates) {
        const group = `${error.code} ${error.status}`;
        const entry = counts.get(group) ?? { error, count: 0 };
        entry.count += 1;
        counts.set(group, entry);
    }
    let best = { error: candidates[0] as BatchError, count: 0 };
    for (const entry of counts.values()) {
        if (entry.count > best.count) {
            best = entry;
        }
    }
    return best.error;
}

/** Sends one request through its lane queue, pacing and retrying transient failures. */
function send<T, C extends OpenAlexErrorCode>(
    settings: MergedOptions,
    queues: RequestQueues,
    lane: Lane,
    request: (options: RequestOptions) => Promise<Result<T, C>>,
): Promise<Result<T, C | 'ABORTED' | 'RATE_LIMITED' | 'TIMEOUT' | 'NETWORK'>> {
    const options = settings as RequestOptions;
    return schedule(queues, lane, () => request(options), {
        signal: combineSignals(options.signal, options.clientSignal),
    });
}

/** Builds the payload of one fetched work and applies the rename map. */
function toLookupData(
    kind: BatchKind,
    key: string,
    response: Fetched<OpenAlexWork, 'NOT_FOUND'>,
    rename: unknown,
): LookupResult {
    if (!response.ok) {
        return response;
    }
    const raw = response.data.body;
    const record = toWorkRecord(raw);
    if (record === null) {
        const error = createError('PARSE', { body: `not an OpenAlex work: ${describeBody(raw)}` });
        return err({ ...error, budget: response.data.budget });
    }
    const budget = response.data.budget;
    let shaped = record;
    if (rename !== undefined) {
        const renamed = renameFields(record, rename as RenameMap);
        if (!renamed.ok) {
            return renamed;
        }
        shaped = renamed.data as unknown as WorkRecord;
    }
    return ok(
        kind === 'doi'
            ? { requestedDoi: key, record: shaped, raw, budget }
            : { requestedId: key, record: shaped, raw, budget },
    );
}

function normalizeKey(kind: BatchKind, input: unknown): string | null {
    return kind === 'doi' ? normalizeDoi(input) : normalizeWorkId(input);
}

function invalidInput(kind: BatchKind, input: unknown): OpenAlexError<'INVALID_DOI' | 'INVALID_ID'> {
    return kind === 'doi'
        ? createError('INVALID_DOI', { input: label(input) })
        : createError('INVALID_ID', { input: label(input) });
}

async function fetchContentImpl(
    workId: string,
    settings: MergedOptions,
    queues: RequestQueues,
): Promise<Result<ContentData, FetchContentErrorCode>> {
    if ((settings.apiKey ?? '') === '') {
        return err(invalidOption('apiKey', 'is required for content downloads (OpenAlex rejects them without a key)'));
    }

    const id = normalizeWorkId(workId);
    if (id === null) {
        return err(createError('INVALID_ID', { input: label(workId) }));
    }

    if (settings.format === 'xml') {
        const response = await send(settings, queues, 'paid', (options) => requestXml(id, options));
        if (!response.ok) {
            return response;
        }
        const data: XmlContent = {
            workId: id,
            format: 'xml',
            pdf: null,
            xml: response.data.body,
            budget: response.data.budget,
        };
        return ok(data);
    }

    const response = await send(settings, queues, 'paid', (options) => requestPdf(id, options));
    if (!response.ok) {
        return response;
    }
    const data: PdfContent = {
        workId: id,
        format: 'pdf',
        pdf: response.data.body,
        xml: null,
        budget: response.data.budget,
    };
    return ok(data);
}

async function fetchBudgetImpl(
    settings: MergedOptions,
    queues: RequestQueues,
): Promise<Result<BudgetStatus, FetchBudgetErrorCode>> {
    if ((settings.apiKey ?? '') === '') {
        return err(invalidOption('apiKey', 'is required for fetchBudget (OpenAlex rejects /rate-limit without a key)'));
    }

    const response = await send(settings, queues, 'free', requestBudget);
    if (!response.ok) {
        return response;
    }
    const data = toBudgetStatus(response.data.body);
    if (data === null) {
        const error = createError('PARSE', {
            body: `unexpected /rate-limit shape: ${describeBody(response.data.body)}`,
        });
        return err({ ...error, budget: response.data.budget });
    }
    return ok(data);
}

/** Formats response body snippet for error diagnostics. */
function describeBody(body: unknown): string {
    return summarizeBody(JSON.stringify(body));
}

async function run<T, C extends OpenAlexErrorCode>(
    merged: Result<MergedOptions, 'INVALID_OPTIONS'>,
    fn: (options: MergedOptions) => Promise<Result<T, C>>,
): Promise<Result<T, C | 'INVALID_OPTIONS'>> {
    return merged.ok ? fn(merged.data) : merged;
}

function createOpenAlexImpl(opts?: unknown): OpenAlex {
    const factory = snapshotFactoryOptions(opts);
    const created = createRequestQueues(factory.limits, factory.limiterOptions, factory.apiKey !== undefined);
    if (!created.ok) {
        throw configError(created.error);
    }
    const queues = created.data;
    return Object.freeze({
        fetchDoi: ((input: unknown, perCall?: unknown) =>
            lookup('doi', input, mergeCall(factory, perCall, DOI_KEYS), queues)) as FetchDoi,
        fetchWorkById: ((input: unknown, perCall?: unknown) =>
            lookup('id', input, mergeCall(factory, perCall, WORK_KEYS), queues)) as FetchWorkById,
        fetchContent: ((id: string, perCall?: unknown) =>
            run(mergeCall(factory, perCall, CONTENT_KEYS), (o) => fetchContentImpl(id, o, queues))) as FetchContent,
        fetchBudget: ((perCall?: unknown) =>
            run(mergeCall(factory, perCall, BUDGET_KEYS), (o) => fetchBudgetImpl(o, queues))) as FetchBudget,
    });
}
