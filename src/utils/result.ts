// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import type { OpenAlexError, OpenAlexErrorCode } from './errors.js';

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

/** Successful result envelope carrying data payload. */
export type Ok<T> = { readonly ok: true; readonly data: T };

/** Failure result envelope carrying OpenAlexError; C narrows the codes it can hold. */
export type Err<C extends OpenAlexErrorCode = OpenAlexErrorCode> = {
    readonly ok: false;
    readonly error: OpenAlexError<C>;
};

/** Non-throwing Result envelope discriminated on ok boolean. */
export type Result<T, C extends OpenAlexErrorCode = OpenAlexErrorCode> = Ok<T> | Err<C>;

// -------------------------------------------------------------------
// --- 2. Exported Functions
// -------------------------------------------------------------------

/** Wraps value into successful Result envelope. */
export function ok<T>(data: T): Ok<T> {
    return { ok: true, data };
}

/** Wraps OpenAlexError into failure Result envelope. */
export function err<C extends OpenAlexErrorCode>(error: OpenAlexError<C>): Err<C> {
    return { ok: false, error };
}
