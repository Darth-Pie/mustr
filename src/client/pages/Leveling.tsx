/**
 * The Leveling page — the World of Warcraft level race. Standings, two charts
 * (level over time, levels gained per day or week) and the guild's records:
 * firsts to each tenth level, the fastest ten levels, and the scenic route.
 *
 * Mains only by default; "Show alts" counts every followed character. Times are
 * Blizzard logouts, so everything is phrased as approximate. Chart.js arrives
 * with this page's chunk only (see lib/wowCharts.ts).
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, ApiError } from '../lib/api';
import { aroundPhrase } from '../lib/wowJourney';
import { bucketSeries } from '../lib/wowSeries';
import { DASHES, renderLevelCharts, type LineStyle } from '../lib/wowCharts';
import { CLASS_COLORS, FALLBACK_CLASS_COLOR, type RaceData } from '../../shared/wow';

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const classColor = (classId: number) => CLASS_COLORS[classId] ?? FALLBACK_CLASS_COLOR;

/** "3d 1h", "1w 3d", "5h" — the two largest units. */
function formatDuration(seconds: number): string {
  const w = Math.floor(seconds / 604800);
  const d = Math.floor((seconds % 604800) / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (w) return d ? `${w}w ${d}d` : `${w}w`;
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  return h ? `${h}h` : 'under an hour';
}

function Charts({ data, period }: { data: RaceData; period: 'day' | 'week' }) {
  const lineRef = useRef<HTMLCanvasElement>(null);
  const barRef = useRef<HTMLCanvasElement>(null);
  const charts = useRef<ReturnType<typeof renderLevelCharts> | null>(null);

  const styles = useMemo<LineStyle[]>(() => {
    const seen = new Map<number, number>();
    return data.characters.map((c) => {
      const n = seen.get(c.classId) ?? 0;
      seen.set(c.classId, n + 1);
      return { characterId: c.id, label: c.name, color: classColor(c.classId), dash: DASHES[n % DASHES.length]! };
    });
  }, [data]);

  const bucketed = useMemo(
    () => bucketSeries(data.series, period, timeZone, Math.floor(Date.now() / 1000)),
    [data, period],
  );

  useEffect(() => {
    if (!lineRef.current || !barRef.current) return;
    charts.current = renderLevelCharts(lineRef.current, barRef.current, bucketed, styles);
    return () => {
      charts.current?.destroy();
      charts.current = null;
    };
    // Rebuild only when the cast of characters changes; period changes update in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styles]);

  useEffect(() => {
    charts.current?.update(bucketed);
  }, [bucketed]);

  return (
    <div className="leveling-charts">
      <figure className="leveling-chart">
        <figcaption>Level over time</figcaption>
        <div className="leveling-canvas">
          <canvas ref={lineRef} aria-label="Each character's level over time" role="img" />
        </div>
      </figure>
      <figure className="leveling-chart">
        <figcaption>Levels gained per {period}</figcaption>
        <div className="leveling-canvas">
          <canvas ref={barRef} aria-label={`Levels gained per ${period}`} role="img" />
        </div>
      </figure>
    </div>
  );
}

export default function Leveling() {
  const [alts, setAlts] = useState(false);
  const [period, setPeriod] = useState<'day' | 'week'>('day');
  const [data, setData] = useState<RaceData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .get<RaceData>(`/wow/race?alts=${alts ? 1 : 0}`)
      .then((d) => live && (setData(d), setError(null)))
      .catch((e) => live && setError(e instanceof ApiError && e.status === 404 ? 'The Leveling page is switched off.' : 'Could not load the level race.'));
    return () => {
      live = false;
    };
  }, [alts]);

  const byId = useMemo(() => new Map((data?.characters ?? []).map((c) => [c.id, c])), [data]);

  if (error) return <div className="empty">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;

  const who = (id: number) => {
    const c = byId.get(id);
    if (!c) return null;
    return (
      <span className="leveling-who" style={{ '--class-color': classColor(c.classId) } as CSSProperties}>
        <span className="leveling-name">{c.name}</span> <span className="muted small">{c.memberName}</span>
      </span>
    );
  };

  const { summary, records } = data;
  return (
    <section className="panel leveling">
      <header className="panel-head">
        <h2>Leveling</h2>
        <p className="muted">
          {summary.members} member{summary.members === 1 ? '' : 's'} · average level {summary.avgLevel}
          {summary.avgItemLevel !== null && ` · average item level ${summary.avgItemLevel}`} · {summary.activeThisWeek}{' '}
          active this week
        </p>
      </header>

      {data.characters.length === 0 ? (
        <p className="empty">Nobody is in the race yet. Members join by linking Battle.net on their profile.</p>
      ) : (
        <>
          <div className="leveling-toggles">
            <label className="small">
              <input type="checkbox" checked={alts} onChange={(e) => setAlts(e.target.checked)} /> Show alts
            </label>
            <div className="leveling-period" role="group" aria-label="Chart period">
              {(['day', 'week'] as const).map((p) => (
                <button key={p} type="button" className="small" aria-pressed={period === p} onClick={() => setPeriod(p)}>
                  Per {p}
                </button>
              ))}
            </div>
          </div>

          <Charts data={data} period={period} />

          <div className="leveling-grid">
            <section>
              <h3>Standings</h3>
              <ol className="leveling-standings">
                {records.standings.map((s) => (
                  <li key={s.characterId}>
                    <span className="leveling-level">{s.level}</span>
                    {who(s.characterId)}
                  </li>
                ))}
              </ol>
            </section>

            <section>
              <h3>Firsts</h3>
              {records.firsts.length === 0 ? (
                <p className="muted small">No firsts yet.</p>
              ) : (
                <ul className="leveling-records">
                  {[...records.firsts].reverse().map((f) => (
                    <li key={f.level}>
                      <span className="leveling-level">{f.level}</span>
                      <span>
                        {f.characterIds.length > 1 ? `Shared first to level ${f.level}` : `First to level ${f.level}`}
                        <br />
                        {f.characterIds.map((id, i) => (
                          <span key={id}>
                            {i > 0 && ' & '}
                            {who(id)}
                          </span>
                        ))}
                        <span className="muted small"> · {aroundPhrase(f.at, null, timeZone)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <h3>Fastest ten levels</h3>
              {records.fastest.length === 0 ? (
                <p className="muted small">Nobody has climbed ten levels while tracked yet.</p>
              ) : (
                <ul className="leveling-records">
                  {records.fastest.map((b) => (
                    <li key={b.from}>
                      <span className="leveling-band">
                        {b.from}→{b.to}
                      </span>
                      <span>
                        {who(b.characterId)}
                        <span className="muted small"> · in {formatDuration(b.seconds)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {records.scenic && (
                <>
                  <h3>The scenic route</h3>
                  <ul className="leveling-records">
                    <li>
                      <span className="leveling-band">
                        {records.scenic.from}→{records.scenic.to}
                      </span>
                      <span>
                        {who(records.scenic.characterId)}
                        <span className="muted small">
                          {' '}
                          · in {formatDuration(records.scenic.seconds)}. Stopped to smell the flowers.
                        </span>
                      </span>
                    </li>
                  </ul>
                </>
              )}
            </section>
          </div>
        </>
      )}

      <p className="muted small">
        History starts when each member links Battle.net. Times are within a logout of the real moment.
      </p>
      <p className="muted small">
        Not affiliated with or endorsed by Blizzard Entertainment. World of Warcraft and Blizzard Entertainment are
        trademarks or registered trademarks of Blizzard Entertainment, Inc.
      </p>
    </section>
  );
}
