// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { type Schema, WORK_SCHEMA } from '../../src/work/flat-schema.js';

const INTENTIONALLY_UNMAPPED: ReadonlySet<string> = new Set([
    'abstract_inverted_index',
    'sustainable_development_goals_aurora',
]);

export function unmappedFields(raw: unknown): string[] {
    const out = new Set<string>();
    walk(WORK_SCHEMA, raw, '', out);
    return [...out].sort();
}

function walk(schema: Schema, value: unknown, path: string, out: Set<string>): void {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        const full = path === '' ? key : `${path}.${key}`;
        const node = schema[key];
        if (node === undefined) {
            if (path !== '' || !INTENTIONALLY_UNMAPPED.has(key)) {
                out.add(full);
            }
        } else if (typeof node !== 'string') {
            const items = node.kind === 'obj' ? [child] : Array.isArray(child) ? child : [];
            for (const item of items) {
                walk(node.children, item, node.kind === 'obj' ? full : `${full}[]`, out);
            }
        }
    }
}
