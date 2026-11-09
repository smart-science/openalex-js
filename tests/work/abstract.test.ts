// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import { MAX_ABSTRACT_POSITION } from '../../src/utils/constants.js';
import { reconstructAbstract } from '../../src/work/abstract.js';
import { loadWork, stableJson } from '../helpers.js';

type Index = Readonly<Record<string, readonly number[]>> | null | undefined;

function asIndex(value: unknown): Index {
    return value as Index;
}

describe('happy path', () => {
    test('reconstructs a simple index in position order', () => {
        expect(reconstructAbstract({ Hello: [0], world: [1] })).toBe('Hello world');
    });

    test('key order in the object does not affect the output order', () => {
        expect(reconstructAbstract({ world: [1], Hello: [0] })).toBe('Hello world');
    });

    test('a repeated token is written at every one of its positions', () => {
        expect(reconstructAbstract({ the: [0, 2, 4], cat: [1], sat: [3] })).toBe('the cat the sat the');
    });

    test('a token repeated many times over a long span', () => {
        const out = reconstructAbstract({ a: [0, 2, 4, 6, 8], b: [1, 3, 5, 7, 9] });
        expect(out).toBe('a b a b a b a b a b');
    });

    test('tokens containing punctuation are preserved verbatim', () => {
        expect(reconstructAbstract({ 'BACKGROUND:': [0], 'data.': [1] })).toBe('BACKGROUND: data.');
    });

    test('a numeric-looking token is a token, not a position', () => {
        expect(reconstructAbstract({ '85': [0], percent: [1] })).toBe('85 percent');
    });

    test('a single token at position 0', () => {
        expect(reconstructAbstract({ solo: [0] })).toBe('solo');
    });
});

describe('empty and non-object input → null', () => {
    test('null → null', () => {
        expect(reconstructAbstract(null)).toBeNull();
    });

    test('undefined → null', () => {
        expect(reconstructAbstract(undefined)).toBeNull();
    });

    test('{} → null', () => {
        expect(reconstructAbstract({})).toBeNull();
    });

    const nonObjects: readonly [string, unknown][] = [
        ['a string', 'not an index'],
        ['the empty string', ''],
        ['a number', 42],
        ['NaN', Number.NaN],
        ['true', true],
        ['false', false],
        ['an empty array', []],
        ['an array of pairs', [['a', [0]]]],
        ['an array of tokens', ['a', 'b']],
        ['a function', () => ({ a: [0] })],
    ];

    for (const [label, value] of nonObjects) {
        test(`${label} → null and does not throw`, () => {
            expect(() => reconstructAbstract(asIndex(value))).not.toThrow();
            expect(reconstructAbstract(asIndex(value))).toBeNull();
        });
    }
});

describe('sparse positions', () => {
    test('gaps are dropped, never emitted as double spaces', () => {
        expect(reconstructAbstract({ a: [0], b: [3] })).toBe('a b');
    });

    test('a leading gap produces no leading space', () => {
        const out = reconstructAbstract({ a: [5], b: [6] }) as string;
        expect(out).toBe('a b');
        expect(out.startsWith(' ')).toBe(false);
    });

    test('a trailing gap produces no trailing space', () => {
        const out = reconstructAbstract({ a: [0], b: [1] }) as string;
        expect(out.endsWith(' ')).toBe(false);
    });

    test('a wide sparse span still joins with single spaces', () => {
        const out = reconstructAbstract({ a: [0], b: [1000], c: [2000] }) as string;
        expect(out).toBe('a b c');
        expect(out).not.toContain('  ');
    });
});

describe('collisions — the last write wins', () => {
    test('two tokens at the same index keep the later key', () => {
        const index = JSON.parse('{"first":[0],"second":[0]}') as Record<string, number[]>;
        expect(reconstructAbstract(index)).toBe('second');
    });

    test('the losing key still contributes at its other positions', () => {
        const index = JSON.parse('{"a":[0,1],"b":[1]}') as Record<string, number[]>;
        expect(reconstructAbstract(index)).toBe('a b');
    });

    test('a three-way collision keeps the last key in insertion order', () => {
        const index = JSON.parse('{"x":[0],"y":[0],"z":[0]}') as Record<string, number[]>;
        expect(reconstructAbstract(index)).toBe('z');
    });

    test('a collision inside a longer abstract does not shift other tokens', () => {
        const index = JSON.parse('{"one":[0],"two":[1],"TWO":[1],"three":[2]}') as Record<string, number[]>;
        expect(reconstructAbstract(index)).toBe('one TWO three');
    });

    test('a canonical integer token enumerates first, so a word token at its position wins', () => {
        const index = JSON.parse('{"studies":[3],"2019":[3],"a":[0]}') as Record<string, number[]>;
        expect(reconstructAbstract(index)).toBe('a studies');
    });

    test('an integer token written last in the literal still loses to the last word token', () => {
        expect(reconstructAbstract({ b: [0], c: [0], '7': [0] })).toBe('c');
    });

    test('a non-canonical numeric token ("007") keeps insertion order', () => {
        expect(reconstructAbstract(JSON.parse('{"x":[0],"007":[0]}') as Record<string, number[]>)).toBe('007');
        expect(reconstructAbstract(JSON.parse('{"007":[0],"x":[0]}') as Record<string, number[]>)).toBe('x');
    });

    test('a duplicate position inside one token array is a no-op', () => {
        expect(reconstructAbstract({ a: [0, 0, 0], b: [1] })).toBe('a b');
    });
});

describe('invalid positions are skipped', () => {
    test('negative positions are skipped', () => {
        expect(reconstructAbstract({ a: [-1], b: [0] })).toBe('b');
        expect(reconstructAbstract({ a: [-5, 1], b: [0] })).toBe('b a');
    });

    test('fractional positions are skipped', () => {
        expect(reconstructAbstract({ a: [1.5], b: [0] })).toBe('b');
        expect(reconstructAbstract({ a: [0.1], b: [1] })).toBe('b');
    });

    test('NaN positions are skipped', () => {
        expect(reconstructAbstract({ a: [Number.NaN], b: [0] })).toBe('b');
    });

    test('Infinity and -Infinity positions are skipped', () => {
        expect(reconstructAbstract({ a: [Number.POSITIVE_INFINITY], b: [0] })).toBe('b');
        expect(reconstructAbstract({ a: [Number.NEGATIVE_INFINITY], b: [0] })).toBe('b');
    });

    test('non-number positions are skipped', () => {
        expect(reconstructAbstract(asIndex({ a: ['0'], b: [0] }))).toBe('b');
        expect(reconstructAbstract(asIndex({ a: [null], b: [0] }))).toBe('b');
        expect(reconstructAbstract(asIndex({ a: [undefined], b: [0] }))).toBe('b');
        expect(reconstructAbstract(asIndex({ a: [{}], b: [0] }))).toBe('b');
        expect(reconstructAbstract(asIndex({ a: [[0]], b: [0] }))).toBe('b');
        expect(reconstructAbstract(asIndex({ a: [true], b: [0] }))).toBe('b');
    });

    test('a valid position in the same array still counts', () => {
        expect(reconstructAbstract(asIndex({ a: [-1, 'x', Number.NaN, 1], b: [0] }))).toBe('b a');
    });
});

describe('values that are not arrays are skipped', () => {
    test('a string value is skipped', () => {
        expect(reconstructAbstract(asIndex({ a: '0', b: [0] }))).toBe('b');
    });

    test('a number value is skipped', () => {
        expect(reconstructAbstract(asIndex({ a: 0, b: [0] }))).toBe('b');
    });

    test('an object value is skipped', () => {
        expect(reconstructAbstract(asIndex({ a: { 0: 0 }, b: [0] }))).toBe('b');
    });

    test('null and undefined values are skipped', () => {
        expect(reconstructAbstract(asIndex({ a: null, b: [0] }))).toBe('b');
        expect(reconstructAbstract(asIndex({ a: undefined, b: [0] }))).toBe('b');
    });

    test('an empty array value contributes nothing', () => {
        expect(reconstructAbstract({ a: [], b: [0] })).toBe('b');
    });
});

describe('blank tokens occupy no slot', () => {
    test('an empty-string token is dropped without a doubled separator', () => {
        expect(reconstructAbstract({ '': [0], a: [1], b: [2] })).toBe('a b');
    });

    test('a whitespace-only token is dropped without a doubled separator', () => {
        expect(reconstructAbstract({ '   ': [1], a: [0], b: [2] })).toBe('a b');
    });

    test('a tab/newline-only token is dropped', () => {
        expect(reconstructAbstract({ '\t\n': [1], a: [0], b: [2] })).toBe('a b');
    });
});

describe('an empty result is null, never the empty string', () => {
    test('only invalid positions → null', () => {
        expect(reconstructAbstract({ a: [-1] })).toBeNull();
    });

    test('only empty arrays → null', () => {
        expect(reconstructAbstract({ a: [], b: [] })).toBeNull();
    });

    test('only non-array values → null', () => {
        expect(reconstructAbstract(asIndex({ a: 'x', b: 1 }))).toBeNull();
    });

    test('only blank tokens → null', () => {
        expect(reconstructAbstract({ '': [0], '  ': [1] })).toBeNull();
    });

    test('the result is never the empty string', () => {
        const candidates: Index[] = [{}, { a: [] }, { a: [-1] }, { '': [0] }, asIndex({ a: 'x' }), asIndex([])];
        for (const candidate of candidates) {
            expect(reconstructAbstract(candidate)).not.toBe('');
        }
    });
});

describe('allocation guard — MAX_ABSTRACT_POSITION', () => {
    test('exactly MAX_ABSTRACT_POSITION is allowed', () => {
        expect(reconstructAbstract({ a: [0], b: [MAX_ABSTRACT_POSITION] })).toBe('a b');
    });

    test('one past the guard aborts the whole abstract', () => {
        expect(reconstructAbstract({ a: [0], b: [MAX_ABSTRACT_POSITION + 1] })).toBeNull();
    });

    test('tokens are trimmed and inner whitespace collapsed', () => {
        expect(reconstructAbstract({ ' Hello ': [0], 'world\n': [1] })).toBe('Hello world');
        expect(reconstructAbstract({ 'a  b': [0], c: [1] })).toBe('a b c');
    });

    test('a blank token past the guard is ignored, not fatal', () => {
        expect(reconstructAbstract({ a: [0], b: [1], '': [MAX_ABSTRACT_POSITION + 1] })).toBe('a b');
        expect(reconstructAbstract({ a: [0], '  ': [MAX_ABSTRACT_POSITION + 1] })).toBe('a');
    });

    test('an absurd position aborts the whole abstract', () => {
        expect(reconstructAbstract({ a: [0], b: [Number.MAX_SAFE_INTEGER] })).toBeNull();
    });

    test('the guard applies to the largest surviving position only', () => {
        // The out-of-range value is also invalid-free, so it survives filtering and must trip the guard.
        expect(reconstructAbstract({ a: [0, MAX_ABSTRACT_POSITION + 5] })).toBeNull();
    });

    test('an out-of-range position that is skipped as invalid does not trip the guard', () => {
        expect(reconstructAbstract({ a: [0], b: [-(MAX_ABSTRACT_POSITION + 1), 1] })).toBe('a b');
        expect(reconstructAbstract({ a: [0], b: [Number.POSITIVE_INFINITY, 1] })).toBe('a b');
    });

    test('a large but legal span joins the words without filling the gap', () => {
        expect(reconstructAbstract({ a: [0], b: [MAX_ABSTRACT_POSITION - 1] })).toBe('a b');
    });
});

describe('hostile objects do not throw and do not pollute prototype', () => {
    test('a JSON __proto__ key does not throw', () => {
        const index = JSON.parse('{"__proto__":[0],"a":[1]}') as Record<string, number[]>;
        expect(() => reconstructAbstract(index)).not.toThrow();
        expect((Object.prototype as unknown as Record<string, unknown>).a).toBeUndefined();
    });

    test('a null-prototype index does not throw', () => {
        const index = Object.assign(Object.create(null) as Record<string, number[]>, { a: [0] });
        expect(() => reconstructAbstract(index)).not.toThrow();
    });

    test('a getter that throws is not a crash for the caller', () => {
        const index = {} as Record<string, number[]>;
        Object.defineProperty(index, 'boom', {
            enumerable: true,
            get() {
                throw new Error('hostile getter');
            },
        });
        expect(() => reconstructAbstract(index)).not.toThrow();
    });
});

describe('purity — the raw index is left untouched', () => {
    test('the input object is not mutated', () => {
        const index = { the: [0, 2], cat: [1], sat: [3] };
        const before = stableJson(index);
        reconstructAbstract(index);
        expect(stableJson(index)).toBe(before);
    });

    test('the position arrays are not sorted in place', () => {
        const positions = [3, 1, 2, 0];
        reconstructAbstract({ a: positions });
        expect(positions).toEqual([3, 1, 2, 0]);
    });

    test('called twice, it returns the same string', () => {
        const index = { a: [0], b: [1] };
        expect(reconstructAbstract(index)).toBe(reconstructAbstract(index));
    });
});

describe('the fixtures reconstruct sensibly', () => {
    test('the article fixture has a null index → null abstract', async () => {
        const work = await loadWork('work-article');
        expect(work.abstract_inverted_index).toBeNull();
        expect(reconstructAbstract(work.abstract_inverted_index)).toBeNull();
    });

    test('the open-access fixture reconstructs its 56-token index', async () => {
        const work = await loadWork('work-open-access');
        const out = reconstructAbstract(work.abstract_inverted_index) as string;
        expect(typeof out).toBe('string');
        expect(out).toHaveLength(479);
        expect(out.split(' ')).toHaveLength(76);
        expect(out.startsWith('BACKGROUND: This made-up abstract belongs to a test fixture')).toBe(true);
        expect(out.endsWith('should motivate nobody to cite the made-up data.')).toBe(true);
    });

    test('the legacy fixture reconstructs', async () => {
        const work = await loadWork('work-legacy');
        const out = reconstructAbstract(work.abstract_inverted_index) as string;
        expect(out).toHaveLength(318);
        expect(out.split(' ')).toHaveLength(56);
        expect(out.startsWith('This made-up abstract presents a simple model')).toBe(true);
        expect(out.endsWith('the criteria for a fixture to pass are given.')).toBe(true);
    });

    test('the preprint fixture reconstructs', async () => {
        const work = await loadWork('work-preprint');
        const out = reconstructAbstract(work.abstract_inverted_index) as string;
        expect(out).toHaveLength(463);
        expect(out.split(' ')).toHaveLength(69);
        expect(out.startsWith('Inspired by nothing in particular, we propose Made-Up Networks')).toBe(true);
        expect(out.endsWith('test fixtures which rely heavily on OMUNs.')).toBe(true);
    });

    test('no reconstructed fixture abstract has doubled or edge whitespace', async () => {
        for (const name of ['work-open-access', 'work-legacy', 'work-preprint'] as const) {
            const work = await loadWork(name);
            const out = reconstructAbstract(work.abstract_inverted_index) as string;
            expect(out, name).not.toContain('  ');
            expect(out, name).toBe(out.trim());
            expect(out, name).not.toContain('\n');
        }
    });

    test('reconstruction does not mutate the fixture payload', async () => {
        const work = await loadWork('work-open-access');
        const before = stableJson(work.abstract_inverted_index);
        reconstructAbstract(work.abstract_inverted_index);
        expect(stableJson(work.abstract_inverted_index)).toBe(before);
    });
});
