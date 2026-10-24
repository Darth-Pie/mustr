/**
 * World of Warcraft characters on a member's profile: a card per followed
 * character and, for the selected one, its journey — every level, notable item,
 * guild change and badge mustr saw, grouped by month in the viewer's time zone.
 *
 * The member themselves also get Link Battle.net / Choose characters / Unlink.
 * Linking is a full-page round trip through Blizzard, which comes back here with
 * ?wow=choose (open the chooser) or ?wow=error&reason=… (say what went wrong).
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAction, Alerts } from '../lib/action';
import { aroundPhrase, groupJourney } from '../lib/wowJourney';
import {
  BADGES,
  CLASS_COLORS,
  FALLBACK_CLASS_COLOR,
  QUALITY_COLORS,
  type CharacterCard,
  type MemberWowData,
  type TimelineEntry,
} from '../../shared/wow';

const LINK_ERRORS: Record<string, string> = {
  denied: 'Battle.net sign-in was cancelled.',
  state: 'That sign-in link expired. Try again.',
  conflict: 'That Battle.net account is already linked to another member.',
  none: 'No World of Warcraft: Forever characters found in this region on that account. Log in once with the character, then try again.',
  blizzard: "Blizzard didn't respond. Try again in a few minutes.",
};

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const slotName = (slot: string | null) =>
  slot ? slot.charAt(0) + slot.slice(1).toLowerCase().replace(/_/g, ' ') : '';

const classStyle = (classId: number) =>
  ({ '--class-color': CLASS_COLORS[classId] ?? FALLBACK_CLASS_COLOR }) as CSSProperties;

function EntryLine({ e, trackedAt }: { e: TimelineEntry; trackedAt: number | null }) {
  switch (e.kind) {
    case 'tracking_started':
      return <span>Started tracking at level {e.level}</span>;
    case 'item':
      return (
        <span>
          {e.tag && <span className={`wow-tag wow-tag-${e.tag}`}>{e.tag === 'first_epic' ? 'First epic' : 'First blue'}</span>}
          Equipped{' '}
          <span className="wow-item" style={{ color: e.itemQuality ? QUALITY_COLORS[e.itemQuality] : undefined }}>
            {e.itemName}
          </span>
          <span className="muted small">
            {' '}
            · {slotName(e.slot)}
            {e.itemLevel !== null && ` · item level ${e.itemLevel}`}
          </span>
        </span>
      );
    case 'guild_join':
      return <span>Joined &lt;{e.guildName}&gt;</span>;
    case 'guild_leave':
      return <span>Left &lt;{e.guildName}&gt;</span>;
    case 'badge': {
      const b = e.badgeKey ? BADGES[e.badgeKey] : null;
      return (
        <span>
          Earned <strong>{b?.name ?? e.badgeKey}</strong>
          <span className="muted small">
            {' '}
            · {e.seenAt === trackedAt ? 'already had it when tracking started' : b?.description}
          </span>
        </span>
      );
    }
    default:
      return null;
  }
}

function Journey({ entries }: { entries: TimelineEntry[] }) {
  const trackedAt = entries.find((e) => e.kind === 'tracking_started')?.seenAt ?? null;
  const months = groupJourney(entries, timeZone);
  if (!months.length) return <p className="muted small">Nothing yet. The first check runs within a few minutes.</p>;
  return (
    <div className="wow-journey">
      {months.map((m) => (
        <section key={m.key}>
          <h4 className="wow-journey-month">{m.label}</h4>
          <ol className="wow-journey-list">
            {m.items.map((it, i) =>
              it.kind === 'levels' ? (
                <li key={i} className={it.milestone ? 'wow-journey-item is-milestone' : 'wow-journey-item'}>
                  <span className="wow-level-dot">{it.to}</span>
                  <span>
                    {it.from === it.to ? `Reached level ${it.to}` : `Levels ${it.from}–${it.to}`}
                    <span className="muted small"> · {aroundPhrase(it.seenAt, it.sinceAt, timeZone)}</span>
                  </span>
                </li>
              ) : (
                <li key={i} className={`wow-journey-item wow-journey-${it.entry.kind}`}>
                  <span className="wow-journey-dot" aria-hidden />
                  <span>
                    <EntryLine e={it.entry} trackedAt={trackedAt} />
                    <span className="muted small"> · {aroundPhrase(it.entry.seenAt, it.entry.sinceAt, timeZone)}</span>
                  </span>
                </li>
              ),
            )}
          </ol>
        </section>
      ))}
    </div>
  );
}

function Card({ c, selected, onSelect }: { c: CharacterCard; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      className={selected ? 'wow-card is-selected' : 'wow-card'}
      style={classStyle(c.classId)}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="wow-card-name">
        {c.name}
        {c.isMain && <span className="wow-main">Main</span>}
      </span>
      <span className="small">
        Level {c.level} {c.className}
        {c.itemLevel !== null && ` · ilvl ${c.itemLevel}`}
      </span>
      <span className="muted small">
        {c.guildName ? `<${c.guildName}> · ` : ''}
        {c.realmName}
      </span>
      {c.lastLoginAt !== null && <span className="muted small">online {aroundPhrase(c.lastLoginAt, null, timeZone)}</span>}
    </button>
  );
}

export default function WowCharacters({ userId, isSelf }: { userId: number; isSelf: boolean }) {
  const [data, setData] = useState<MemberWowData | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [follow, setFollow] = useState<Set<number>>(new Set());
  const [main, setMain] = useState<number | null>(null);
  const [params, setParams] = useSearchParams();
  const { run, busy, error, notice, warning, setError } = useAction();

  const load = useCallback(
    () =>
      api.get<MemberWowData>(`/wow/members/${userId}`).then((d) => {
        setData(d);
        setSelected((cur) => (cur !== null && d.characters.some((c) => c.id === cur) ? cur : (d.characters[0]?.id ?? null)));
        return d;
      }),
    [userId],
  );

  const openChooser = (d: MemberWowData) => {
    const followed = d.candidates.filter((c) => c.followed);
    const initial = followed.length ? followed : d.candidates.slice(0, 1);
    setFollow(new Set(initial.map((c) => c.id)));
    setMain(d.candidates.find((c) => c.isMain)?.id ?? initial[0]?.id ?? null);
    setChoosing(true);
  };

  useEffect(() => {
    const flag = params.get('wow');
    const reason = params.get('reason');
    void load()
      .then((d) => {
        if (isSelf && flag === 'choose') openChooser(d);
      })
      .catch(() => setData(null));
    if (isSelf && flag === 'error') setError(LINK_ERRORS[reason ?? ''] ?? LINK_ERRORS.blizzard!);
    if (flag) {
      params.delete('wow');
      params.delete('reason');
      setParams(params, { replace: true });
    }
    // Read the round-trip flag once per member page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  if (!data) return null;
  if (!isSelf && !data.characters.length) return null;

  const saveChoice = () =>
    run(async () => {
      await api.post('/wow/characters/follow', { follow: [...follow], main });
      await load();
      setChoosing(false);
      return 'Saved. New characters appear after the next check, within a few minutes.';
    });

  const unlink = () => {
    if (!window.confirm('Unlink Battle.net? Your characters and their history are deleted from this site.')) return;
    void run(async () => {
      await api.del('/wow/link');
      await load();
      return 'Battle.net unlinked.';
    });
  };

  const current = data.characters.find((c) => c.id === selected) ?? null;

  return (
    <section className="block wow-section">
      <h3>World of Warcraft</h3>
      <Alerts error={error} warning={warning} notice={notice} />

      {data.characters.length > 0 && (
        <div className="wow-cards">
          {data.characters.map((c) => (
            <Card key={c.id} c={c} selected={c.id === selected} onSelect={() => setSelected(c.id)} />
          ))}
        </div>
      )}

      {isSelf && (
        <div className="wow-actions">
          <a className="wow-link-btn small" href="/api/wow/link/start">
            {data.linked ? 'Link Battle.net again' : 'Link Battle.net'}
          </a>
          {data.candidates.length > 0 && (
            <button type="button" className="small" disabled={busy} onClick={() => openChooser(data)}>
              Choose characters
            </button>
          )}
          {data.linked && (
            <button type="button" className="small danger" disabled={busy} onClick={unlink}>
              Unlink
            </button>
          )}
          {data.battletag && <span className="muted small">Linked as {data.battletag}</span>}
        </div>
      )}

      {isSelf && choosing && (
        <div className="wow-chooser">
          <p className="small">Tick the characters to follow and pick your main.</p>
          <ul>
            {data.candidates.map((c) => (
              <li key={c.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={follow.has(c.id)}
                    onChange={(e) => {
                      const next = new Set(follow);
                      if (e.target.checked) next.add(c.id);
                      else next.delete(c.id);
                      setFollow(next);
                    }}
                  />{' '}
                  {c.name} <span className="muted small">· level {c.level} {c.className} · {c.realmName}</span>
                </label>
                <label className="small">
                  <input
                    type="radio"
                    name="wow-main"
                    checked={main === c.id}
                    disabled={!follow.has(c.id)}
                    onChange={() => setMain(c.id)}
                  />{' '}
                  Main
                </label>
              </li>
            ))}
          </ul>
          <div className="wow-actions">
            <button type="button" className="small primary" disabled={busy} onClick={() => void saveChoice()}>
              Save
            </button>
            <button type="button" className="small" disabled={busy} onClick={() => setChoosing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {current && <Journey entries={data.timeline[current.id] ?? []} />}

      {isSelf && <p className="muted small">History starts when you link Battle.net.</p>}
      <p className="muted small wow-disclaimer">
        Not affiliated with or endorsed by Blizzard Entertainment. World of Warcraft and Blizzard Entertainment are
        trademarks or registered trademarks of Blizzard Entertainment, Inc.
      </p>
    </section>
  );
}
