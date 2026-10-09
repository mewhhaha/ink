/**
 * Brush settings and targets of the terrain tools: presentation state, never
 * game state. The settings persist in the browser; the targets are entity ids
 * of the open scene and do not.
 */
import { Store, useStore } from "@ink/react";
import type { FalloffShape } from "./sculpt.ts";

export interface TerrainBrush {
  /** Brush radius, metres. */
  radius: number;
  /** 0..1. Raise, lower and noise move heights by `strength * radius *
   * 0.05` metres per dab; smooth, flatten and paint blend by `strength`. */
  strength: number;
  falloff: FalloffShape;
  /** The part of the radius at full strength, 0..1. */
  hardness: number;
  /** Dab spacing as a fraction of the radius. */
  spacing: number;
  /** Keep applying dabs while the button is held still. */
  airbrush: boolean;
  /** Layer the paint tool applies (index into the terrain's layers). */
  layer: number;
  noiseScale: number;
  noiseOctaves: number;
  noiseSeed: number;
  /** Flatten toward the height where the stroke began, or a fixed level
   * (Ctrl+click samples it). */
  flatten: "start" | "level";
  /** The fixed level, terrain-local metres. */
  level: number;
  // Scatter
  /** Instances per 100 square metres. */
  density: number;
  /** Minimum distance between instances, metres. */
  minSpacing: number;
  scaleMin: number;
  scaleMax: number;
  tintMin: number;
  tintMax: number;
  /** Skip ground steeper than this, degrees (0 = no limit). */
  maxSlope: number;
  /** Height above the ground, metres. */
  lift: number;
  seed: number;
  /** Remove instances instead of adding them (Ctrl swaps). */
  erase: boolean;
}

export const defaultBrush: TerrainBrush = {
  radius: 16,
  strength: 0.4,
  falloff: "smooth",
  hardness: 0.25,
  spacing: 0.15,
  airbrush: true,
  layer: 0,
  noiseScale: 24,
  noiseOctaves: 3,
  noiseSeed: 1,
  flatten: "start",
  level: 0,
  density: 8,
  minSpacing: 2,
  scaleMin: 0.8,
  scaleMax: 1.3,
  tintMin: 0,
  tintMax: 1,
  maxSlope: 40,
  lift: 0,
  seed: 1,
  erase: false,
};

export const terrainBrush: Store<TerrainBrush> = new Store<TerrainBrush>(
  defaultBrush,
  "ink:terrain-brush",
);

export function useTerrainBrush(): TerrainBrush {
  return useStore(terrainBrush, (s) => s);
}

export interface TerrainTargets {
  /** Entity the sculpt and paint tools edit; 0 takes the selected terrain,
   * or else the one under the pointer. */
  terrain: number;
  /** Entity the scatter tool edits; 0 takes the selected one, or else the
   * first in the scene. */
  scatter: number;
}

export const terrainTargets: Store<TerrainTargets> = new Store<TerrainTargets>(
  { terrain: 0, scatter: 0 },
);

/** Metres a raise or lower dab moves the ground at full weight. */
export const heightPerDab = (brush: TerrainBrush) =>
  brush.strength * brush.radius * 0.05;

export function clampBrush(
  brush: Partial<TerrainBrush>,
): Partial<TerrainBrush> {
  const out = { ...brush };
  if (out.radius !== undefined) {
    out.radius = Math.min(1000, Math.max(0.5, out.radius));
  }
  if (out.strength !== undefined) {
    out.strength = Math.min(1, Math.max(0.01, out.strength));
  }
  return out;
}

/** Resize the brush by a factor (the `[` and `]` keys). */
export function scaleRadius(factor: number) {
  terrainBrush.set((b) => clampBrush({ radius: b.radius * factor }));
}
