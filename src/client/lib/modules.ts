/**
 * Which optional modules are enabled, so UI (e.g. the hangar on a profile, or
 * the Gallery nav link) can show/hide itself. Fetched once and cached
 * process-wide — the flags rarely change and every page would otherwise
 * re-request them.
 */

import { useEffect, useState } from 'react';
import { api } from './api';

export interface ModuleFlags {
  starcitizen: boolean;
  gallery: boolean;
  wow: boolean;
}

const DEFAULT: ModuleFlags = { starcitizen: false, gallery: false, wow: false };

let cache: ModuleFlags | null = null;
let inflight: Promise<ModuleFlags> | null = null;

function fetchModules(): Promise<ModuleFlags> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = api
      .get<{ modules: ModuleFlags }>('/settings/modules')
      .then((r) => (cache = r.modules))
      .catch(() => DEFAULT);
  }
  return inflight;
}

export function useModules(): ModuleFlags {
  const [flags, setFlags] = useState<ModuleFlags>(cache ?? DEFAULT);
  useEffect(() => {
    let live = true;
    void fetchModules().then((v) => live && setFlags(v));
    return () => {
      live = false;
    };
  }, []);
  return flags;
}

/** Drop the cache after an admin toggles modules, so the next read re-fetches. */
export function clearModulesCache() {
  cache = null;
  inflight = null;
}

/* ------------------------------------------------------------------ *
 * Star Citizen module config — org SID + the per-feature kill switches. Cached
 * the same way; profiles read it to hide a killed feature without a reload.
 * ------------------------------------------------------------------ */

export interface ScConfig {
  orgSid: string;
  hangarEnabled: boolean;
  verifyEnabled: boolean;
}

// Defaults are ON so the UI shows while loading; the server is the authority
// (killed routes 404 regardless of what the client briefly renders).
const SC_DEFAULT: ScConfig = { orgSid: '', hangarEnabled: true, verifyEnabled: true };

let scCache: ScConfig | null = null;
let scInflight: Promise<ScConfig> | null = null;

function fetchScConfig(): Promise<ScConfig> {
  if (scCache) return Promise.resolve(scCache);
  if (!scInflight) {
    scInflight = api
      .get<{ sc: ScConfig }>('/settings/sc')
      .then((r) => (scCache = r.sc))
      .catch(() => SC_DEFAULT);
  }
  return scInflight;
}

export function useScConfig(): ScConfig {
  const [cfg, setCfg] = useState<ScConfig>(scCache ?? SC_DEFAULT);
  useEffect(() => {
    let live = true;
    void fetchScConfig().then((v) => live && setCfg(v));
    return () => {
      live = false;
    };
  }, []);
  return cfg;
}

/** Drop the SC-config cache after an admin edits it (e.g. flips a kill switch). */
export function clearScConfigCache() {
  scCache = null;
  scInflight = null;
}

/* ------------------------------------------------------------------ *
 * Gallery module config — hero on/off plus its copy. Cached like the others so
 * the gallery page and its admin agree without a reload.
 * ------------------------------------------------------------------ */

export interface GalleryConfig {
  heroEnabled: boolean;
  heroTitle: string;
  heroTagline: string;
}

// Hero defaults ON while loading, matching the server default, so the page
// doesn't visibly pop a hero in after the config lands.
const GALLERY_DEFAULT: GalleryConfig = { heroEnabled: true, heroTitle: '', heroTagline: '' };

let galleryCache: GalleryConfig | null = null;
let galleryInflight: Promise<GalleryConfig> | null = null;

function fetchGalleryConfig(): Promise<GalleryConfig> {
  if (galleryCache) return Promise.resolve(galleryCache);
  if (!galleryInflight) {
    galleryInflight = api
      .get<{ gallery: GalleryConfig }>('/settings/gallery')
      .then((r) => (galleryCache = r.gallery))
      .catch(() => GALLERY_DEFAULT);
  }
  return galleryInflight;
}

export function useGalleryConfig(): GalleryConfig {
  const [cfg, setCfg] = useState<GalleryConfig>(galleryCache ?? GALLERY_DEFAULT);
  useEffect(() => {
    let live = true;
    void fetchGalleryConfig().then((v) => live && setCfg(v));
    return () => {
      live = false;
    };
  }, []);
  return cfg;
}

/** Drop the gallery-config cache after an admin edits it. */
export function clearGalleryConfigCache() {
  galleryCache = null;
  galleryInflight = null;
}
