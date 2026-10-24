import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk, chunkByParams } from '../../src/server/wow/d1.ts';

const row = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, i]));

test('chunkByParams keeps every statement within 100 bound values', () => {
  const sizes = chunkByParams(Array.from({ length: 25 }, () => row(5))).map((c) => c.length);
  assert.deepEqual(sizes, [20, 5]);
  assert.deepEqual(
    chunkByParams(Array.from({ length: 12 }, () => row(10))).map((c) => c.length),
    [10, 2],
  );
});

test('undefined values are not bound, null values are', () => {
  const sparse = { a: 1, b: undefined, c: null };
  assert.deepEqual(
    chunkByParams(Array.from({ length: 60 }, () => sparse)).map((c) => c.length),
    [50, 10],
  );
});

test('empty input gives no chunks; chunk splits by count', () => {
  assert.deepEqual(chunkByParams([]), []);
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});
