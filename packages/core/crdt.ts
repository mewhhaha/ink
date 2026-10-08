/** A Lamport-clock map of JSON field registers, with explicit object lifetimes. */
export type Json = null | boolean | number | string | Json[] | {
  [key: string]: Json;
};
export type CrdtNode =
  | { kind: "object" }
  | { kind: "vector"; length: number }
  | { kind: "value"; value: Json }
  | { kind: "deleted" };
export interface CrdtEntry {
  path: string[];
  actor: string;
  clock: number;
  node: CrdtNode;
}
interface Change {
  previous: CrdtNode;
  observed?: { actor: string; clock: number };
  written: CrdtEntry;
}
interface UndoEntry {
  label: string;
  changes: Change[];
}
const deleted: CrdtNode = { kind: "deleted" };
const key = (path: string[]) => JSON.stringify(path);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const stamp = (a: CrdtEntry, b: CrdtEntry) =>
  a.clock - b.clock || (a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0);

function flatten(
  value: Json,
  path: string[] = [],
  out = new Map<string, { path: string[]; node: CrdtNode }>(),
) {
  if (
    Array.isArray(value) && value.length >= 2 && value.length <= 4 &&
    value.every((v) => typeof v === "number")
  ) {
    out.set(key(path), {
      path,
      node: { kind: "vector", length: value.length },
    });
    value.forEach((v, i) => flatten(v, [...path, String(i)], out));
  } else if (
    value !== null && typeof value === "object" && !Array.isArray(value)
  ) {
    out.set(key(path), { path, node: { kind: "object" } });
    for (const [name, child] of Object.entries(value)) {
      flatten(child, [...path, name], out);
    }
  } else {out.set(key(path), {
      path,
      node: { kind: "value", value: structuredClone(value) },
    });}
  return out;
}

export class CrdtDocument {
  #entries = new Map<string, CrdtEntry>();
  #clock = 0;
  #undo: UndoEntry[] = [];
  #redo: UndoEntry[] = [];
  #group: UndoEntry | null = null;
  constructor(readonly actor: string, initial?: Json) {
    if (!actor || actor.length > 128) throw new Error("invalid CRDT actor");
    if (initial !== undefined) {
      this.merge(
        [...flatten(initial).values()].map((e) => ({
          ...e,
          actor: "seed",
          clock: 0,
        })),
      );
    }
  }

  entries(): CrdtEntry[] {
    return structuredClone([...this.#entries.values()]);
  }

  /** Includes tombstoned objects, whose identities cannot be reallocated. */
  has(path: string[]): boolean {
    return this.#entries.has(key(path));
  }

  merge(entries: readonly CrdtEntry[]): boolean {
    // Validate the whole batch before changing the document.
    for (const entry of entries) validateEntry(entry);
    const batch = new Map<string, CrdtEntry>();
    for (const entry of entries) {
      const old = batch.get(key(entry.path)) ??
        this.#entries.get(key(entry.path));
      if (old && stamp(entry, old) === 0 && !same(entry.node, old.node)) {
        throw new Error("conflicting CRDT operation identity");
      }
      if (!old || stamp(entry, old) > 0) batch.set(key(entry.path), entry);
    }
    let changed = false;
    for (const entry of entries) {
      this.#clock = Math.max(this.#clock, entry.clock);
      const k = key(entry.path), old = this.#entries.get(k);
      if (!old || stamp(entry, old) > 0) {
        this.#entries.set(k, structuredClone(entry));
        changed = true;
      }
    }
    return changed;
  }

  read(): Json {
    const children = new Map<string, string[]>();
    for (const { path } of this.#entries.values()) {
      if (!path.length) continue;
      const parent = key(path.slice(0, -1));
      let row = children.get(parent);
      if (!row) children.set(parent, row = []);
      row.push(path.at(-1)!);
    }
    const visit = (path: string[]): Json | undefined => {
      const node = this.#entries.get(key(path))?.node;
      if (!node || node.kind === "deleted") return undefined;
      if (node.kind === "value") return structuredClone(node.value);
      if (node.kind === "vector") {
        return Array.from(
          { length: node.length },
          (_, i) => visit([...path, String(i)]) ?? 0,
        );
      }
      const value: { [key: string]: Json } = Object.create(null);
      for (const name of (children.get(key(path)) ?? []).sort()) {
        const child = visit([...path, name]);
        if (child !== undefined) value[name] = child;
      }
      return value;
    };
    return visit([]) ?? {};
  }

  /** Diff the caller's before/after view, so unseen concurrent changes survive. */
  change(
    before: Json,
    after: Json,
    label: string,
    history = true,
  ): CrdtEntry[] {
    const a = flatten(before), b = flatten(after);
    const patches: { path: string[]; node: CrdtNode }[] = [];
    for (const k of new Set([...a.keys(), ...b.keys()])) {
      const old = a.get(k), next = b.get(k);
      // Removing a container hides its descendants. Retaining their registers
      // lets a later undo reveal concurrent edits, regardless of actor ordering.
      if (
        !next && old && old.path.some((_, i) => {
          const parent = b.get(key(old.path.slice(0, i)))?.node;
          return !parent ||
            (parent.kind !== "object" && parent.kind !== "vector");
        })
      ) continue;
      if (!same(old?.node, next?.node)) {
        patches.push({
          path: (next ?? old)!.path,
          node: next?.node ?? deleted,
        });
      }
    }
    if (!patches.length) return [];
    const entry = this.#write(patches, label);
    if (history) {
      this.#redo = [];
      if (this.#group) {
        for (const change of entry.changes) {
          const prior = this.#group.changes.find((c) =>
            key(c.written.path) === key(change.written.path)
          );
          if (prior) {
            if (
              !change.observed ||
              prior.written.actor !== change.observed.actor ||
              prior.written.clock !== change.observed.clock
            ) prior.previous = change.previous;
            prior.written = change.written;
          } else this.#group.changes.push(change);
        }
      } else {
        this.#undo.push(entry);
        if (this.#undo.length > 200) this.#undo.shift();
      }
    }
    return entry.changes.map((c) => c.written);
  }

  begin(label: string) {
    this.commit();
    this.#group = { label, changes: [] };
  }
  commit() {
    if (this.#group?.changes.length) this.#undo.push(this.#group);
    this.#group = null;
    if (this.#undo.length > 200) this.#undo.shift();
  }
  cancel(): CrdtEntry[] {
    const group = this.#group;
    this.#group = null;
    return group ? this.#invert(group).changes.map((c) => c.written) : [];
  }
  history() {
    return {
      undo: this.#undo.map((e) => e.label),
      redo: this.#redo.map((e) => e.label).reverse(),
    };
  }
  undo() {
    this.commit();
    return this.#travel(this.#undo, this.#redo);
  }
  redo() {
    this.commit();
    return this.#travel(this.#redo, this.#undo);
  }

  #travel(from: UndoEntry[], to: UndoEntry[]) {
    const entry = from.pop();
    if (!entry) return [];
    const inverse = this.#invert(entry);
    if (inverse.changes.length) to.push(inverse);
    return inverse.changes.map((c) => c.written);
  }

  #invert(entry: UndoEntry): UndoEntry {
    const mine = new Map(
      entry.changes.map((c) => [key(c.written.path), c.written]),
    );
    const changes = entry.changes.filter(({ written, previous }) => {
      const current = this.#entries.get(key(written.path));
      if (!current || stamp(current, written) !== 0) return false;
      if (
        previous.kind !== "deleted" ||
        (written.node.kind !== "object" && written.node.kind !== "vector")
      ) return true;
      // Undoing a creation must not delete another person's edits below it.
      return ![...this.#entries.values()].some((child) => {
        if (
          child.node.kind === "deleted" ||
          child.path.length <= written.path.length ||
          !written.path.every((p, i) => p === child.path[i])
        ) return false;
        const expected = mine.get(key(child.path));
        return !expected || stamp(child, expected) !== 0;
      });
    });
    return this.#write(
      changes.map((c) => ({ path: c.written.path, node: c.previous })),
      entry.label,
    );
  }

  #write(
    patches: { path: string[]; node: CrdtNode }[],
    label: string,
  ): UndoEntry {
    const clock = ++this.#clock;
    const changes = patches.map(({ path, node }) => ({
      previous: this.#entries.get(key(path))?.node ?? deleted,
      observed: this.#entries.has(key(path))
        ? {
          actor: this.#entries.get(key(path))!.actor,
          clock: this.#entries.get(key(path))!.clock,
        }
        : undefined,
      written: { path, node, actor: this.actor, clock },
    }));
    this.merge(changes.map((c) => c.written));
    return structuredClone({ label, changes });
  }
}

function validateEntry(entry: CrdtEntry) {
  if (
    !entry || !Array.isArray(entry.path) || entry.path.length > 24 ||
    !entry.path.every((p) => typeof p === "string" && p.length <= 256) ||
    typeof entry.actor !== "string" || !entry.actor ||
    entry.actor.length > 128 || !Number.isSafeInteger(entry.clock) ||
    entry.clock < 0 || entry.clock >= Number.MAX_SAFE_INTEGER || !entry.node ||
    !["object", "vector", "value", "deleted"].includes(entry.node.kind)
  ) throw new Error("invalid CRDT entry");
  if (
    entry.node.kind === "vector" &&
    (!Number.isInteger(entry.node.length) || entry.node.length < 2 ||
      entry.node.length > 4)
  ) throw new Error("invalid CRDT vector");
  if (entry.node.kind === "value") {
    let count = 0;
    const valid = (v: Json, depth: number): boolean => {
      if (++count > 200_000 || depth > 24) return false;
      if (v === null || typeof v === "boolean" || typeof v === "string") {
        return true;
      }
      if (typeof v === "number") return Number.isFinite(v);
      if (Array.isArray(v)) return v.every((x) => valid(x, depth + 1));
      if (v && typeof v === "object") {
        return Object.values(v).every((x) => valid(x, depth + 1));
      }
      return false;
    };
    if (!valid(entry.node.value, 0)) throw new Error("invalid CRDT value");
  }
}
