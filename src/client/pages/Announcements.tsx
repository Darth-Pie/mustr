/**
 * Discord announcements admin (Discord Bot → Bot Settings).
 *
 * Choose the channel the bot posts to, toggle which events announce, and
 * customize how the embeds look: an accent colour, a footer line, a shared
 * banner image, and per-event title/body/image overrides (with {placeholders}).
 * "Send test" confirms the bot can actually reach the channel.
 */

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAction, Alerts } from '../lib/action';
import Switch from '../components/Switch';
import ColorPicker from '../components/ColorPicker';
import { useModules } from '../lib/modules';

type EventKey = 'medalAward' | 'warRecordAward' | 'promotion' | 'wowLevel' | 'wowFirst';

interface Template {
  title?: string;
  text?: string;
  imageUrl?: string;
}
interface Config {
  channelId: string | null;
  events: Record<EventKey, boolean>;
  accentColor: string | null;
  footer: string | null;
  imageUrl: string | null;
  templates: Partial<Record<EventKey, Template>>;
}
interface Channel {
  id: string;
  name: string;
  position: number;
}

const EVENTS: { key: EventKey; label: string; hint: string; placeholders: string[]; module?: 'wow' }[] = [
  { key: 'medalAward', label: 'Medal awarded', hint: 'Posts when a member is awarded a medal.', placeholders: ['{member}', '{medal}', '{citation}'] },
  { key: 'warRecordAward', label: 'War record awarded', hint: 'Posts when a member earns a war record.', placeholders: ['{member}', '{record}', '{game}', '{citation}'] },
  { key: 'promotion', label: 'Promotion', hint: 'Posts when a member is promoted (website or /promote).', placeholders: ['{member}', '{rank}', '{by}'] },
  {
    key: 'wowLevel',
    label: 'WoW level milestone',
    hint: 'Posts when a character reaches a tenth level or level 60 (World of Warcraft module).',
    placeholders: ['{member}', '{character}', '{level}', '{class}'],
    module: 'wow',
  },
  {
    key: 'wowFirst',
    label: 'WoW guild first',
    hint: "Posts when a character is the guild's first to reach a tenth level (World of Warcraft module).",
    placeholders: ['{member}', '{character}', '{level}'],
    module: 'wow',
  },
];

const DEFAULT_ACCENT = '#5865f2';

export default function Announcements() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const modules = useModules();
  const [saved, setSaved] = useState('');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelWarning, setChannelWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { run, busy, error, notice, warning } = useAction();

  useEffect(() => {
    Promise.all([
      api.get<{ announcements: Config }>('/settings/announcements').then(({ announcements }) => {
        setCfg(announcements);
        setSaved(JSON.stringify(announcements));
      }),
      api
        .get<{ channels: Channel[]; warning?: string }>('/settings/discord-channels')
        .then(({ channels, warning }) => {
          setChannels(channels);
          setChannelWarning(warning ?? null);
        })
        .catch(() => setChannelWarning('Could not reach Discord to load channels.')),
    ]).finally(() => setLoading(false));
  }, []);

  const dirty = !!cfg && JSON.stringify(cfg) !== saved;
  const patch = (p: Partial<Config>) => setCfg((c) => (c ? { ...c, ...p } : c));
  const toggleEvent = (key: EventKey) =>
    setCfg((c) => (c ? { ...c, events: { ...c.events, [key]: !c.events[key] } } : c));
  const setTemplate = (key: EventKey, tp: Partial<Template>) =>
    setCfg((c) => (c ? { ...c, templates: { ...c.templates, [key]: { ...c.templates[key], ...tp } } } : c));

  const save = () =>
    run(async () => {
      if (!cfg) return '';
      const { announcements } = await api.put<{ announcements: Config }>('/settings/announcements', cfg);
      setCfg(announcements);
      setSaved(JSON.stringify(announcements));
      return 'Saved.';
    });

  const test = () =>
    run(async () => {
      if (!cfg?.channelId) return { warning: 'Choose a channel first.' };
      await api.post('/settings/announcements/test', { channelId: cfg.channelId });
      return 'Test message sent — check the channel.';
    });

  if (loading || !cfg) return <div className="loading">Loading…</div>;

  return (
    <section className="panel announce-admin">
      <header className="panel-head">
        <h2>Bot Settings</h2>
        <p className="muted">Have the bot post to Discord when things happen on the site, and style how those posts look.</p>
      </header>

      <Alerts error={error} warning={warning} notice={notice} />

      <label>
        Channel
        {channels.length > 0 ? (
          <select value={cfg.channelId ?? ''} onChange={(e) => patch({ channelId: e.target.value || null })} disabled={busy}>
            <option value="">— None (announcements off) —</option>
            {channels.map((ch) => (
              <option key={ch.id} value={ch.id}>
                #{ch.name}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={cfg.channelId ?? ''}
            placeholder="Discord channel ID"
            onChange={(e) => patch({ channelId: e.target.value || null })}
            disabled={busy}
          />
        )}
      </label>
      {channelWarning && <p className="muted small warn">{channelWarning}</p>}

      {/* Shared appearance across every announcement. */}
      <fieldset className="announce-appearance">
        <legend>Appearance</legend>

        <div className="announce-field">
          <div className="check">
            <Switch
              checked={cfg.accentColor != null}
              onChange={(v) => patch({ accentColor: v ? DEFAULT_ACCENT : null })}
              disabled={busy}
              label="Use a custom accent colour"
              hideState
            />
            <span>
              Custom accent colour
              <span className="muted small"> — the stripe down the side of each embed</span>
            </span>
          </div>
          {cfg.accentColor != null && (
            <ColorPicker value={cfg.accentColor} onChange={(hex) => patch({ accentColor: hex })} aria-label="Accent colour" />
          )}
        </div>

        <label className="announce-field-col">
          Footer line
          <input
            type="text"
            value={cfg.footer ?? ''}
            placeholder="e.g. 919th Gaming — since 2003"
            maxLength={150}
            disabled={busy}
            onChange={(e) => patch({ footer: e.target.value || null })}
          />
          <span className="muted small">Shown small at the bottom of every announcement.</span>
        </label>

        <div className="announce-field-col">
          <span>Shared banner image</span>
          <ImagePicker
            value={cfg.imageUrl}
            disabled={busy}
            onChange={(url) => patch({ imageUrl: url })}
            hint="A wide image shown across every announcement (a per-event image below overrides it)."
          />
        </div>
      </fieldset>

      {/* Per-event: on/off plus optional title/body/image overrides. */}
      <fieldset className="announce-events">
        <legend>Announce these events</legend>
        {EVENTS.filter((ev) => !ev.module || modules[ev.module]).map((ev) => {
          const tpl = cfg.templates[ev.key] ?? {};
          return (
            <div key={ev.key} className="announce-event-block">
              <div className="check announce-event">
                <Switch checked={cfg.events[ev.key]} onChange={() => toggleEvent(ev.key)} disabled={busy} label={ev.label} hideState />
                <span>
                  {ev.label}
                  <span className="muted small"> — {ev.hint}</span>
                </span>
              </div>

              <details className="announce-customize">
                <summary>Customize this announcement</summary>
                <div className="announce-customize-body">
                  <input
                    type="text"
                    value={tpl.title ?? ''}
                    placeholder="Custom title (blank = default)"
                    maxLength={200}
                    disabled={busy}
                    onChange={(e) => setTemplate(ev.key, { title: e.target.value })}
                  />
                  <textarea
                    rows={2}
                    value={tpl.text ?? ''}
                    placeholder="Custom message (blank = default)"
                    maxLength={600}
                    disabled={busy}
                    onChange={(e) => setTemplate(ev.key, { text: e.target.value })}
                  />
                  <span className="muted small">
                    Placeholders: <code>{ev.placeholders.join('  ')}</code>
                  </span>
                  <ImagePicker
                    value={tpl.imageUrl ?? null}
                    disabled={busy}
                    onChange={(url) => setTemplate(ev.key, { imageUrl: url ?? '' })}
                    hint="Overrides the shared banner for this event only."
                  />
                </div>
              </details>
            </div>
          );
        })}
        <p className="muted small">Nothing posts unless a channel is chosen above and the event is ticked.</p>
      </fieldset>

      <div className="news-editor-actions">
        <button className="primary" disabled={busy || !dirty} onClick={() => void save()}>
          Save
        </button>
        <button disabled={busy || !cfg.channelId} onClick={() => void test()} title="Post a test message to the chosen channel">
          Send test
        </button>
      </div>
    </section>
  );
}

/** Upload an image (to the branding media category) or paste a URL; clear to remove. */
function ImagePicker({
  value,
  disabled,
  onChange,
  hint,
}: {
  value: string | null;
  disabled?: boolean;
  onChange: (url: string | null) => void;
  hint?: string;
}) {
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="announce-image">
      {value && <img className="announce-image-preview" src={value} alt="" />}
      <div className="avatar-controls">
        <label className="upload-btn mini">
          {uploading ? 'Uploading…' : value ? 'Change image' : 'Upload image'}
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            disabled={disabled || uploading}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setErr(null);
              setUploading(true);
              try {
                const res = await api.upload<{ url: string }>('/media/branding', file);
                onChange(res.url);
              } catch (e2) {
                setErr(e2 instanceof Error ? e2.message : 'Upload failed.');
              } finally {
                setUploading(false);
              }
            }}
          />
        </label>
        {value && (
          <button type="button" className="mini" disabled={disabled || uploading} onClick={() => onChange(null)}>
            Remove
          </button>
        )}
      </div>
      {hint && <span className="muted small">{hint}</span>}
      {err && <p className="muted small module-image-err">{err}</p>}
    </div>
  );
}
