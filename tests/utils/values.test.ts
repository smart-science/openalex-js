// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';

import { asArray, asBoolean, asNumber, asObject, asText, dedupe, label } from '../../src/utils/values.js';
import { HOSTILE_VALUES } from '../helpers.js';

describe('asObject', () => {
    test('accepts a plain object and returns the same reference', () => {
        const input = { a: 1 };
        expect(asObject(input)).toBe(input);
    });

    test('accepts objects from JSON, including one with a __proto__ key', () => {
        const parsed = JSON.parse('{"__proto__":{"polluted":true},"a":1}') as unknown;
        expect(asObject(parsed)).not.toBeNull();
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    test('accepts a null-prototype object', () => {
        expect(asObject(Object.create(null))).not.toBeNull();
    });

    test('rejects null, undefined, arrays and primitives', () => {
        for (const value of [null, undefined, [], [1], '', 'x', 0, 1, true, false, Symbol('s'), 1n]) {
            expect(asObject(value), String(typeof value)).toBeNull();
        }
    });

    test('accepts exotic objects — a Date, a Map, a RegExp', () => {
        for (const value of [new Date(), new Map(), /re/]) {
            expect(asObject(value)).not.toBeNull();
        }
    });

    test('never throws for any hostile value', () => {
        for (const value of HOSTILE_VALUES) {
            expect(() => asObject(value)).not.toThrow();
        }
    });
});

describe('asArray', () => {
    test('returns the same array reference', () => {
        const input = [1, 2];
        expect(asArray(input)).toBe(input);
    });

    test('returns an empty array for everything else — never undefined', () => {
        for (const value of [null, undefined, {}, 'abc', 0, true]) {
            expect(asArray(value)).toEqual([]);
        }
    });

    test('an empty array stays empty', () => {
        expect(asArray([])).toEqual([]);
    });

    test('never throws for any hostile value', () => {
        for (const value of HOSTILE_VALUES) {
            expect(() => asArray(value)).not.toThrow();
        }
    });
});

describe('asText', () => {
    test('trims surrounding whitespace', () => {
        expect(asText('  hello  ')).toBe('hello');
        expect(asText('\t\nhello\r\n')).toBe('hello');
    });

    test('keeps inner whitespace intact', () => {
        expect(asText(' a  b ')).toBe('a  b');
    });

    test('an empty or whitespace-only string is null', () => {
        for (const value of ['', ' ', '   ', '\t', '\n', ' '.trim()]) {
            expect(asText(value)).toBeNull();
        }
    });

    test('a non-string is null — numbers are never coerced here', () => {
        for (const value of [0, 1, 2013, true, false, null, undefined, {}, [], Symbol('s')]) {
            expect(asText(value)).toBeNull();
        }
    });

    test('never throws for any hostile value', () => {
        for (const value of HOSTILE_VALUES) {
            expect(() => asText(value)).not.toThrow();
        }
    });
});

describe('asNumber', () => {
    test('accepts finite numbers including zero and negatives', () => {
        expect(asNumber(0)).toBe(0);
        expect(asNumber(-1)).toBe(-1);
        expect(asNumber(1958)).toBe(1958);
        expect(asNumber(50.1343)).toBe(50.1343);
    });

    test('rejects NaN and both infinities', () => {
        expect(asNumber(Number.NaN)).toBeNull();
        expect(asNumber(Number.POSITIVE_INFINITY)).toBeNull();
        expect(asNumber(Number.NEGATIVE_INFINITY)).toBeNull();
    });

    test('rejects numeric strings — no coercion', () => {
        expect(asNumber('2013')).toBeNull();
        expect(asNumber('')).toBeNull();
    });

    test('rejects bigint, boolean, null and undefined', () => {
        for (const value of [1n, true, false, null, undefined, {}, []]) {
            expect(asNumber(value)).toBeNull();
        }
    });
});

describe('asBoolean', () => {
    test('only exactly true is true', () => {
        expect(asBoolean(true)).toBe(true);
    });

    test('every truthy non-boolean is false', () => {
        for (const value of [1, 'true', 'yes', {}, [], new Date()]) {
            expect(asBoolean(value)).toBe(false);
        }
    });

    test('every falsy value is false', () => {
        for (const value of [false, 0, '', null, undefined, Number.NaN]) {
            expect(asBoolean(value)).toBe(false);
        }
    });
});

describe('dedupe', () => {
    test('removes duplicates preserving first-occurrence order', () => {
        expect(dedupe(['b', 'a', 'b', 'c', 'a'])).toEqual(['b', 'a', 'c']);
    });

    test('leaves an already-unique list untouched', () => {
        expect(dedupe(['a', 'b'])).toEqual(['a', 'b']);
    });

    test('returns a new array, never the input reference', () => {
        const input = ['a'];
        expect(dedupe(input)).not.toBe(input);
        expect(dedupe(input)).toEqual(['a']);
    });

    test('an empty list stays empty', () => {
        expect(dedupe([])).toEqual([]);
    });

    test('is case-sensitive — different casings are different values', () => {
        expect(dedupe(['A', 'a'])).toEqual(['A', 'a']);
    });
});

describe('label', () => {
    test('returns a string unchanged, including a blank one', () => {
        expect(label('hello')).toBe('hello');
        expect(label('')).toBe('');
    });

    test('renders primitives the way a message needs them', () => {
        expect(label(42)).toBe('42');
        expect(label(null)).toBe('null');
        expect(label(undefined)).toBe('undefined');
        expect(label(true)).toBe('true');
    });

    test('renders a Symbol without throwing', () => {
        expect(label(Symbol('s'))).toBe('Symbol(s)');
    });

    test('falls back to the typeof when conversion throws', () => {
        expect(label(Object.create(null))).toBe('object');
        const hostile = {
            toString() {
                throw new Error('nope');
            },
        };
        expect(label(hostile)).toBe('object');
    });

    test('never throws for any hostile value', () => {
        for (const value of HOSTILE_VALUES) {
            expect(() => label(value)).not.toThrow();
            expect(typeof label(value)).toBe('string');
        }
    });
});
