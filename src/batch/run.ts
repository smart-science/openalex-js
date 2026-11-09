// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import type { Budget } from '../content/types.js';
import { normalizeWorkId } from '../identifiers/work-id.js';
import { combineSignals, type RequestQueues, schedule } from '../transport/limiter.js';
import {
    type Fetched,
    LIST_PAGE_SIZE,
    MAX_LIST_RESULTS,
    type RequestOptions,
    requestWork,
    requestWorkById,
    requestWorks,
    type WorkList,
} from '../transport/request.js';
import { createError, type OpenAlexError, type TransportErrorCode } from '../utils/errors.js';
import { err } from '../utils/result.js';
import { asObject } from '../utils/values.js';
import type { OpenAlexWork } from '../work/api-types.js';
import { type BatchKind, type Entry, planRequests } from './chunk.js';
import { doiKeys, indexWorks, isPrimaryDoi, isTruncated, pickWork } from './match.js';
import type { BatchRequests, BatchStrategy } from './types.js';

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

/** Lookup result of one distinct key, with the budget of the response it came from. */
export type KeyResult = Fetched<OpenAlexWork, 'NOT_FOUND'>;

/** Settings of one array lookup. */
export type ResolveOptions = {
    readonly queues: RequestQueues;
    readonly request: RequestOptions;
    readonly strategy: BatchStrategy;
    /** A RATE_LIMITED list request falls back to single lookups instead of failing its keys. */
    readonly fallbackOnRateLimit: boolean;
    /** A chunk with fewer keys is sent as single lookups instead of a list request; 0 turns this off. */
    readonly singleBelow: number;
};

/** Distinct works of the list pages read for one chunk, each with the budget of the page it came from. */
type ListedWorks = {
    readonly works: OpenAlexWork[];
    /** W ids already read, so a work repeated on a later page is counted once against `meta.count`. */
    readonly ids: Set<string>;
    readonly budgets: Map<OpenAlexWork, Budget | null>;
};

/** Outcome of one array lookup: a result per distinct valid key. */
export type Resolved = {
    readonly results: ReadonlyMap<string, KeyResult>;
    readonly budget: Budget | null;
    readonly requests: BatchRequests;
};

/** Mutable state shared by the requests of one array lookup. */
type Run = {
    readonly kind: BatchKind;
    readonly options: ResolveOptions;
    readonly signal: AbortSignal | undefined;
    readonly results: Map<string, KeyResult>;
    readonly budgets: (Budget | null)[];
    /** Refetches by W id, shared so each truncated work is fetched once. */
    readonly refetches: Map<string, Promise<KeyResult>>;
    list: number;
    single: number;
};

// -------------------------------------------------------------------
// --- 2. Constants
// -------------------------------------------------------------------

/** Summed costs are rounded to this many decimal places (micro-dollars). */
const COST_DECIMALS = 6;
const COST_SCALE = 10 ** COST_DECIMALS;
/** Follow-ups of a finished list request start before requests pushed later, so lookups finish in order. */
const FOLLOW_UP_PRIORITY = 1;

// -------------------------------------------------------------------
// --- 3. Exported Functions
// -------------------------------------------------------------------

/**
 * **Resolves keys** with list requests and single-lookup fallbacks.
 *
 * - list requests use paid queue; single lookups and refetches use free queue
 * - follow-ups of finished list requests (next pages, fallbacks, refetches) jump ahead of new requests
 * - unmatched keys fall back to single lookup (404 becomes NOT_FOUND)
 * - truncated works are refetched by W id; failed refetch becomes key error (404 becomes HTTP 404, not NOT_FOUND)
 * - list requests rejected for content (400, 404, PARSE) or RATE_LIMITED with fallbackOnRateLimit fall back to single lookups; other errors fail all chunk keys
 */
export async function resolveBatch(
    kind: BatchKind,
    entries: readonly Entry[],
    options: ResolveOptions,
): Promise<Resolved> {
    const state: Run = {
        kind,
        options,
        signal: combineSignals(options.request.signal, options.request.clientSignal),
        results: new Map(),
        budgets: [],
        refetches: new Map(),
        list: 0,
        single: 0,
    };
    const plan = planRequests(entries, kind, options.strategy, options.singleBelow);
    await Promise.all([
        ...plan.lists.map((chunk) => resolveChunk(state, chunk)),
        ...plan.singles.map((key) => resolveSingle(state, key, 0)),
    ]);
    return {
        results: state.results,
        budget: aggregateBudgets(state.budgets),
        requests: { list: state.list, single: state.single },
    };
}

// -------------------------------------------------------------------
// --- 4. Private Functions
// -------------------------------------------------------------------

/**
 * **Resolves one chunk** across list pages.
 *
 * - pages while entries received < `meta.count`, last page was full, and next page <= MAX_LIST_RESULTS; a later page adding no new work ends the list
 * - repeated or id-less entries count toward pages read, not toward `complete`
 * - incomplete list (failed later page, MAX_LIST_RESULTS cap, or count mismatch) only settles primary DOI / exact W id matches; remaining keys fall back to single lookup or fail via failKeys
 * - unmatched keys in a complete list fall back to single lookup
 */
async function resolveChunk(state: Run, chunk: readonly string[]): Promise<void> {
    const first = await requestPage(state, chunk, 1);
    if (!first.ok) {
        await failKeys(state, chunk, first.error);
        return;
    }
    const listed: ListedWorks = { works: [], ids: new Set(), budgets: new Map() };
    addPage(listed, first.data.body.results, first.data.budget);
    const count = first.data.body.meta?.count;
    const known = typeof count === 'number';
    let lastSize = first.data.body.results.length;
    let seen = lastSize;
    let failure: OpenAlexError<TransportErrorCode> | null = null;
    for (
        let page = 2;
        (!known || seen < count) && lastSize === LIST_PAGE_SIZE && page * LIST_PAGE_SIZE <= MAX_LIST_RESULTS;
        page++
    ) {
        const next = await requestPage(state, chunk, page);
        if (!next.ok) {
            failure = next.error;
            break;
        }
        const before = listed.works.length;
        addPage(listed, next.data.body.results, next.data.budget);
        lastSize = next.data.body.results.length;
        seen += lastSize;
        if (listed.works.length === before) {
            break;
        }
    }
    const complete = failure === null && (known ? count <= listed.works.length : lastSize < LIST_PAGE_SIZE);
    const index = indexWorks(listed.works, state.kind);
    const refetched = state.kind === 'doi' ? await refetchTruncated(state, listed.works) : new Map();
    for (const [work, full] of refetched) {
        addFullKeys(index, work, full);
    }
    await Promise.all(
        chunk.map(async (key) => {
            const work = pickWork(index.get(key) ?? [], state.kind === 'doi' ? key : null);
            if (work === null || !(complete || state.kind === 'id' || isPrimaryDoi(work, key))) {
                return failure === null
                    ? resolveSingle(state, key, FOLLOW_UP_PRIORITY)
                    : failKeys(state, [key], failure);
            }
            const workId = normalizeWorkId(work.id);
            // a cut work is refetched once per lookup (shared promise); a failed refetch is the key's result
            const full = isTruncated(work) && workId !== null ? await refetch(state, workId) : null;
            state.results.set(
                key,
                full ?? { ok: true, data: { body: work, budget: listed.budgets.get(work) ?? null } },
            );
        }),
    );
}

/**
 * **Refetches truncated works** of a DOI list by W id before matching.
 *
 * - discovers DOIs in locations past the 100-entry list cap
 * - shares refetch promise with resolveChunk so picked works are fetched once
 */
async function refetchTruncated(state: Run, works: readonly OpenAlexWork[]): Promise<Map<OpenAlexWork, OpenAlexWork>> {
    const refetched = new Map<OpenAlexWork, OpenAlexWork>();
    await Promise.all(
        works.map(async (work) => {
            const workId = normalizeWorkId(work.id);
            if (!isTruncated(work) || workId === null) {
                return;
            }
            const result = await refetch(state, workId);
            if (result.ok && asObject(result.data.body) !== null) {
                refetched.set(work, result.data.body);
            }
        }),
    );
    return refetched;
}

/**
 * **Adds the DOIs of a refetched body** to the index, as candidates pointing to the cut list work.
 *
 * - the cut work keeps the keys it was indexed by, so a merged (other W id) or malformed body never
 *   drops a key: the key still picks the cut work and gets the refetch result, PARSE for a broken body
 * - only DOIs the cut work lacks are added (those of locations past the cut)
 */
function addFullKeys(index: Map<string, OpenAlexWork[]>, work: OpenAlexWork, full: OpenAlexWork): void {
    for (const key of doiKeys(full)) {
        const candidates = index.get(key);
        if (candidates === undefined) {
            index.set(key, [work]);
        } else if (!candidates.includes(work)) {
            candidates.push(work);
        }
    }
}

/** Sends one list page through the paid queue; later pages are follow-ups. */
async function requestPage(state: Run, chunk: readonly string[], page: number): Promise<Fetched<WorkList, 'HTTP'>> {
    const field = state.kind === 'doi' ? 'doi' : 'openalex';
    const fetched = await schedule(
        state.options.queues,
        'paid',
        counted(state, 'list', () => requestWorks(field, chunk, state.options.request, page)),
        { signal: state.signal, priority: page === 1 ? 0 : FOLLOW_UP_PRIORITY },
    );
    record(state, fetched);
    return fetched;
}

/**
 * **Adds the works of one page**.
 *
 * - a W id already read on an earlier page is skipped, so works count each work once
 * - an entry that is not an object or has no valid W id is skipped and not counted, so the list is not
 *   complete against `meta.count` and keys it might have matched fall back to single lookup
 */
function addPage(listed: ListedWorks, works: readonly OpenAlexWork[], budget: Budget | null): void {
    for (const work of works) {
        const id = asObject(work) === null ? null : normalizeWorkId(work.id);
        if (id === null || listed.ids.has(id)) {
            continue;
        }
        listed.ids.add(id);
        listed.works.push(work);
        listed.budgets.set(work, budget);
    }
}

/**
 * **Settles keys of a failed list page**.
 *
 * - shared failure (see isSharedFailure): the error of every key, unless it is RATE_LIMITED with
 *   fallbackOnRateLimit
 * - otherwise single lookup per key
 */
async function failKeys(state: Run, keys: readonly string[], error: OpenAlexError<TransportErrorCode>): Promise<void> {
    const fallBack = error.code === 'RATE_LIMITED' && state.options.fallbackOnRateLimit;
    if (isSharedFailure(error) && !fallBack) {
        for (const key of keys) {
            state.results.set(key, err(error));
        }
        return;
    }
    await Promise.all(keys.map((key) => resolveSingle(state, key, FOLLOW_UP_PRIORITY)));
}

async function resolveSingle(state: Run, key: string, priority: number): Promise<void> {
    const lookup = state.kind === 'doi' ? requestWork : requestWorkById;
    const run = counted(state, 'single', () => lookup(key, state.options.request));
    const fetched = await schedule(state.options.queues, 'free', run, { signal: state.signal, priority });
    record(state, fetched);
    state.results.set(key, fetched);
}

/** Fetches a full work by W id once per array lookup; a 404 is HTTP 404 (see resolveBatch). */
function refetch(state: Run, workId: string): Promise<KeyResult> {
    const pending = state.refetches.get(workId);
    if (pending !== undefined) {
        return pending;
    }
    const run = counted(state, 'single', () => requestWorkById(workId, state.options.request));
    const promise = schedule(state.options.queues, 'free', run, {
        signal: state.signal,
        priority: FOLLOW_UP_PRIORITY,
    }).then((fetched): KeyResult => {
        record(state, fetched);
        if (fetched.ok || fetched.error.code !== 'NOT_FOUND') {
            return fetched;
        }
        const body = `${workId} was in the list response, but its refetch found no work`;
        return { ok: false, error: { ...createError('HTTP', { status: 404, body }), budget: fetched.error.budget } };
    });
    state.refetches.set(workId, promise);
    return promise;
}

/** Request that counts itself in state.list or state.single when first sent; refused and retried sends are not counted. */
function counted<T>(state: Run, kind: 'list' | 'single', request: () => Promise<T>): () => Promise<T> {
    let sent = false;
    return () => {
        if (!sent) {
            sent = true;
            state[kind] += 1;
        }
        return request();
    };
}

/** Records the budget of one finished request. */
function record(state: Run, fetched: Fetched<unknown, 'NOT_FOUND'>): void {
    state.budgets.push(fetched.ok ? fetched.data.budget : fetched.error.budget);
}

/**
 * **True when a failed list request would fail its single lookups too**.
 *
 * - ABORTED, AUTH, and every retryable error (RATE_LIMITED, NETWORK, TIMEOUT, HTTP 408, 425 and 5xx)
 * - false for the rest (400, 404, PARSE), which single lookups may still answer
 */
function isSharedFailure(error: OpenAlexError): boolean {
    return error.retryable || error.code === 'ABORTED' || error.code === 'AUTH';
}

/**
 * **Combines budgets** of all responses.
 *
 * - cost_usd: sum of known costs, rounded to COST_DECIMALS places to drop float noise
 * - other fields: from the response with the lowest daily_remaining_usd (the latest state); on a tie the
 *   response that finished last wins, so its prepaid balance and reset time are the newest
 * - null when no response carried budget headers
 */
function aggregateBudgets(budgets: readonly (Budget | null)[]): Budget | null {
    const known = budgets.filter((budget) => budget !== null);
    if (known.length === 0) {
        return null;
    }
    let latest = known[0] as Budget;
    let cost: number | null = null;
    for (const budget of known) {
        if (budget.cost_usd !== null) {
            cost = (cost ?? 0) + budget.cost_usd;
        }
        if (
            (budget.daily_remaining_usd ?? Number.POSITIVE_INFINITY) <=
            (latest.daily_remaining_usd ?? Number.POSITIVE_INFINITY)
        ) {
            latest = budget;
        }
    }
    return { ...latest, cost_usd: cost === null ? null : Math.round(cost * COST_SCALE) / COST_SCALE };
}
