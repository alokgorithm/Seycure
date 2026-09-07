import { useState, useEffect } from 'react';
import { Preferences } from '@capacitor/preferences';

export interface AppStats {
  linksCleaned: number;
  photosScrubbed: number;
  trackersRemoved: number;
}

const STATS_KEY = 'seycure_app_stats';

const defaultStats: AppStats = {
  linksCleaned: 0,
  photosScrubbed: 0,
  trackersRemoved: 0,
};

export function useAppStats() {
  const [stats, setStats] = useState<AppStats>(defaultStats);

  // Load stats on mount
  useEffect(() => {
    const loadStats = async () => {
      try {
        const { value } = await Preferences.get({ key: STATS_KEY });
        if (value) {
          setStats(JSON.parse(value));
        }
      } catch (err) {
        console.error('Failed to load stats:', err);
      }
    };
    loadStats();
  }, []);

  const incrementLinksCleaned = async () => {
    const newStats = { ...stats, linksCleaned: stats.linksCleaned + 1 };
    setStats(newStats);
    await Preferences.set({ key: STATS_KEY, value: JSON.stringify(newStats) });
  };

  const incrementPhotosScrubbed = async () => {
    const newStats = { ...stats, photosScrubbed: stats.photosScrubbed + 1 };
    setStats(newStats);
    await Preferences.set({ key: STATS_KEY, value: JSON.stringify(newStats) });
  };

  const incrementTrackersRemoved = async (count: number) => {
    if (count <= 0) return;
    const newStats = { ...stats, trackersRemoved: stats.trackersRemoved + count };
    setStats(newStats);
    await Preferences.set({ key: STATS_KEY, value: JSON.stringify(newStats) });
  };

  return {
    stats,
    incrementLinksCleaned,
    incrementPhotosScrubbed,
    incrementTrackersRemoved,
  };
}
