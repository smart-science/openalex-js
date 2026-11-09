// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';

import type { OpenAlexError } from '../../src/utils/errors.js';
import type { WorkRecord } from '../../src/work/record-types.js';
import { FIELD_NAMES } from '../../src/work/record-types.js';
import { applyRename, validateRenameMap } from '../../src/work/rename.js';
import { toWorkRecord } from '../../src/work/to-record.js';
import { asRecord, asRenameMap, ERROR_KEYS, errorOf, loadWork, okOf, stableJson } from '../helpers.js';

async function record(): Promise<WorkRecord> {
    const shaped = toWorkRecord(await loadWork('work-article'));
    if (shaped === null) {
        throw new Error('toWorkRecord rejected the fixture');
    }
    return shaped;
}

function dataOf(result: unknown): Record<string, unknown> {
    return okOf(result).data as Record<string, unknown>;
}

describe('rename semantics', () => {
    test('a renamed key appears under the new name and the old name is removed', async () => {
        const source = await record();
        const data = dataOf(applyRename(source, { ref_title: 'title' }));
        expect(data.ref_title).toBe(source.title);
        expect('title' in data).toBe(false);
        expect(data.title).toBeUndefined();
    });

    test('unmapped fields keep canonical names and values', async () => {
        const source = await record();
        const data = dataOf(applyRename(source, { ref_title: 'title' }));
        expect(data.journal).toBe(source.journal);
        expect(data.doi).toBe(source.doi);
        expect(data.oa_locations).toBe(source.oa_locations);
        expect(Object.keys(data)).toHaveLength(FIELD_NAMES.length);
    });

    test('multiple renames all apply', async () => {
        const source = await record();
        const data = dataOf(
            applyRename(source, {
                ref_title: 'title',
                ref_year: 'publication_year',
                ref_journal: 'journal',
            }),
        );
        expect(data.ref_title).toBe(source.title);
        expect(data.ref_year).toBe(source.publication_year);
        expect(data.ref_journal).toBe(source.journal);
        expect('title' in data).toBe(false);
        expect('publication_year' in data).toBe(false);
        expect('journal' in data).toBe(false);
    });

    test('types are preserved — values are copied, not stringified', async () => {
        const source = await record();
        const data = dataOf(
            applyRename(source, {
                ref_year: 'publication_year',
                ref_oa: 'open_access_is_oa',
                ref_locations: 'oa_locations',
                ref_cited: 'cited_by_count',
            }),
        );
        expect(typeof data.ref_year).toBe('number');
        expect(typeof data.ref_oa).toBe('boolean');
        expect(Array.isArray(data.ref_locations)).toBe(true);
        expect(data.ref_cited).toBe(1989);
    });

    test('a swap is allowed — both names are consumed', async () => {
        const source = await record();
        const data = dataOf(applyRename(source, { title: 'doi', doi: 'title' }));
        expect(data.title).toBe(source.doi);
        expect(data.doi).toBe(source.title);
        expect(Object.keys(data)).toHaveLength(FIELD_NAMES.length);
    });

    test('an identity map is a net no-op', async () => {
        const source = await record();
        const result = applyRename(source, { title: 'title' });
        const data = dataOf(result);
        expect(data.title).toBe(source.title);
        expect(Object.keys(data).sort()).toEqual([...FIELD_NAMES].sort());
    });

    test('an empty map returns an equal record', async () => {
        const source = await record();
        const data = dataOf(applyRename(source, {}));
        expect(data).toEqual(source as unknown as Record<string, unknown>);
        expect(Object.keys(data).sort()).toEqual([...FIELD_NAMES].sort());
    });

    test('many-to-one is allowed and the source is removed once', async () => {
        const source = await record();
        const data = dataOf(applyRename(source, { t1: 'title', t2: 'title' }));
        expect(data.t1).toBe(source.title);
        expect(data.t2).toBe(source.title);
        expect('title' in data).toBe(false);
        expect(Object.keys(data)).toHaveLength(FIELD_NAMES.length + 1);
    });

    test('duplicate targets are allowed and both receive the value', async () => {
        const source = await record();
        const data = dataOf(applyRename(source, { a: 'title', b: 'title' }));
        expect(data.a).toBe(source.title);
        expect(data.b).toBe(source.title);
        expect('title' in data).toBe(false);
    });

    test('renaming every field leaves exactly the new names', async () => {
        const source = await record();
        const map = Object.fromEntries(FIELD_NAMES.map((name) => [`db_${name}`, name]));
        const data = dataOf(applyRename(source, asRenameMap(map)));
        expect(Object.keys(data).sort()).toEqual(Object.keys(map).sort());
        expect(data.db_title).toBe(source.title);
    });

    test('the source record is never mutated', async () => {
        const source = await record();
        const before = stableJson(source);
        applyRename(source, { ref_title: 'title', ref_doi: 'doi' });
        expect(stableJson(source)).toBe(before);
        expect(source.title).not.toBeUndefined();
    });

    test('the renamed object is a new object, not the source', async () => {
        const source = await record();
        const data = dataOf(applyRename(source, {}));
        expect(data).not.toBe(source as unknown as Record<string, unknown>);
    });

    test('the result envelope carries only ok and data', async () => {
        const source = await record();
        const result = applyRename(source, { ref_title: 'title' });
        expect(Object.keys(result).sort()).toEqual(['data', 'ok']);
    });

    test('the renamed data is not frozen', async () => {
        const source = await record();
        expect(Object.isFrozen(dataOf(applyRename(source, { ref_title: 'title' })))).toBe(false);
    });
});

describe('unknown field names produce INVALID_RENAME', () => {
    test('one unknown name is reported', async () => {
        const error = errorOf(applyRename(await record(), asRenameMap({ x: 'titel' })));
        expect(error.code).toBe('INVALID_RENAME');
        expect(error.message).toBe('Unknown field name(s) in rename map: titel');
        expect(error.status).toBeNull();
        expect(error.retryAfterSeconds).toBeNull();
        expect(error.cause).toBeNull();
    });

    test('every offender is listed, not just the first', async () => {
        const error = errorOf(applyRename(await record(), asRenameMap({ x: 'titel', y: 'jahr', z: 'zeitschrift' })));
        expect(error.code).toBe('INVALID_RENAME');
        expect(error.message).toContain('titel');
        expect(error.message).toContain('jahr');
        expect(error.message).toContain('zeitschrift');
    });

    test('the offending values are listed, not the map keys', async () => {
        const error = errorOf(applyRename(await record(), asRenameMap({ db_column: 'titel' })));
        expect(error.message).toContain('titel');
        expect(error.message).not.toContain('db_column');
    });

    test('a valid entry alongside an invalid one still fails the whole map', async () => {
        const error = errorOf(applyRename(await record(), asRenameMap({ ref_title: 'title', ref_bad: 'nope' })));
        expect(error.code).toBe('INVALID_RENAME');
        expect(error.message).toContain('nope');
        expect(error.message).not.toContain('title,');
    });

    test('non-string values are stringified into the list', async () => {
        const error = errorOf(applyRename(await record(), asRenameMap({ a: 42, b: null })));
        expect(error.code).toBe('INVALID_RENAME');
        expect(error.message).toContain('42');
        expect(error.message).toContain('null');
    });

    test('a near-miss casing is still unknown', async () => {
        const error = errorOf(applyRename(await record(), asRenameMap({ x: 'Title' })));
        expect(error.code).toBe('INVALID_RENAME');
    });

    test('a prototype member is not a valid field name', async () => {
        for (const value of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
            const error = errorOf(applyRename(await record(), asRenameMap({ x: value })));
            expect(error.code, value).toBe('INVALID_RENAME');
        }
    });
});

describe('collisions produce RENAME_COLLISION', () => {
    test('a target that collides with a surviving canonical field is rejected', async () => {
        const error = errorOf(applyRename(await record(), { abstract: 'title' }));
        expect(error.code).toBe('RENAME_COLLISION');
        expect(error.message).toBe('Rename target(s) collide with existing field(s): abstract');
    });

    test('every colliding target is listed', async () => {
        const error = errorOf(applyRename(await record(), { abstract: 'title', journal: 'doi' }));
        expect(error.code).toBe('RENAME_COLLISION');
        expect(error.message).toContain('abstract');
        expect(error.message).toContain('journal');
    });

    test('no collision when the colliding name is itself renamed away', async () => {
        const source = await record();
        const result = applyRename(source, { abstract: 'title', ref_abstract: 'abstract' });
        const data = dataOf(result);
        expect(data.abstract).toBe(source.title);
        expect(data.ref_abstract).toBe(source.abstract);
    });

    test('a three-way rotation is allowed', async () => {
        const source = await record();
        const data = dataOf(applyRename(source, { title: 'doi', doi: 'journal', journal: 'title' }));
        expect(data.title).toBe(source.doi);
        expect(data.doi).toBe(source.journal);
        expect(data.journal).toBe(source.title);
    });

    test('validation order is shape -> unknown names -> collisions', async () => {
        const error = errorOf(applyRename(await record(), asRenameMap({ abstract: 'title', bad: 'nope' })));
        expect(error.code).toBe('INVALID_RENAME');
    });

    test('a collision never silently overwrites real data', async () => {
        const source = await record();
        const result = applyRename(source, { abstract: 'title' });
        expect(result.ok).toBe(false);
        expect(source.abstract).toBeNull();
    });
});

describe('non-object maps produce INVALID_OPTIONS', () => {
    const bad: readonly [string, unknown][] = [
        ['null', null],
        ['undefined', undefined],
        ['an array', []],
        ['a populated array', ['title']],
        ['a string', 'title'],
        ['a number', 42],
        ['true', true],
        ['a function', () => 'title'],
    ];

    for (const [label, value] of bad) {
        test(`${label} is rejected without throwing`, async () => {
            const source = await record();
            expect(() => applyRename(source, asRenameMap(value))).not.toThrow();
            const error = errorOf(applyRename(source, asRenameMap(value)));
            expect(error.code, label).toBe('INVALID_OPTIONS');
        });
    }
});

describe('prototype safety', () => {
    test('a __proto__ key produces an own property and does not pollute Object.prototype', async () => {
        const source = await record();
        const map = JSON.parse('{"__proto__":"title"}') as Record<string, string>;
        const result = applyRename(source, asRenameMap(map));
        const data = dataOf(result);

        expect(({} as Record<string, unknown>).title).toBeUndefined();
        expect(Object.getPrototypeOf({})).toBe(Object.prototype);
        expect(Object.getPrototypeOf(data)).toBe(Object.prototype);

        const descriptor = Object.getOwnPropertyDescriptor(data, '__proto__');
        expect(descriptor).toBeDefined();
        expect(descriptor?.value).toBe(source.title);
        expect(Object.keys(data)).toContain('__proto__');
    });

    test('a constructor key is an ordinary own property', async () => {
        const source = await record();
        const map = JSON.parse('{"constructor":"title"}') as Record<string, string>;
        const data = dataOf(applyRename(source, asRenameMap(map)));
        expect(Object.getOwnPropertyDescriptor(data, 'constructor')?.value).toBe(source.title);
        expect(({} as Record<string, unknown>).constructor).toBe(Object);
    });

    test('symbol keys are ignored via Object.keys semantics', async () => {
        const source = await record();
        const symbol = Symbol('ref_title');
        const map = { ref_doi: 'doi' } as Record<string | symbol, unknown>;
        map[symbol] = 'title';
        const data = dataOf(applyRename(source, asRenameMap(map)));
        expect(data.ref_doi).toBe(source.doi);
        expect(data.title).toBe(source.title);
        expect(Object.getOwnPropertySymbols(data)).toHaveLength(0);
    });

    test('non-enumerable keys are ignored', async () => {
        const source = await record();
        const map = { ref_doi: 'doi' };
        Object.defineProperty(map, 'hidden', { value: 'title', enumerable: false });
        const data = dataOf(applyRename(source, asRenameMap(map)));
        expect('hidden' in data).toBe(false);
        expect(data.title).toBe(source.title);
    });
});

describe('applyRename never throws', () => {
    const records: readonly [string, unknown][] = [
        ['null', null],
        ['undefined', undefined],
        ['an empty object', {}],
        ['a string', 'not a record'],
        ['an array', []],
        ['a number', 42],
    ];

    for (const [label, value] of records) {
        test(`a ${label} record does not throw`, () => {
            expect(() => applyRename(asRecord(value), { ref_title: 'title' })).not.toThrow();
            const result = applyRename(asRecord(value), { ref_title: 'title' }) as { ok: unknown };
            expect(typeof result.ok).toBe('boolean');
        });
    }

    test('a hostile getter on the map does not throw', async () => {
        const source = await record();
        const map = {} as Record<string, string>;
        Object.defineProperty(map, 'boom', {
            enumerable: true,
            get() {
                throw new Error('hostile getter');
            },
        });
        expect(() => applyRename(source, asRenameMap(map))).not.toThrow();
    });

    test('a getter is read once, so validation and application see the same map', async () => {
        const source = await record();
        let reads = 0;
        const map = {} as Record<string, string>;
        Object.defineProperty(map, 'ref_title', {
            enumerable: true,
            get: () => (reads++ === 0 ? 'title' : 'nope'),
        });
        const data = dataOf(applyRename(source, asRenameMap(map)));
        expect(data.ref_title).toBe(source.title);
        expect('title' in data).toBe(false);
    });

    test('a field missing from the record is not added as undefined', () => {
        const data = dataOf(applyRename(asRecord({}), { ref_title: 'title' }));
        expect(Object.hasOwn(data, 'ref_title')).toBe(false);
    });

    test('an unreadable map keeps the cause', () => {
        const boom = new Error('ownKeys');
        const map = new Proxy(
            {},
            {
                ownKeys: () => {
                    throw boom;
                },
            },
        );
        expect(errorOf(applyRename(asRecord({}), asRenameMap(map))).cause).toBe(boom);
    });

    test('a Map is not a rename map', async () => {
        const map = new Map([['ref_title', 'title']]);
        expect(errorOf(applyRename(await record(), asRenameMap(map))).code).toBe('INVALID_OPTIONS');
    });

    test('a very large map does not throw', async () => {
        const source = await record();
        const map = Object.fromEntries(Array.from({ length: 500 }, (_unused, i) => [`col_${i}`, 'title']));
        expect(() => applyRename(source, asRenameMap(map))).not.toThrow();
        const data = dataOf(applyRename(source, asRenameMap(map)));
        expect(data.col_0).toBe(source.title);
        expect(data.col_499).toBe(source.title);
    });
});

describe('validateRenameMap', () => {
    test('returns null for a valid map', () => {
        expect(validateRenameMap({ ref_title: 'title' })).toBeNull();
        expect(validateRenameMap({})).toBeNull();
        expect(validateRenameMap({ title: 'doi', doi: 'title' })).toBeNull();
    });

    test('returns an INVALID_RENAME error for unknown names', () => {
        const error = validateRenameMap({ x: 'titel' }) as OpenAlexError;
        expect(error).not.toBeNull();
        expect(error.code).toBe('INVALID_RENAME');
        expect(error.message).toContain('titel');
    });

    test('returns a RENAME_COLLISION error for a colliding target', () => {
        const error = validateRenameMap({ abstract: 'title' }) as OpenAlexError;
        expect(error?.code).toBe('RENAME_COLLISION');
    });

    test('returns an INVALID_OPTIONS error for a non-object map', () => {
        for (const value of [null, undefined, [], 'title', 42]) {
            const error = validateRenameMap(value) as OpenAlexError;
            expect(error?.code, String(value)).toBe('INVALID_OPTIONS');
        }
    });

    test('never throws', () => {
        for (const value of [null, undefined, [], 'x', 42, {}, { a: 1 }, () => 'x']) {
            expect(() => validateRenameMap(value)).not.toThrow();
        }
    });

    test('every returned error keeps the uniform six-key shape', () => {
        for (const value of [{ x: 'titel' }, { abstract: 'title' }, null]) {
            const error = validateRenameMap(value);
            if (error === null) {
                continue;
            }
            expect(Object.keys(error).sort()).toEqual([...ERROR_KEYS]);
        }
    });
});
