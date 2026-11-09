// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

// -------------------------------------------------------------------
// --- 1. Exported Functions
// -------------------------------------------------------------------

/** Returns plain non-array object or null for invalid inputs. */
export function asObject(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

/** Checks for an object literal or null-prototype object; rejects Map, Date, AbortSignal, class instances. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    // Comparing against the prototype's own prototype keeps objects from another realm plain.
    return proto === null || Object.getPrototypeOf(proto) === null;
}

/** Returns array input or defensive empty array. */
export function asArray(value: unknown): readonly unknown[] {
    return Array.isArray(value) ? value : [];
}

/** Returns trimmed non-empty string or null. */
export function asText(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}

/** Returns trimmed non-empty string, or positive safe integer formatted as string, else null. */
export function asIdentifier(value: unknown): string | null {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
    }
    return asText(value);
}

/** Returns finite number or null. */
export function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Checks if value is strictly boolean true. */
export function asBoolean(value: unknown): boolean {
    return value === true;
}

/** Deduplicates array preserving first-occurrence order. */
export function dedupe(values: readonly string[]): string[] {
    return [...new Set(values)];
}

/** Returns safe string representation of any value without throwing. */
export function label(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    try {
        return String(value);
    } catch {
        return typeof value;
    }
}
