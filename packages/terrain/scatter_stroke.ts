/**
 * A drag with the scatter brush as one undo step: dabs change the set at once
 * (so the renderer shows them), and the whole drag becomes a single revision
 * of the resource when it ends.
 */
import type { Placement } from "@ink/geometry";
import type { ScatterResource } from "@ink/render";

const keyOf = (p: Placement) =>
  `${Math.fround(p.x)},${Math.fround(p.y)},${Math.fround(p.z)},${
    Math.fround(p.yaw)
  },${Math.fround(p.scale)},${Math.fround(p.tint)}`;

export class ScatterStroke {
  /** The net result so far, relative to the set when the stroke began. */
  readonly added: Placement[] = [];
  readonly removed: Placement[] = [];

  constructor(readonly resource: ScatterResource) {
    if (!resource.set) throw new Error("scatter is not loaded");
  }

  get changed(): boolean {
    return this.added.length > 0 || this.removed.length > 0;
  }

  add(placements: Placement[]): void {
    if (!placements.length) return;
    this.resource.apply(placements, []);
    this.added.push(...placements);
  }

  remove(placements: Placement[]): void {
    if (!placements.length) return;
    this.resource.apply([], placements);
    // What this stroke added and then removed was never there.
    const mine = new Map(this.added.map((p, i) => [keyOf(p), i]));
    const gone = new Set<number>();
    for (const p of placements) {
      const i = mine.get(keyOf(p));
      if (i === undefined) this.removed.push(p);
      else gone.add(i);
    }
    if (gone.size) {
      const kept = this.added.filter((_, i) => !gone.has(i));
      this.added.length = 0;
      this.added.push(...kept);
    }
  }

  /** Make the drag one revision; returns it, or null if nothing changed. */
  finish(): number | null {
    if (!this.changed) return null;
    return this.resource.record([...this.added], [...this.removed]);
  }

  /** Undo the drag's changes without recording them. */
  revert(): void {
    if (!this.changed) return;
    this.resource.apply([...this.removed], [...this.added]);
    this.added.length = 0;
    this.removed.length = 0;
  }
}
