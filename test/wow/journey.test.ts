import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aroundPhrase, groupJourney } from '../../src/client/lib/wowJourney.ts';
import type { TimelineEntry } from '../../src/shared/wow.ts';

const at = (iso: string) => Date.parse(iso) / 1000;

const entry = (over: Partial<TimelineEntry>): TimelineEntry => ({
  kind: 'level',
  level: null,
  itemName: null,
  itemQuality: null,
  itemLevel: null,
  slot: null,
  tag: null,
  guildName: null,
  badgeKey: null,
  seenAt: at('2026-10-08T20:00Z'),
  sinceAt: at('2026-10-07T20:00Z'),
  ...over,
});

test('level rows from one check become one levels item', () => {
  // The API sends newest first: 41, 40, 39 from the same logout.
  const months = groupJourney([entry({ level: 41 }), entry({ level: 40 }), entry({ level: 39 })], 'UTC');
  assert.equal(months.length, 1);
  assert.deepEqual(months[0]!.items, [
    { kind: 'levels', from: 39, to: 41, milestone: true, seenAt: at('2026-10-08T20:00Z'), sinceAt: at('2026-10-07T20:00Z') },
  ]);
});

test('level rows from different checks stay separate', () => {
  const later = entry({ level: 41, seenAt: at('2026-10-09T20:00Z'), sinceAt: at('2026-10-08T20:00Z') });
  const months = groupJourney([later, entry({ level: 40 })], 'UTC');
  assert.deepEqual(
    months[0]!.items.map((i) => i.kind === 'levels' && [i.from, i.to, i.milestone]),
    [
      [41, 41, false],
      [40, 40, true],
    ],
  );
});

test('other entries keep their place between level items', () => {
  const badge = entry({ kind: 'badge', badgeKey: 'first_rare' });
  const months = groupJourney([entry({ level: 40 }), badge, entry({ level: 39 })], 'UTC');
  assert.deepEqual(
    months[0]!.items.map((i) => i.kind),
    ['levels', 'entry', 'levels'],
  );
});

test('months follow the viewer time zone', () => {
  const e = entry({ level: 30, seenAt: at('2026-11-01T02:00Z'), sinceAt: null });
  assert.equal(groupJourney([e], 'America/Los_Angeles')[0]!.key, '2026-10');
  assert.equal(groupJourney([e], 'America/Los_Angeles')[0]!.label, 'October 2026');
  assert.equal(groupJourney([e], 'UTC')[0]!.key, '2026-11');
});

test('aroundPhrase reads around one day or between two', () => {
  assert.equal(aroundPhrase(at('2026-10-08T20:00Z'), at('2026-10-08T09:00Z'), 'UTC'), 'around 8 October');
  assert.equal(aroundPhrase(at('2026-10-06T20:00Z'), at('2026-10-05T20:00Z'), 'UTC'), 'between 5 and 6 October');
  assert.equal(aroundPhrase(at('2026-11-01T10:00Z'), at('2026-10-31T10:00Z'), 'UTC'), 'between 31 October and 1 November');
  assert.equal(aroundPhrase(at('2026-10-08T20:00Z'), null, 'UTC'), 'around 8 October');
});
