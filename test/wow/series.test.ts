import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketSeries } from '../../src/client/lib/wowSeries.ts';

const at = (iso: string) => Date.parse(iso) / 1000;

test('a level gained at 23:30 local lands on that local day', () => {
  const series = [
    {
      characterId: 1,
      points: [
        { t: at('2026-10-18T20:00Z'), level: 10 }, // 13:00 on the 18th in Los Angeles
        { t: at('2026-10-20T06:30Z'), level: 11 }, // 23:30 on the 19th in Los Angeles
      ],
    },
  ];
  const b = bucketSeries(series, 'day', 'America/Los_Angeles', at('2026-10-20T12:00Z'));
  assert.deepEqual(b.labels, ['18 Oct', '19 Oct', '20 Oct']);
  assert.deepEqual(b.lines[0]!.gained, [0, 1, 0]);
  assert.deepEqual(b.lines[0]!.levels, [10, 11, 11]);
  // The same moment in UTC is already the 20th.
  const utc = bucketSeries(series, 'day', 'UTC', at('2026-10-20T12:00Z'));
  assert.deepEqual(utc.lines[0]!.gained, [0, 0, 1]);
});

test('day buckets span the clock change on 1 November 2026 without a missing or doubled day', () => {
  const series = [
    {
      characterId: 1,
      points: [
        { t: at('2026-10-30T19:00Z'), level: 20 },
        { t: at('2026-11-03T20:00Z'), level: 24 },
      ],
    },
  ];
  const b = bucketSeries(series, 'day', 'America/Los_Angeles', at('2026-11-03T21:00Z'));
  assert.deepEqual(b.labels, ['30 Oct', '31 Oct', '1 Nov', '2 Nov', '3 Nov']);
  assert.deepEqual(b.lines[0]!.gained, [0, 0, 0, 0, 4]);
});

test('levels step forward and are null before the first point', () => {
  const series = [
    { characterId: 1, points: [{ t: at('2026-10-01T12:00Z'), level: 5 }, { t: at('2026-10-02T12:00Z'), level: 7 }] },
    { characterId: 2, points: [{ t: at('2026-10-03T12:00Z'), level: 9 }] },
  ];
  const b = bucketSeries(series, 'day', 'UTC', at('2026-10-04T12:00Z'));
  assert.deepEqual(b.lines[0]!.levels, [5, 7, 7, 7]);
  assert.deepEqual(b.lines[1]!.levels, [null, null, 9, 9]);
  assert.deepEqual(b.lines[0]!.gained, [0, 2, 0, 0]);
});

test('week buckets start on Monday and sum gained levels', () => {
  const series = [
    {
      characterId: 1,
      points: [
        { t: at('2026-10-12T12:00Z'), level: 10 }, // Monday
        { t: at('2026-10-14T12:00Z'), level: 12 },
        { t: at('2026-10-18T12:00Z'), level: 13 }, // Sunday
        { t: at('2026-10-19T12:00Z'), level: 15 }, // Monday
      ],
    },
  ];
  const b = bucketSeries(series, 'week', 'UTC', at('2026-10-20T12:00Z'));
  assert.deepEqual(b.labels, ['Wk of 12 Oct', 'Wk of 19 Oct']);
  assert.deepEqual(b.lines[0]!.gained, [3, 2]);
  assert.deepEqual(b.lines[0]!.levels, [13, 15]);
});

test('no points gives no buckets', () => {
  assert.deepEqual(bucketSeries([], 'day', 'UTC', at('2026-10-20T12:00Z')), { labels: [], lines: [] });
});
