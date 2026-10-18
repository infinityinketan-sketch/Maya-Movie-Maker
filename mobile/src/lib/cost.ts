import type { Catalog, Character, Project, Shot } from './types';

// The server is the source of truth for prices; these mirror its maths so the app can
// show the exact credit cost before the user taps.

export function planCost(cat: Catalog, targetSec: number): number {
  const keys = Object.keys(cat.planPerDuration).map(Number).sort((a, b) => a - b);
  const key = keys.find((k) => k >= targetSec) ?? keys[keys.length - 1];
  return cat.planPerDuration[String(key)] ?? 0;
}

export function videoCost(cat: Catalog, project: Pick<Project, 'tier'>, shot: Pick<Shot, 'duration_sec'>): number {
  return cat.tiers[project.tier].videoPerShot[String(shot.duration_sec) as '4' | '6' | '8'];
}

export function filmEstimate(cat: Catalog, project: Pick<Project, 'tier' | 'target_duration_sec'>): number {
  const shots = Math.max(1, Math.round(project.target_duration_sec / 6));
  const perShot = cat.tiers[project.tier].videoPerShot['6'];
  // story + frames + one take per shot + music + render, with a 1.5x allowance for re-takes
  return Math.round(planCost(cat, project.target_duration_sec) + shots * cat.image * 1.5 + shots * perShot * 1.5 + cat.music + cat.renderPerMinute);
}

export function framesNeeded(shots: Shot[]): Shot[] {
  return shots.filter((s) => !s.keyframe_url && s.keyframe_status !== 'queued' && s.keyframe_status !== 'running');
}
export function portraitsNeeded(chars: Character[]): Character[] {
  return chars.filter((c) => !c.portrait_url && c.portrait_status !== 'queued' && c.portrait_status !== 'running');
}
export function videosNeeded(shots: Shot[]): Shot[] {
  return shots.filter((s) => s.approved && s.keyframe_url && !s.video_url && s.video_status !== 'queued' && s.video_status !== 'running');
}

export function rupees(credits: number): string {
  return `₹${credits.toLocaleString('en-IN')}`;
}
