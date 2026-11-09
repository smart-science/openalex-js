// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { expect, mock } from 'bun:test';
import type { OpenAlexOptions } from '../src/client.js';
import type { OpenAlexError } from '../src/utils/errors.js';
import type { OpenAlexWork } from '../src/work/api-types.js';
import type { WorkRecord } from '../src/work/record-types.js';
import type { RenameMap } from '../src/work/rename.js';

export type WorkFixtureName = 'work-article' | 'work-open-access' | 'work-legacy' | 'work-preprint';

export type RecordedCall = {
    readonly input: unknown;
    readonly url: string;
    readonly init: RequestInit | undefined;
    readonly method: string;
    readonly headers: Headers;
    readonly signal: AbortSignal | null;
};

export type Responder = (call: RecordedCall, callIndex: number) => unknown;

export type TrackedFetch = {
    readonly fn: typeof fetch;
    readonly calls: RecordedCall[];
};

export type RecordedTimer = {
    readonly ms: number | undefined;
    readonly fire: () => void;
};

export type FetchTrap = {
    assertUntouched(): void;
    callCount(): number;
    set(value: unknown): void;
    restore(): void;
};

export type OkPayload = {
    readonly data: unknown;
};

export type WorkPayload = {
    readonly requestedDoi: string;
    readonly record: unknown;
    readonly raw: unknown;
};

const FIXTURE_DIR = `${import.meta.dir}/fixtures`;

export const WORK_FIXTURE_NAMES: readonly WorkFixtureName[] = [
    'work-article',
    'work-open-access',
    'work-legacy',
    'work-preprint',
];

export const SINGLE_ATTEMPT = { maxRetries: 0, maxWaitMs: 1000 } as const;

export const ERROR_KEYS = ['budget', 'cause', 'code', 'message', 'retryAfterSeconds', 'retryable', 'status'] as const;

export const HOSTILE_VALUES: readonly unknown[] = [
    undefined,
    null,
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '',
    '   ',
    'x',
    true,
    false,
    [],
    [1, 2],
    {},
    { a: 1 },
    Symbol('hostile'),
    () => 1,
    new Date(0),
    /re/,
    new Map(),
    new Set(),
    10n,
    JSON.parse('{"__proto__":{"polluted":true}}'),
    Object.create(null),
    new Proxy(
        {},
        {
            get() {
                throw new Error('hostile getter');
            },
            ownKeys() {
                throw new Error('hostile ownKeys');
            },
        },
    ),
];

export async function loadWorkJson(name: WorkFixtureName): Promise<Record<string, unknown>> {
    return (await Bun.file(`${FIXTURE_DIR}/${name}.json`).json()) as Record<string, unknown>;
}

export async function loadWork(name: WorkFixtureName): Promise<OpenAlexWork> {
    return (await loadWorkJson(name)) as unknown as OpenAlexWork;
}

export async function loadFixtureText(fileName: string): Promise<string> {
    return await Bun.file(`${FIXTURE_DIR}/${fileName}`).text();
}

export async function loadPackageJson(): Promise<Record<string, unknown>> {
    return (await Bun.file(`${import.meta.dir}/../package.json`).json()) as Record<string, unknown>;
}

export function asWork(value: unknown): OpenAlexWork {
    return value as OpenAlexWork;
}

export function asRecord(value: unknown): WorkRecord {
    return value as WorkRecord;
}

export function asRenameMap(value: unknown): Record<never, RenameMap[string]> {
    return value as Record<never, RenameMap[string]>;
}

export function asOptions(value: unknown): OpenAlexOptions {
    return value as OpenAlexOptions;
}

export function asDoi(value: unknown): string {
    return value as string;
}

export function makeFetch(responder: Responder): TrackedFetch;
export function makeFetch(responder: unknown): TrackedFetch;
export function makeFetch(responder: unknown): TrackedFetch {
    const calls: RecordedCall[] = [];
    const fn = ((input: unknown, init?: RequestInit): Promise<unknown> => {
        const call = recordCall(input, init);
        calls.push(call);
        const value = typeof responder === 'function' ? (responder as Responder)(call, calls.length - 1) : responder;
        return value instanceof Promise ? (value as Promise<unknown>) : Promise.resolve(value);
    }) as unknown as typeof fetch;
    return { fn, calls };
}

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
        ...init,
    });
}

export function textResponse(body: string, init?: ResponseInit): Response {
    return new Response(body, { status: 200, ...init });
}

export function abortableFetch(failAfterMs = 150): TrackedFetch {
    return makeFetch(
        (call: RecordedCall) =>
            new Promise((_resolve, reject) => {
                const timer = setTimeout(() => {
                    reject(new Error('TEST-SAFETY-NET: the request was never aborted'));
                }, failAfterMs);
                call.signal?.addEventListener('abort', () => {
                    clearTimeout(timer);
                    const reason = call.signal?.reason;
                    reject(reason instanceof Error ? reason : new Error('aborted'));
                });
            }),
    );
}

export function recordTimers(): { readonly timers: RecordedTimer[]; readonly restore: () => void } {
    const original = globalThis.setTimeout;
    const timers: RecordedTimer[] = [];
    globalThis.setTimeout = ((callback: () => void, ms?: number) => {
        const handle = original(callback, ms);
        timers.push({
            ms,
            fire: () => {
                clearTimeout(handle);
                callback();
            },
        });
        return handle;
    }) as unknown as typeof setTimeout;
    return {
        timers,
        restore: () => {
            globalThis.setTimeout = original;
        },
    };
}

export function installGlobalFetchTrap(): FetchTrap {
    const original = globalThis.fetch;
    const trap = mock((..._args: unknown[]): never => {
        throw new Error('FORBIDDEN: a test reached globalThis.fetch — the default run must not use the network');
    });
    globalThis.fetch = trap as unknown as typeof fetch;
    return {
        assertUntouched(): void {
            expect(trap.mock.calls.length).toBe(0);
        },
        callCount(): number {
            return trap.mock.calls.length;
        },
        set(value: unknown): void {
            globalThis.fetch = value as typeof fetch;
        },
        restore(): void {
            globalThis.fetch = original;
        },
    };
}

export function expectUniformErrorShape(error: unknown): void {
    expect(typeof error).toBe('object');
    expect(error).not.toBeNull();
    expect(Object.keys(error as object).sort()).toEqual([...ERROR_KEYS]);
}

export function errorOf(result: unknown): OpenAlexError {
    expect(result).toBeDefined();
    const res = result as { ok?: unknown; error?: unknown };
    expect(res.ok).toBe(false);
    expectUniformErrorShape(res.error);
    return res.error as OpenAlexError;
}

export function batchOf<T>(
    result: { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: OpenAlexError },
): T {
    if (!result.ok) {
        throw new Error(`expected ok: true, got ${result.error.code}: ${result.error.message}`);
    }
    return result.data;
}

export function okOf(result: unknown): OkPayload {
    const res = result as { ok?: unknown; error?: unknown };
    if (res.ok !== true) {
        throw new Error(`expected ok:true, got ${JSON.stringify(res.error ?? res)}`);
    }
    return res as unknown as OkPayload;
}

export function workOf(result: unknown): WorkPayload {
    return okOf(result).data as WorkPayload;
}

export function typedOkOf<T extends { readonly ok: boolean }>(result: T): Extract<T, { readonly ok: true }> {
    okOf(result);
    return result as Extract<T, { readonly ok: true }>;
}

export function findUndefinedPaths(value: unknown, path = '$'): string[] {
    const found: string[] = [];
    if (value === undefined) {
        return [path];
    }
    if (value === null || typeof value !== 'object') {
        return found;
    }
    if (Array.isArray(value)) {
        value.forEach((item, i) => {
            found.push(...findUndefinedPaths(item, `${path}[${i}]`));
        });
        return found;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        found.push(...findUndefinedPaths(item, `${path}.${key}`));
    }
    return found;
}

export function stableJson(value: unknown): string {
    return JSON.stringify(value);
}

function urlOf(input: unknown): string {
    if (typeof input === 'string') {
        return input;
    }
    if (input instanceof URL) {
        return input.href;
    }
    if (input !== null && typeof input === 'object' && 'url' in input) {
        const candidate = (input as { url: unknown }).url;
        if (typeof candidate === 'string') {
            return candidate;
        }
    }
    return String(input);
}

function headersOf(init: RequestInit | undefined): Headers {
    const raw = init?.headers;
    if (raw === undefined || raw === null) {
        return new Headers();
    }
    return new Headers(raw);
}

function recordCall(input: unknown, init: RequestInit | undefined): RecordedCall {
    const fromInit = init?.signal;
    const fromInput =
        input !== null && typeof input === 'object' && 'signal' in input
            ? (input as { signal: unknown }).signal
            : undefined;
    const signal = fromInit ?? fromInput;
    return {
        input,
        url: urlOf(input),
        init,
        method: String(init?.method ?? 'GET').toUpperCase(),
        headers: headersOf(init),
        signal: signal instanceof AbortSignal ? signal : null,
    };
}
