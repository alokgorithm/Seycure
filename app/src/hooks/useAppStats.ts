import { useEffect, useSyncExternalStore } from 'react';
import { Preferences } from '@capacitor/preferences';

export interface AppStats {
  linksCleaned: number;
  photosScrubbed: number;
  trackersRemoved: number;
  screenshotsProtected: number;
}

const STATS_KEY = 'seycure_app_stats';

const defaultStats: AppStats = {
  linksCleaned: 0,
  photosScrubbed: 0,
  trackersRemoved: 0,
  screenshotsProtected: 0,
};

// ── Shared store ────────────────────────────────────────────────────────────
// Every useAppStats() caller reads one cached copy, so a count written by the
// blur editor shows up on the home screen without restarting the app. Writes
// always re-read storage first, so a component holding a stale copy can never
// overwrite a counter it did not touch.

let cached: AppStats = defaultStats;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): AppStats {
  return cached;
}

function publish(next: AppStats) {
  cached = next;
  for (const listener of listeners) listener();
}

function normalise(raw: unknown): AppStats {
  const value = (raw ?? {}) as Partial<Record<keyof AppStats, unknown>>;
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return {
    linksCleaned: count(value.linksCleaned),
    photosScrubbed: count(value.photosScrubbed),
    trackersRemoved: count(value.trackersRemoved),
    screenshotsProtected: count(value.screenshotsProtected),
  };
}

/** Reads the stored stats, or null if storage could not be read. */
async function readStats(): Promise<AppStats | null> {
  try {
    const { value } = await Preferences.get({ key: STATS_KEY });
    return value ? normalise(JSON.parse(value)) : { ...defaultStats };
  } catch (err) {
    console.error('Failed to load stats:', err);
    return null;
  }
}

let loadPromise: Promise<void> | null = null;

function loadOnce(): Promise<void> {
  if (!loadPromise) {
    loadPromise = readStats().then(stats => {
      if (stats) publish(stats);
    });
  }
  return loadPromise;
}

// Writes are queued so two increments in the same tick cannot read the same
// value and lose one of the two.
let writeQueue: Promise<void> = Promise.resolve();

async function applyIncrement(field: keyof AppStats, by: number): Promise<void> {
  const current = await readStats();
  // Storage unreadable: skip rather than write a guess over real counts.
  if (!current) return;

  const next = { ...current, [field]: current[field] + by };
  publish(next);

  try {
    await Preferences.set({ key: STATS_KEY, value: JSON.stringify(next) });
  } catch (err) {
    console.error('Failed to save stats:', err);
  }
}

function increment(field: keyof AppStats, by: number): Promise<void> {
  if (by <= 0) return writeQueue;
  writeQueue = writeQueue.then(() => applyIncrement(field, by));
  return writeQueue;
}

// Defined at module level so the identities stay stable across renders and
// callers can list them in dependency arrays without re-running effects.
const incrementLinksCleaned = () => increment('linksCleaned', 1);
const incrementPhotosScrubbed = () => increment('photosScrubbed', 1);
const incrementScreenshotsProtected = (count: number = 1) => increment('screenshotsProtected', count);
const incrementTrackersRemoved = (count: number) => increment('trackersRemoved', count);

export function useAppStats() {
  const stats = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    void loadOnce();
  }, []);

  return {
    stats,
    incrementLinksCleaned,
    incrementPhotosScrubbed,
    incrementScreenshotsProtected,
    incrementTrackersRemoved,
  };
}
