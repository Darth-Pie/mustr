/**
 * The leadership-chart designer (admin, ranks.manage).
 *
 * Add members from a threshold-filtered picker, drag their boxes freely, and draw
 * report-to connectors by clicking a manager then a report in Connect mode. The
 * rank threshold controls who is eligible and who shows on the public tree. State
 * is the portable OrgChart JSON from shared/orgchart.ts, saved to /api/orgchart.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import { MorphIcon } from 'morphicons/react';
import { X } from 'lucide';
import { api } from '../lib/api';
import { memberName } from '../../shared/names';
import { sanitizeOrgChart, type OrgChart } from '../../shared/orgchart';
import { BOX_W, BOX_H, chartSize, edgePath, type ChartMember } from '../components/OrgChartView';

interface RankOpt {
  id: number;
  name: string;
  sortOrder: number;
}

const MAX_COORD = 8000;
const clamp = (v: number) => Math.min(MAX_COORD, Math.max(0, Math.round(v)));

export default function OrgChartDesigner() {
  const [chart, setChart] = useState<OrgChart | null>(null);
  const [members, setMembers] = useState<ChartMember[]>([]);
  const [ranks, setRanks] = useState<RankOpt[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [connectMode, setConnectMode] = useState(false);
  const [connectFrom, setConnectFrom] = useState<number | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .get<{ chart: OrgChart; members: ChartMember[]; ranks: RankOpt[] }>('/orgchart/designer')
      .then((d) => {
        setChart(sanitizeOrgChart(d.chart));
        setMembers(d.members);
        setRanks(d.ranks);
      })
      .catch(() => setMessage('Could not load the chart.'));
  }, []);

  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  function edit(fn: (c: OrgChart) => OrgChart) {
    setChart((c) => (c ? fn(c) : c));
    setDirty(true);
    setMessage(null);
  }

  const meetsThreshold = (m: ChartMember | undefined, min: number) =>
    !!m && (min <= 0 || (m.rankSortOrder != null && m.rankSortOrder >= min));

  /* --- drag --- */
  function startDrag(e: RPointerEvent, memberId: number) {
    if (connectMode || !chart || !canvasRef.current) return;
    e.preventDefault();
    const rect = canvasRef.current.getBoundingClientRect();
    const node = chart.nodes.find((n) => n.memberId === memberId);
    if (!node) return;
    const offX = e.clientX - rect.left - node.x + canvasRef.current.scrollLeft;
    const offY = e.clientY - rect.top - node.y + canvasRef.current.scrollTop;
    const move = (ev: PointerEvent) => {
      const nx = clamp(ev.clientX - rect.left - offX + (canvasRef.current?.scrollLeft ?? 0));
      const ny = clamp(ev.clientY - rect.top - offY + (canvasRef.current?.scrollTop ?? 0));
      setChart((c) => (c ? { ...c, nodes: c.nodes.map((n) => (n.memberId === memberId ? { ...n, x: nx, y: ny } : n)) } : c));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDirty(true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /* --- connect --- */
  function onBoxClick(memberId: number) {
    if (!connectMode) return;
    if (connectFrom == null) {
      setConnectFrom(memberId);
      return;
    }
    if (connectFrom === memberId) {
      setConnectFrom(null);
      return;
    }
    const from = connectFrom;
    edit((c) =>
      c.edges.some((e) => e.from === from && e.to === memberId)
        ? c
        : { ...c, edges: [...c.edges, { from, to: memberId }] },
    );
    setConnectFrom(null);
  }

  /* --- add / remove --- */
  function addMember(memberId: number) {
    edit((c) => {
      // Cascade new boxes so they don't stack exactly.
      const n = c.nodes.length;
      return { ...c, nodes: [...c.nodes, { memberId, x: 40 + (n % 5) * 40, y: 40 + (n % 5) * 30 }] };
    });
  }
  function removeNode(memberId: number) {
    edit((c) => ({
      ...c,
      nodes: c.nodes.filter((n) => n.memberId !== memberId),
      edges: c.edges.filter((e) => e.from !== memberId && e.to !== memberId),
    }));
  }
  function removeEdge(from: number, to: number) {
    edit((c) => ({ ...c, edges: c.edges.filter((e) => !(e.from === from && e.to === to)) }));
  }

  async function save() {
    if (!chart) return;
    setSaving(true);
    setMessage(null);
    try {
      await api.put('/orgchart', { chart });
      setDirty(false);
      setMessage('Saved. The leadership chart is live.');
    } catch {
      setMessage('Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  if (!chart) return <div className="loading">Loading…</div>;

  const placed = new Set(chart.nodes.map((n) => n.memberId));
  const addable = members
    .filter((m) => !placed.has(m.id) && meetsThreshold(m, chart.minRankSortOrder))
    .sort((a, b) => (b.rankSortOrder ?? -1) - (a.rankSortOrder ?? -1) || memberName(a).localeCompare(memberName(b)));

  const nodes = chart.nodes;
  const nodeById = new Map(nodes.map((n) => [n.memberId, n]));
  const { width, height } = chartSize(nodes);

  return (
    <section className="panel org-designer">
      <header className="panel-head org-designer-head">
        <div>
          <h2>Org Chart</h2>
          <p className="muted">
            Add leaders, drag them into place, and connect a manager to their reports. This is the
            public leadership tree.
          </p>
        </div>
        <button type="button" className="primary" onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>
      </header>

      {message && <div className="notice">{message}</div>}

      <div className="org-toolbar">
        <label className="inline-field">
          Show ranks
          <select
            value={chart.minRankSortOrder}
            onChange={(e) => edit((c) => ({ ...c, minRankSortOrder: Number(e.target.value) }))}
          >
            <option value={0}>Everyone</option>
            {[...ranks].sort((a, b) => b.sortOrder - a.sortOrder).map((r) => (
              <option key={r.id} value={r.sortOrder}>
                {r.name} &amp; above
              </option>
            ))}
          </select>
        </label>

        <label className="inline-field">
          Add member
          <select value="" onChange={(e) => e.target.value && addMember(Number(e.target.value))}>
            <option value="">{addable.length ? 'Choose…' : 'No eligible members'}</option>
            {addable.map((m) => (
              <option key={m.id} value={m.id}>
                {memberName(m)}
                {m.rankName ? ` — ${m.rankName}` : ''}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className={connectMode ? 'primary' : 'ghost'}
          onClick={() => {
            setConnectMode((v) => !v);
            setConnectFrom(null);
          }}
        >
          {connectMode ? 'Done connecting' : 'Connect reports'}
        </button>
        {connectMode && (
          <span className="muted small">
            {connectFrom == null
              ? 'Click a manager, then their report. Keep going to add more — click “Done connecting” when finished.'
              : 'Now click the report. (Click the same box again to cancel.)'}
          </span>
        )}
      </div>

      <div className={connectMode ? 'org-scroll org-editing org-connect' : 'org-scroll org-editing'}>
        <div className="org-canvas" style={{ width, height }} ref={canvasRef}>
          <svg className="org-edges" width={width} height={height}>
            {chart.edges.map((e) => {
              const a = nodeById.get(e.from);
              const b = nodeById.get(e.to);
              if (!a || !b) return null;
              return (
                <path
                  key={`${e.from}->${e.to}`}
                  className="org-edge org-edge-editable"
                  d={edgePath(a.x + BOX_W / 2, a.y + BOX_H, b.x + BOX_W / 2, b.y)}
                  onClick={() => removeEdge(e.from, e.to)}
                >
                  <title>Click to remove this connection</title>
                </path>
              );
            })}
          </svg>

          {nodes.map((n) => {
            const m = byId.get(n.memberId);
            const hidden = !meetsThreshold(m, chart.minRankSortOrder);
            const cls = [
              'org-box org-box-editable',
              connectFrom === n.memberId ? 'connecting' : '',
              hidden ? 'org-box-hidden' : '',
            ].join(' ');
            const style: CSSProperties = { left: n.x, top: n.y, width: BOX_W, height: BOX_H };
            return (
              <div
                key={n.memberId}
                className={cls}
                style={style}
                onPointerDown={(e) => startDrag(e, n.memberId)}
                onClick={() => onBoxClick(n.memberId)}
                title={hidden ? 'Below the rank threshold — hidden on the public chart' : undefined}
              >
                {m ? (
                  <>
                    <div className="org-box-text">
                      <span className="org-box-name">{memberName(m)}</span>
                      {m.rankName && <span className="org-box-rank">{m.rankName}</span>}
                    </div>
                    {!connectMode && (
                      <button
                        type="button"
                        className="org-box-remove"
                        title="Remove"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeNode(n.memberId);
                        }}
                      >
                        <MorphIcon icon={X} size={10} aria-hidden />
                      </button>
                    )}
                  </>
                ) : (
                  <span className="org-box-name muted">Unknown member</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
