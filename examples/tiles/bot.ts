/** A small player: runs right, hops gaps, walls, spikes and slimes, and
 * climbs the starter level's ladder. Tests use it to play levels they built,
 * and to record the starter level's playthrough. */

export interface BotView {
  hero: { position: number[]; velocity: number[]; grounded: boolean };
  slimes: number[][];
  /** Tile flags at a world position: 1 solid, 2 one-way, 4 ladder, 8 hazard. */
  flags(x: number, y: number): number;
}

export interface BotKeys {
  move: number;
  climb: number;
  jump: boolean;
  /** Whether jump is held this tick (it stays held while rising). */
  held: boolean;
}

export function botKeys(view: BotView, state: { jump: boolean }): BotKeys {
  const { position: p, velocity: v, grounded } = view.hero;
  const { flags } = view;
  let move = 1, climb = 0, jump = false;
  if (p[0] > 32.2 && p[0] < 34 && p[1] < 9.45) {
    // Centre on the ladder and climb; at the top step onto the plateau.
    move = Math.abs(p[0] - 33.5) > 0.15 ? Math.sign(33.5 - p[0]) : 0;
    climb = 1;
  } else if (p[0] >= 33 && p[0] < 34.5 && p[1] >= 9.45) {
    move = 1;
  } else if (grounded) {
    const wall = flags(p[0] + 0.75, p[1] - 0.1) & 1;
    const gap = !(flags(p[0] + 0.9, p[1] - 0.6) & 3);
    const spikes = flags(p[0] + 0.9, p[1] - 0.45) & 8 ||
      flags(p[0] + 1.6, p[1] - 0.45) & 8;
    const slime = view.slimes.some((s) =>
      s[0] - p[0] > 0.3 && s[0] - p[0] < 2.6 && Math.abs(s[1] - p[1]) < 1.2
    );
    jump = !!(wall || gap || spikes || slime);
  }
  const rising = v[1] > 0.3;
  const keys = {
    move,
    climb,
    jump: jump && !state.jump,
    held: jump || (state.jump && rising),
  };
  state.jump = keys.held;
  return keys;
}
