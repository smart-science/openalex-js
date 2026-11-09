// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { createError, type OpenAlexError } from '../utils/errors.js';
import { err, ok, type Result } from '../utils/result.js';
import { asObject, isPlainObject, label } from '../utils/values.js';
import { type FieldName, isFieldName, type WorkRecord } from './record-types.js';

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

/** Plain data map from target field name to canonical FieldName. */
export type RenameMap = Readonly<Record<string, FieldName>>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type IsUnion<T, U = T> = [T] extends [never] ? false : T extends unknown ? ([U] extends [T] ? false : true) : never;

/** Compile-time guard enforcing literal field names in rename map. */
export type StrictRenameMap<M extends RenameMap> = string extends keyof M
    ? {
          readonly 'rename map keys must be literal — declare it inline, `as const`, or with `satisfies RenameMap`': never;
      }
    : {
          readonly [K in keyof M]: IsUnion<M[K]> extends true
              ? 'rename map values must each be one literal field name'
              : M[K];
      };

/** Mapped WorkRecord type with renamed keys substituted. */
export type Renamed<M extends RenameMap> = Simplify<
    Omit<WorkRecord, M[keyof M]> & { readonly [K in keyof M]: WorkRecord[M[K]] }
>;

// -------------------------------------------------------------------
// --- 2. Exported Functions
// -------------------------------------------------------------------

/**
 * **Validate rename map**: checks rename map structure and field mappings.
 *
 * - validates plain object mapping new names to canonical field names
 * - verifies all mapped targets match known canonical field names
 * - detects and flags collisions with unmapped canonical fields
 */
export function validateRenameMap(
    map: unknown,
): OpenAlexError<'INVALID_OPTIONS' | 'INVALID_RENAME' | 'RENAME_COLLISION'> | null {
    let entries: [string, unknown][];
    try {
        if (!isPlainObject(map)) {
            return createError('INVALID_OPTIONS', {
                option: 'rename',
                reason: 'must be a plain object mapping new names to canonical field names',
            });
        }
        entries = Object.entries(map as Record<string, unknown>);
    } catch (cause) {
        return createError('INVALID_OPTIONS', { option: 'rename', reason: 'could not be read' }, cause);
    }

    const unknownNames: string[] = [];
    const sources = new Set<string>();

    for (const [, value] of entries) {
        if (isFieldName(value)) {
            sources.add(value);
        } else {
            unknownNames.push(label(value));
        }
    }
    if (unknownNames.length > 0) {
        return createError('INVALID_RENAME', { keys: unknownNames });
    }

    // A new name that matches a canonical field which is NOT itself renamed away would silently
    // overwrite real data.
    const collisions = entries.map(([key]) => key).filter((key) => isFieldName(key) && !sources.has(key));
    if (collisions.length > 0) {
        return createError('RENAME_COLLISION', { keys: collisions });
    }

    return null;
}

/**
 * **Apply field renaming**: transforms canonical WorkRecord using rename map.
 *
 * - validates rename map before transformation
 * - drops remapped source names and populates new target names
 * - returns Result envelope with Renamed payload
 */
export function applyRename<const M extends RenameMap>(
    record: WorkRecord,
    map: M & StrictRenameMap<M>,
): Result<Renamed<M>, 'INVALID_OPTIONS' | 'INVALID_RENAME' | 'RENAME_COLLISION'> {
    // One snapshot is validated and applied, so a getter cannot change the map in between.
    let snapshot: unknown;
    try {
        snapshot = isPlainObject(map) ? { ...map } : map;
    } catch (cause) {
        return err(createError('INVALID_OPTIONS', { option: 'rename', reason: 'could not be read' }, cause));
    }
    const error = validateRenameMap(snapshot);
    if (error !== null) {
        return err(error);
    }
    return renameFields(record, snapshot as M);
}

/** Renames WorkRecord fields using pre-validated rename map. */
export function renameFields<M extends RenameMap>(record: WorkRecord, map: M): Result<Renamed<M>, 'INVALID_OPTIONS'> {
    const source = asObject(record) ?? {};

    try {
        const pairs = Object.entries(map as Record<string, FieldName>);
        const renamedAway = new Set<string>(pairs.map(([, canonical]) => canonical));

        const entries: [string, unknown][] = [];
        for (const [key, value] of Object.entries(source)) {
            if (!renamedAway.has(key)) {
                entries.push([key, value]);
            }
        }
        for (const [newName, canonical] of pairs) {
            if (Object.hasOwn(source, canonical)) {
                entries.push([newName, source[canonical]]);
            }
        }

        return ok(Object.fromEntries(entries) as Renamed<M>);
    } catch (cause) {
        return err(createError('INVALID_OPTIONS', { option: 'rename', reason: 'could not be applied' }, cause));
    }
}
