/**
 * The roster. Everyone sees the leadership tree (the org chart); members who can
 * view the full roster (roster.view) get a toggle to a sortable list of every
 * member, by name or by rank. This is the public face of the roster — the tree
 * shows to members who can't see the full list.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MorphIcon } from 'morphicons/react';
import { ChevronUp, ChevronDown } from 'lucide';
import { api } from '../lib/api';
import MorphingSegments from '../components/MorphingSegments';
import { useSession } from '../lib/session';
import { memberName } from '../../shared/names';
import { memberAvatar } from '../../shared/avatar';
import OrgChartView, { type ChartMember } from '../components/OrgChartView';
import { sanitizeOrgChart, EMPTY_ORG_CHART, type OrgChart } from '../../shared/orgchart';

interface Member {
  id: number;
  discordId: string;
  username: string;
  globalName: string | null;
  displayName: string | null;
  avatar: string | null;
  profileImageUrl: string | null;
  status: string;
  joinedAt: number;
  rankName: string | null;
}

type SortField = 'rank' | 'name';
type SortDir = 'asc' | 'desc';
const PAGE_SIZE = 50;

export default function Roster() {
  const { can } = useSession();
  const canFullList = can('roster.view');

  // Members who can see the full roster land on it by default, and we remember
  // the last view they picked (sessionStorage) so returning from a member's
  // profile reopens the same view instead of snapping back to the leadership
  // chart. A viewer without roster.view only ever sees the tree.
  const [stored, setStored] = useState<'tree' | 'list' | null>(() => {
    try {
      const v = sessionStorage.getItem('ct-roster-view');
      if (v === 'tree' || v === 'list') return v;
    } catch {
      /* private mode — the choice just won't persist */
    }
    return null;
  });
  const view: 'tree' | 'list' = canFullList ? (stored ?? 'list') : 'tree';
  const setView = (v: 'tree' | 'list') => {
    setStored(v);
    try {
      sessionStorage.setItem('ct-roster-view', v);
    } catch {
      /* private mode */
    }
  };

  return (
    <section className="panel">
      <header className="panel-head roster-head">
        <h2>Roster</h2>
        {canFullList && (
          <MorphingSegments
            ariaLabel="Roster view"
            value={view}
            onChange={setView}
            options={[
              { key: 'tree', label: 'Leadership' },
              { key: 'list', label: 'All members' },
            ]}
          />
        )}
      </header>

      {view === 'tree' ? <LeadershipTree canOpenProfiles={canFullList} /> : <MemberList />}
    </section>
  );
}

function LeadershipTree({ canOpenProfiles }: { canOpenProfiles: boolean }) {
  const [data, setData] = useState<{ chart: OrgChart; members: ChartMember[] } | null>(null);

  useEffect(() => {
    api
      .get<{ chart: OrgChart; members: ChartMember[] }>('/orgchart')
      .then((d) => setData({ chart: sanitizeOrgChart(d.chart), members: d.members }))
      .catch(() => setData({ chart: EMPTY_ORG_CHART, members: [] }));
  }, []);

  if (!data) return <div className="loading">Loading…</div>;
  return <OrgChartView chart={data.chart} members={data.members} linkMembers={canOpenProfiles} />;
}

function MemberList() {
  const [members, setMembers] = useState<Member[]>([]);
  const [total, setTotal] = useState(0);
  const [sort, setSort] = useState<SortField>('rank');
  const [dir, setDir] = useState<SortDir>('desc');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadPage = useCallback(
    async (offset: number, sortField: SortField, sortDir: SortDir) => {
      const { members: page, total } = await api.get<{ members: Member[]; total: number }>(
        `/members?limit=${PAGE_SIZE}&offset=${offset}&sort=${sortField}&dir=${sortDir}`,
      );
      setTotal(total);
      setMembers((prev) => (offset === 0 ? page : [...prev, ...page]));
    },
    [],
  );

  useEffect(() => {
    setLoading(true);
    loadPage(0, sort, dir).finally(() => setLoading(false));
  }, [sort, dir, loadPage]);

  function sortBy(field: SortField) {
    if (field === sort) {
      setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(field);
      setDir(field === 'rank' ? 'desc' : 'asc');
    }
  }

  const arrow = (field: SortField) =>
    sort === field ? <MorphIcon icon={dir === 'asc' ? ChevronUp : ChevronDown} size={13} aria-hidden /> : null;
  const hasMore = members.length < total;

  return (
    <>
      <div className="roster-sort">
        <span className="muted small">Sort:</span>
        <button type="button" className={sort === 'name' ? 'seg active' : 'seg'} onClick={() => sortBy('name')}>
          Name {arrow('name')}
        </button>
        <button type="button" className={sort === 'rank' ? 'seg active' : 'seg'} onClick={() => sortBy('rank')}>
          Rank {arrow('rank')}
        </button>
        <span className="muted small roster-count">
          {hasMore ? `${members.length} of ${total}` : total} member{total === 1 ? '' : 's'}
        </span>
      </div>

      {loading ? (
        <div className="loading">Loading roster…</div>
      ) : (
        <>
          <ul className="roster">
            {members.map((m) => (
              <li key={m.id}>
                <Link to={`/members/${m.id}`} className="roster-link">
                  <img className="avatar" src={memberAvatar(m, 64)} alt="" width={40} height={40} loading="lazy" />
                  <div>
                    <div className="name">{memberName(m)}</div>
                    <div className="muted small">
                      {m.rankName ?? 'Unranked'} · joined {new Date(m.joinedAt * 1000).toLocaleDateString()}
                    </div>
                  </div>
                  {m.status !== 'active' && <span className="status-chip">{m.status}</span>}
                </Link>
              </li>
            ))}
          </ul>

          {hasMore && (
            <div className="roster-more">
              <button
                onClick={() => {
                  setLoadingMore(true);
                  loadPage(members.length, sort, dir).finally(() => setLoadingMore(false));
                }}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading…' : `Load ${Math.min(PAGE_SIZE, total - members.length)} more`}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
