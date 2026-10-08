/**
 * A Session is one running project: its schema and asset catalog, the scene
 * document, the live play world, the game instance, undo history, the play
 * timeline, selection, comments and console. It is DOM-free; the browser UI,
 * the dev client and headless tools all drive the same object.
 *
 * Edit mode shows the document. Play copies the document into a live world
 * and steps it; stop returns to the document. Edits target whichever world
 * is showing, so pausing a game and nudging an entity just works.
 */
import {
  type Catalog,
  decodeWorld,
  encodeWorld,
  type EventModel,
  type InputModel,
  migrateWorld,
  recordFromScene,
  type SceneFile,
  sceneToWorld,
  type Schema,
  type StepResult,
  textId,
  validateTextIds,
  type WorldModel,
  worldToScene,
} from "@ink/schema";
import type { Comment } from "./comments.ts";
import { commentId } from "./comments.ts";
import { InputState } from "./input.ts";
import { eventText, formatMessage } from "./messages.ts";
import { type Keyframe, Timeline } from "./timeline.ts";

/** What a compiled game offers; `@ink/blot`'s `Game` satisfies it. */
export interface GameInstance {
  step(state: Float32Array, input: InputModel): StepResult;
  start(state: Float32Array, input: InputModel): StepResult;
  readonly hasStart: boolean;
  dispose(): void;
}

/** An external clock, e.g. network play, owns stepping while attached. */
export interface PlayDriver {
  readonly label: string;
  advance(seconds: number): boolean;
  dispose(): void;
}

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
  excerpt: string;
}

export type Mode = "edit" | "play";

export type GameStatus =
  | { kind: "none" }
  | { kind: "building"; revision?: number }
  | { kind: "ready"; revision: number; ms?: number }
  | { kind: "error"; diagnostics: Diagnostic[]; revision?: number };

export interface LogEntry {
  id: number;
  time: number;
  tick: number;
  mode: Mode;
  level: "info" | "warn" | "error" | "game";
  source: "game" | "build" | "session" | "dev" | "scenario";
  text: string;
  detail?: string;
}

/** A world in a specific layout, with the host-only entity names. */
export interface Snapshot {
  state: Float32Array;
  names: ReadonlyMap<number, string>;
  schema: Schema;
  catalog: Catalog;
}

interface HistoryEntry {
  label: string;
  target: "document" | "live";
  before: Snapshot;
  after: Snapshot;
  time: number;
}

export interface Transaction {
  /** Apply a change now, without a history entry. */
  update(recipe: Recipe): void;
  /** Record everything since `begin` as one undo step. */
  commit(): void;
  /** Restore the world as it was at `begin`. */
  cancel(): void;
}

export type Recipe = (world: WorldModel, names: Map<number, string>) => void;

export interface SessionOptions {
  schema: Schema;
  catalog: Catalog;
  scene?: SceneFile;
  sceneName?: string;
  /** Steps per second. */
  tickRate?: number;
}

type Listener = () => void;
type EventListener = (events: EventModel[], tick: number) => void;

const LOG_LIMIT = 500;
const HISTORY_LIMIT = 200;

export class Session {
  schema: Schema;
  catalog: Catalog;
  sceneName: string;
  readonly tickRate: number;
  readonly dt: number;
  mode: Mode = "edit";
  paused = false;
  status: GameStatus = { kind: "none" };
  selection: readonly number[] = [];
  /** Entity under the pointer in any view; presentation only. */
  hovered = 0;
  comments: readonly Comment[] = [];
  log: readonly LogEntry[] = [];
  /** The document changed since it was loaded or saved. */
  dirty = false;
  /** A scene that changed on disk while the document had unsaved edits. */
  pendingScene: SceneFile | null = null;
  /** Bumped on every change; cheap to compare. */
  version = 0;
  /** Events of the latest step, e.g. debug lines to draw. */
  frameEvents: readonly EventModel[] = [];
  /** Presentation preference: changing language never changes the game packet. */
  locale: string;
  readonly input: InputState;
  readonly timeline = new Timeline();

  #document: Snapshot;
  #live: Snapshot | null = null;
  #game: GameInstance | null = null;
  #gameStale = false;
  #undo: HistoryEntry[] = [];
  #redo: HistoryEntry[] = [];
  #transaction: { label: string; before: Snapshot } | null = null;
  #accumulator = 0;
  #time = 0;
  #viewTick: number | null = null;
  #logId = 0;
  #listeners = new Set<Listener>();
  #eventListeners = new Set<EventListener>();
  #commentListeners = new Set<(comments: readonly Comment[]) => void>();
  #worlds = new WeakMap<Float32Array, WorldModel>();
  #driver: PlayDriver | null = null;

  constructor(options: SessionOptions) {
    this.schema = options.schema;
    this.locale = this.schema.defaultLocale;
    this.catalog = options.catalog;
    this.sceneName = options.sceneName ?? "main";
    this.tickRate = options.tickRate ?? 60;
    this.dt = 1 / this.tickRate;
    this.input = new InputState(this.schema);
    this.#document = this.#snapshotOf(
      options.scene ?? { ink: 1, entities: [] },
    );
  }

  // Subscriptions ---------------------------------------------------------------

  setLocale(locale: string) {
    if (this.locale === locale) return;
    if (locale !== this.schema.defaultLocale && !this.schema.locales[locale]) {
      throw new Error(`unknown locale: ${locale}`);
    }
    this.locale = locale;
    this.#changed();
  }

  message(name: string | number, ...args: (number | string)[]): string {
    const id = typeof name === "number"
      ? name
      : this.schema.messages.find((m) => m.name === name)?.id ?? 0;
    return formatMessage(this.schema, id, args, this.locale);
  }

  subscribe = (listener: Listener): () => void => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Game events from each step (sounds, logs, game-specific). */
  onEvents(listener: EventListener): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  /** Called whenever comments change locally, to persist them. */
  onComments(listener: (comments: readonly Comment[]) => void): () => void {
    this.#commentListeners.add(listener);
    return () => this.#commentListeners.delete(listener);
  }

  #changed() {
    this.version++;
    for (const listener of this.#listeners) listener();
  }

  // The world on screen ----------------------------------------------------------

  /** The live world while playing, otherwise the document. */
  get current(): Snapshot {
    return this.#live ?? this.#document;
  }

  get document(): Snapshot {
    return this.#document;
  }

  get state(): Float32Array {
    return this.current.state;
  }

  get world(): WorldModel {
    return this.worldOf(this.current);
  }

  get documentWorld(): WorldModel {
    return this.worldOf(this.#document);
  }

  get names(): ReadonlyMap<number, string> {
    return this.current.names;
  }

  get tick(): number {
    return this.current.state[1];
  }

  /** Seconds of play since play started. */
  get time(): number {
    return this.#time;
  }

  get game(): GameInstance | null {
    return this.#game;
  }

  get driver(): PlayDriver | null {
    return this.#driver;
  }

  /** Whether stepping is possible right now. */
  get canStep(): boolean {
    return this.#game !== null && !this.#gameStale;
  }

  /** The tick being viewed after seeking, or null at the head. */
  get viewTick(): number | null {
    return this.#viewTick;
  }

  get canUndo(): boolean {
    return this.#undo.some((e) => e.target === this.#target());
  }

  get canRedo(): boolean {
    return this.#redo.some((e) => e.target === this.#target());
  }

  /** Decoded world for a snapshot, cached per state array. */
  worldOf(snapshot: Snapshot): WorldModel {
    let world = this.#worlds.get(snapshot.state);
    if (!world) {
      world = decodeWorld(snapshot.schema, snapshot.state);
      this.#worlds.set(snapshot.state, world);
    }
    return world;
  }

  entity(id: number) {
    return this.world.entities.find((e) => e.id === id);
  }

  /** The entity's name, or a label from its components. */
  nameOf(id: number): string {
    const entity = this.entity(id);
    const name = this.current.names.get(id);
    if (name && textId(name) === entity?.nameId) return name;
    const declared = this.schema.names.find((n) => n.id === entity?.nameId);
    if (declared) return declared.text;
    const first = entity &&
      Object.keys(entity.components).find((c) => c !== "transform");
    return `${first ?? "entity"} ${id}`;
  }

  // Edits -------------------------------------------------------------------------

  #target(): "document" | "live" {
    return this.#live ? "live" : "document";
  }

  #snapshotOf(scene: SceneFile): Snapshot {
    const loaded = sceneToWorld(this.schema, scene, this.catalog);
    for (const problem of loaded.problems) {
      this.#log("warn", "session", problem);
    }
    return {
      state: encodeWorld(this.schema, loaded.world),
      names: loaded.names,
      schema: this.schema,
      catalog: this.catalog,
    };
  }

  #setCurrent(snapshot: Snapshot) {
    if (this.#live) this.#live = snapshot;
    else this.#document = snapshot;
  }

  /** Bring an older snapshot into the current layout. */
  #migrate(snapshot: Snapshot): Snapshot {
    if (snapshot.schema === this.schema && snapshot.catalog === this.catalog) {
      return snapshot;
    }
    const world = decodeWorld(snapshot.schema, snapshot.state);
    const moved = migrateWorld(
      { schema: snapshot.schema, catalog: snapshot.catalog },
      { schema: this.schema, catalog: this.catalog },
      world,
      snapshot.names,
    );
    return {
      state: encodeWorld(this.schema, moved.world),
      names: moved.names,
      schema: this.schema,
      catalog: this.catalog,
    };
  }

  /** Change the world on screen. One call is one undo step (or part of the
   * open transaction). Returns false and logs if the result is invalid. */
  edit(label: string, recipe: Recipe): boolean {
    if (this.#driver) {
      this.#log(
        "warn",
        "session",
        `Leave ${this.#driver.label} before editing the live world`,
      );
      this.#changed();
      return false;
    }
    const before = this.current;
    const world = structuredClone(this.worldOf(before));
    const names = new Map(before.names);
    try {
      recipe(world, names);
      validateTextIds([
        ...this.schema.names.map((n) => n.text),
        ...names.values(),
      ]);
      for (const entity of world.entities) {
        if (
          names.has(entity.id) &&
          (names.get(entity.id) !== before.names.get(entity.id) ||
            !entity.nameId)
        ) entity.nameId = textId(names.get(entity.id)!);
        else if (!names.has(entity.id) && before.names.has(entity.id)) {
          delete entity.nameId;
        }
      }
      world.tick = this.worldOf(before).tick;
      const after: Snapshot = {
        state: encodeWorld(this.schema, world),
        names,
        schema: this.schema,
        catalog: this.catalog,
      };
      this.#worlds.set(after.state, world);
      this.#apply(label, before, after);
      return true;
    } catch (error) {
      this.#log("error", "session", `${label} failed: ${errorText(error)}`);
      this.#changed();
      return false;
    }
  }

  #apply(label: string, before: Snapshot, after: Snapshot) {
    const target = this.#target();
    this.#setCurrent(after);
    if (!this.#transaction) this.#record(label, target, before, after);
    if (target === "document") this.dirty = true;
    else this.timeline.branch(this.#keyframe(after));
    if (target === "live") {
      this.timeline.mark({ tick: this.tick, kind: "edit", label });
    }
    this.#changed();
  }

  #record(
    label: string,
    target: "document" | "live",
    before: Snapshot,
    after: Snapshot,
  ) {
    this.#undo.push({ label, target, before, after, time: Date.now() });
    if (this.#undo.length > HISTORY_LIMIT) this.#undo.shift();
    this.#redo = this.#redo.filter((e) => e.target !== target);
  }

  /** Group continuous changes (a drag, a slider) into one undo step. */
  begin(label: string): Transaction {
    if (this.#driver) {
      throw new Error(`Leave ${this.#driver.label} before editing`);
    }
    if (this.#transaction) this.#commitTransaction();
    const before = this.current;
    this.#transaction = { label, before };
    return {
      update: (recipe) => {
        if (this.#transaction?.before === before) this.edit(label, recipe);
      },
      commit: () => {
        if (this.#transaction?.before === before) this.#commitTransaction();
      },
      cancel: () => {
        if (this.#transaction?.before !== before) return;
        this.#transaction = null;
        this.#setCurrent(this.#migrate(before));
        this.#changed();
      },
    };
  }

  #commitTransaction() {
    const transaction = this.#transaction!;
    this.#transaction = null;
    if (this.current !== transaction.before) {
      this.#record(
        transaction.label,
        this.#target(),
        transaction.before,
        this.current,
      );
    }
    this.#changed();
  }

  undo() {
    if (this.#driver) return;
    this.#travel(this.#undo, this.#redo, "before", "Undo");
  }

  redo() {
    if (this.#driver) return;
    this.#travel(this.#redo, this.#undo, "after", "Redo");
  }

  #travel(
    from: HistoryEntry[],
    to: HistoryEntry[],
    side: "before" | "after",
    verb: string,
  ) {
    if (this.#transaction) this.#commitTransaction();
    const target = this.#target();
    const index = from.findLastIndex((e) => e.target === target);
    if (index < 0) return;
    const [entry] = from.splice(index, 1);
    to.push(entry);
    const snapshot = { ...this.#migrate(entry[side]) };
    // Keep the tick: undoing a live edit should not rewind time.
    if (target === "live") {
      snapshot.state = snapshot.state.slice();
      snapshot.state[1] = this.tick;
      this.timeline.branch(this.#keyframe(snapshot));
    } else {
      this.dirty = true;
    }
    this.#setCurrent(snapshot);
    this.#log("info", "session", `${verb} ${entry.label}`);
    this.#changed();
  }

  /** History labels, oldest first, for the current target. */
  history(): { undo: string[]; redo: string[] } {
    const target = this.#target();
    return {
      undo: this.#undo.filter((e) => e.target === target).map((e) => e.label),
      redo: this.#redo.filter((e) => e.target === target).map((e) => e.label)
        .reverse(),
    };
  }

  // Common edits ----------------------------------------------------------------

  createEntity(
    options: {
      name?: string;
      parent?: number;
      /** Scene-style components: asset paths allowed, fields optional. */
      components?: Record<string, unknown>;
      select?: boolean;
    } = {},
  ): number {
    let id = 0;
    this.edit(`Create ${options.name ?? "entity"}`, (world, names) => {
      id = world.nextEntity++;
      world.entities.push({
        id,
        parent: options.parent ?? 0,
        components: this.#components(options.components ?? {}),
      });
      if (options.name) names.set(id, options.name);
    });
    if (options.select !== false) this.select([id]);
    return id;
  }

  deleteEntities(ids: readonly number[]) {
    if (ids.length === 0) return;
    const doomed = new Set<number>();
    this.edit(
      ids.length === 1
        ? `Delete ${this.nameOf(ids[0])}`
        : `Delete ${ids.length} entities`,
      (world, names) => {
        for (const id of ids) doomed.add(id);
        let grew = true;
        while (grew) {
          grew = false;
          for (const e of world.entities) {
            if (!doomed.has(e.id) && doomed.has(e.parent)) {
              doomed.add(e.id);
              grew = true;
            }
          }
        }
        world.entities = world.entities.filter((e) => !doomed.has(e.id));
        for (const id of doomed) names.delete(id);
      },
    );
    this.select(this.selection.filter((id) => !doomed.has(id)));
  }

  /** Copy entities and their descendants; selects the copies. */
  duplicateEntities(ids: readonly number[]): number[] {
    const copies: number[] = [];
    this.edit(
      `Duplicate ${
        ids.length === 1 ? this.nameOf(ids[0]) : `${ids.length} entities`
      }`,
      (world, names) => {
        const remap = new Map<number, number>();
        const roots = new Set(ids);
        const subtree = (id: number): number[] => [
          id,
          ...world.entities.filter((e) => e.parent === id).flatMap((e) =>
            subtree(e.id)
          ),
        ];
        const sources = ids.filter((id) => {
          // Skip ids already inside another duplicated subtree.
          let parent = world.entities.find((e) => e.id === id)?.parent ?? 0;
          while (parent) {
            if (roots.has(parent)) return false;
            parent = world.entities.find((e) => e.id === parent)?.parent ?? 0;
          }
          return true;
        });
        for (const root of sources) {
          for (const id of subtree(root)) remap.set(id, world.nextEntity++);
        }
        for (const [from, to] of remap) {
          const source = world.entities.find((e) => e.id === from)!;
          world.entities.push({
            id: to,
            parent: remap.get(source.parent) ?? source.parent,
            components: structuredClone(source.components),
          });
          const name = names.get(from);
          if (name) names.set(to, roots.has(from) ? `${name} copy` : name);
          if (roots.has(from)) copies.push(to);
        }
      },
    );
    this.select(copies);
    return copies;
  }

  /** Complete components written like a scene file: asset paths or ids,
   * missing fields filled with defaults, unknown components dropped. */
  #components(
    raw: Record<string, unknown>,
  ): WorldModel["entities"][number]["components"] {
    const problems: string[] = [];
    const out = Object.fromEntries(
      Object.entries(raw).flatMap(([name, value]) => {
        const record = this.schema.component(name);
        if (!record) problems.push(`component "${name}" is not in the schema`);
        return record
          ? [[
            name,
            recordFromScene(this.schema, record, value, this.catalog, problems),
          ]]
          : [];
      }),
    );
    for (const problem of problems) this.#log("warn", "session", problem);
    return out;
  }

  /** Set a component from scene-style values (missing fields take defaults). */
  setComponent(id: number, component: string, value: Record<string, unknown>) {
    this.edit(`Edit ${component}`, (world) => {
      const entity = world.entities.find((e) => e.id === id);
      if (!entity) throw new Error(`no entity ${id}`);
      Object.assign(
        entity.components,
        this.#components({ [component]: value }),
      );
    });
  }

  removeComponent(id: number, component: string) {
    this.edit(`Remove ${component}`, (world) => {
      const entity = world.entities.find((e) => e.id === id);
      if (entity) delete entity.components[component];
    });
  }

  rename(id: number, name: string) {
    this.edit(`Rename ${this.nameOf(id)}`, (_, names) => {
      if (name.trim()) names.set(id, name.trim());
      else names.delete(id);
    });
  }

  /** Move entities under `parent` (0 for the root), before `before` if given.
   * Refuses to make an entity its own ancestor. */
  reparent(ids: readonly number[], parent: number, before?: number) {
    this.edit("Reparent", (world) => {
      const parentOf = (id: number) =>
        world.entities.find((e) => e.id === id)?.parent ?? 0;
      for (const id of ids) {
        for (let p = parent; p; p = parentOf(p)) {
          if (p === id) throw new Error("an entity cannot be its own ancestor");
        }
      }
      const moving = world.entities.filter((e) => ids.includes(e.id));
      const rest = world.entities.filter((e) => !ids.includes(e.id));
      for (const e of moving) e.parent = parent;
      const at = before === undefined
        ? -1
        : rest.findIndex((e) => e.id === before);
      if (at < 0) rest.push(...moving);
      else rest.splice(at, 0, ...moving);
      world.entities = rest;
    });
  }

  // Selection ---------------------------------------------------------------------

  select(
    ids: readonly number[],
    how: "replace" | "add" | "toggle" = "replace",
  ) {
    let next: number[];
    if (how === "replace") next = [...new Set(ids)];
    else if (how === "add") next = [...new Set([...this.selection, ...ids])];
    else {
      const set = new Set(this.selection);
      for (const id of ids) set.has(id) ? set.delete(id) : set.add(id);
      next = [...set];
    }
    if (
      next.length === this.selection.length &&
      next.every((id, i) => id === this.selection[i])
    ) return;
    this.selection = next;
    this.#changed();
  }

  hover(id: number) {
    if (id === this.hovered) return;
    this.hovered = id;
    this.#changed();
  }

  // Play --------------------------------------------------------------------------

  /** Install a shared post-start state. The driver records every corrected step. */
  drivePlay(
    driver: PlayDriver,
    state: Float32Array,
    names = new Map(this.document.names),
  ) {
    decodeWorld(this.schema, state);
    this.stop();
    if (this.#transaction) this.#commitTransaction();
    this.#driver = driver;
    this.#live = {
      state: state.slice(),
      names: new Map(names),
      schema: this.schema,
      catalog: this.catalog,
    };
    this.mode = "play";
    this.paused = false;
    this.#viewTick = null;
    this.#time = this.tick * this.dt;
    this.#accumulator = 0;
    this.input.reset();
    this.timeline.reset(this.#keyframe(this.#live));
    this.#changed();
  }

  /** Retain corrected inputs/keyframes in the ordinary replay and hand-off timeline. */
  applyDrivenFrame(
    driver: PlayDriver,
    input: InputModel,
    before: Float32Array,
    result: StepResult,
  ) {
    if (this.#driver !== driver || !this.#live) {
      throw new Error("play driver is detached");
    }
    const frame = { ...this.#live, state: before };
    if (input.tick !== this.timeline.last) {
      this.timeline.branch(this.#keyframe(frame));
    }
    this.timeline.record(input.tick, () => this.#keyframe(frame), input);
    this.#live = { ...this.#live, state: result.state };
    this.#time = this.tick * this.dt;
    this.#viewTick = null;
    this.#changed();
  }

  /** Drivers emit confirmed events once; replayed predictions never duplicate audio. */
  presentDrivenEvents(driver: PlayDriver, events: EventModel[], tick: number) {
    if (this.#driver === driver) this.#dispatch(events, tick);
  }

  /** Leave a driven game paused, retaining its corrected replay for inspection. */
  releaseDriver(driver: PlayDriver) {
    if (this.#driver !== driver) return;
    this.#driver = null;
    this.paused = true;
    this.#accumulator = 0;
    this.input.releaseAll();
    this.#changed();
  }

  play(options: { start?: boolean; time?: number } = {}) {
    if (this.#live) {
      this.resume();
      return;
    }
    if (this.#transaction) this.#commitTransaction();
    const document = this.#document;
    let live: Snapshot = {
      ...document,
      state: document.state.slice(),
      names: new Map(document.names),
    };
    this.mode = "play";
    this.paused = false;
    this.#time = options.time ?? this.worldOf(live).tick * this.dt;
    this.#accumulator = 0;
    this.#viewTick = null;
    if (
      this.canStep && this.#game!.hasStart &&
      (options.start ?? this.worldOf(live).tick === 0)
    ) {
      const tick = live.state[1];
      const input = this.input.sample(tick, 0, 0);
      try {
        const result = this.#game!.start(live.state, input);
        result.state[1] = tick;
        live = { ...live, state: result.state };
        this.#dispatch(result.events, tick);
      } catch (error) {
        this.paused = true;
        this.#log("error", "game", `start trapped: ${errorText(error)}`);
      }
    } else if (!this.canStep) {
      this.paused = true;
      this.#log("warn", "session", "no game is loaded yet; play is paused");
    }
    this.#live = live;
    this.timeline.reset(this.#keyframe(live));
    this.#log("info", "session", "play");
    this.#changed();
  }

  pause() {
    if (this.#driver) return;
    if (!this.#live || this.paused) return;
    this.paused = true;
    this.#changed();
  }

  resume() {
    if (this.#driver) return;
    if (!this.#live || !this.paused) return;
    this.paused = false;
    this.#accumulator = 0;
    this.#changed();
  }

  togglePause() {
    if (this.paused) this.resume();
    else this.pause();
  }

  stop() {
    const driver = this.#driver;
    this.#driver = null;
    driver?.dispose();
    if (!this.#live) return;
    if (this.#transaction) this.#commitTransaction();
    this.#live = null;
    this.frameEvents = [];
    this.mode = "edit";
    this.paused = false;
    this.#viewTick = null;
    this.#undo = this.#undo.filter((e) => e.target === "document");
    this.#redo = this.#redo.filter((e) => e.target === "document");
    this.timeline.reset(this.#keyframe(this.#document));
    const alive = new Set(this.documentWorld.entities.map((e) => e.id));
    this.selection = this.selection.filter((id) => alive.has(id));
    this.#log("info", "session", "stop");
    this.#changed();
  }

  restart() {
    this.stop();
    this.play();
  }

  /** Advance by wall-clock `seconds` in fixed steps. Call once per frame. */
  advance(seconds: number): boolean {
    if (this.#driver) return this.#driver.advance(seconds);
    if (!this.#live || this.paused || !this.canStep) return false;
    this.#accumulator += Math.min(seconds, 0.25);
    let steps = 0;
    while (this.#accumulator >= this.dt && steps < 8) {
      this.#accumulator -= this.dt;
      if (!this.#stepOnce()) break;
      steps++;
    }
    if (steps > 0) this.#changed();
    return steps > 0;
  }

  /** One step while paused. */
  stepFrame(recorded?: InputModel) {
    if (this.#driver) return;
    if (!this.#live || !this.canStep) return;
    this.paused = true;
    this.#stepOnce(recorded);
    this.#changed();
  }

  #stepOnce(recorded?: InputModel): boolean {
    const live = this.#live!;
    const tick = live.state[1];
    const input = recorded
      ? { ...structuredClone(recorded), tick, dt: this.dt, time: this.#time }
      : this.input.sample(tick, this.dt, this.#time);
    this.timeline.record(tick, () => this.#keyframe(live), input);
    this.#viewTick = null;
    let result: StepResult;
    try {
      result = this.#game!.step(live.state, input);
    } catch (error) {
      this.paused = true;
      this.#log("error", "game", `step ${tick} trapped: ${errorText(error)}`);
      return false;
    }
    result.state[1] = tick + 1;
    this.#live = { ...live, state: result.state };
    this.#time += this.dt;
    this.#dispatch(result.events, tick);
    return true;
  }

  /** Rebuild the live world at an earlier (or recorded later) tick by
   * replaying inputs from the nearest keyframe with the current game. */
  seek(tick: number) {
    if (this.#driver) return;
    if (!this.#live || !this.canStep) return;
    const keyframe = this.timeline.nearest(tick);
    if (!keyframe) return;
    this.paused = true;
    let state: Float32Array = this.#migrate({
      ...keyframe,
      names: this.#live.names,
    })
      .state.slice();
    for (let t = keyframe.tick; t < tick; t++) {
      const input = this.timeline.input(t);
      if (!input) break;
      try {
        state = this.#game!.step(state, input).state;
        state[1] = t + 1;
      } catch (error) {
        this.#log("error", "game", `replay ${t} trapped: ${errorText(error)}`);
        break;
      }
    }
    this.#live = { ...this.#live, state };
    this.#viewTick = state[1];
    this.#time = this.timeline.input(state[1])?.time ??
      ((this.timeline.input(state[1] - 1)?.time ?? -this.dt) + this.dt);
    this.#accumulator = 0;
    this.#changed();
  }

  /** Copy the live world (or some entities of it) into the document. */
  applyToDocument(ids?: readonly number[]) {
    if (!this.#live) return;
    const live = this.world;
    const liveNames = this.#live.names;
    const target = this.#document;
    const before = target;
    const world = structuredClone(this.worldOf(target));
    const names = new Map(target.names);
    if (!ids) {
      world.entities = structuredClone(live.entities);
      world.resources = structuredClone(live.resources);
      world.nextEntity = Math.max(world.nextEntity, live.nextEntity);
      for (const [id, name] of liveNames) names.set(id, name);
    } else {
      for (const id of ids) {
        const source = live.entities.find((e) => e.id === id);
        if (!source) continue;
        const index = world.entities.findIndex((e) => e.id === id);
        if (index >= 0) world.entities[index] = structuredClone(source);
        else world.entities.push(structuredClone(source));
        world.nextEntity = Math.max(world.nextEntity, id + 1);
      }
    }
    const after: Snapshot = {
      state: encodeWorld(this.schema, world),
      names,
      schema: this.schema,
      catalog: this.catalog,
    };
    this.#document = after;
    this.#record(
      ids ? `Apply ${ids.length} from play` : "Apply play to scene",
      "document",
      before,
      after,
    );
    this.dirty = true;
    this.#log(
      "info",
      "session",
      ids
        ? `applied ${ids.length} entities to the scene`
        : "applied the play world to the scene",
    );
    this.#changed();
  }

  #keyframe(snapshot: Snapshot): Keyframe {
    return {
      tick: snapshot.state[1],
      state: snapshot.state,
      schema: snapshot.schema,
      catalog: snapshot.catalog,
    };
  }

  #dispatch(events: EventModel[], tick: number) {
    this.frameEvents = events;
    if (events.length === 0) return;
    for (const event of events) {
      const text = eventText(this.schema, event, this.locale);
      if (text !== undefined) this.#log("game", "game", text);
    }
    for (const listener of this.#eventListeners) listener(events, tick);
  }

  // Game and project changes ----------------------------------------------------

  setGame(game: GameInstance, info: { revision: number; ms?: number }) {
    if (this.#driver) this.stop();
    const previous = this.#game;
    this.#game = game;
    this.#gameStale = false;
    previous?.dispose();
    this.status = { kind: "ready", revision: info.revision, ms: info.ms };
    if (this.#live) {
      this.timeline.mark({
        tick: this.tick,
        kind: "reload",
        label: `rev ${info.revision}`,
      });
    }
    this.#log(
      "info",
      "build",
      `game rev ${info.revision}${
        info.ms !== undefined ? ` · ${Math.round(info.ms)} ms` : ""
      }`,
    );
    this.#changed();
  }

  setBuilding() {
    const revision = this.status.kind === "ready"
      ? this.status.revision
      : undefined;
    this.status = { kind: "building", revision };
    this.#changed();
  }

  setBuildErrors(diagnostics: Diagnostic[]) {
    const revision = this.status.kind === "ready"
      ? this.status.revision
      : this.status.kind === "error"
      ? this.status.revision
      : undefined;
    this.status = { kind: "error", diagnostics, revision };
    for (const d of diagnostics) {
      this.#log(
        "error",
        "build",
        `${shortPath(d.file)}:${d.line}:${d.column} ${d.message}`,
        d.excerpt,
      );
    }
    this.#changed();
  }

  /** Adopt a new schema and/or catalog. Worlds migrate by field name; the
   * game waits for a build made against the new layout. */
  setProject(schema: Schema, catalog: Catalog) {
    if (schema === this.schema && catalog === this.catalog) return;
    if (this.#driver) this.stop();
    const layoutChanged = schema.hash !== this.schema.hash ||
      JSON.stringify(catalog) !== JSON.stringify(this.catalog);
    const problems: string[] = [];
    const move = (snapshot: Snapshot): Snapshot => {
      const moved = migrateWorld(
        { schema: snapshot.schema, catalog: snapshot.catalog },
        { schema, catalog },
        this.worldOf(snapshot),
        snapshot.names,
      );
      problems.push(...moved.problems);
      const state = encodeWorld(schema, moved.world);
      state[1] = snapshot.state[1];
      return { state, names: moved.names, schema, catalog };
    };
    this.#document = move(this.#document);
    if (this.#live) {
      this.#live = move(this.#live);
      this.timeline.mark({ tick: this.tick, kind: "schema", label: "schema" });
    }
    this.schema = schema;
    if (this.locale !== schema.defaultLocale && !schema.locales[this.locale]) {
      this.locale = schema.defaultLocale;
    }
    this.catalog = catalog;
    this.input.schema = schema;
    if (layoutChanged) this.#gameStale = true;
    // "entity 12 coin.sparkle: not in schema, dropped" for every entity is
    // noise during a schema edit; say it once per field.
    const counts = new Map<string, number>();
    for (const problem of problems) {
      const key = problem.replace(/^entity \d+ /, "");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [problem, count] of [...counts].slice(0, 20)) {
      this.#log(
        "info",
        "dev",
        count > 1 ? `${problem} (${count} entities)` : problem,
      );
    }
    this.#log(
      "info",
      "dev",
      layoutChanged ? "schema changed; worlds migrated" : "project updated",
    );
    this.#changed();
  }

  // Scenes ------------------------------------------------------------------------

  loadScene(scene: SceneFile, name = this.sceneName) {
    if (this.#live) this.stop();
    this.#document = this.#snapshotOf(scene);
    this.#undo = [];
    this.#redo = [];
    this.dirty = false;
    this.pendingScene = null;
    this.sceneName = name;
    const alive = new Set(this.documentWorld.entities.map((e) => e.id));
    this.selection = this.selection.filter((id) => alive.has(id));
    this.timeline.reset(this.#keyframe(this.#document));
    this.#log("info", "session", `opened ${name}`);
    this.#changed();
  }

  /** A scene file changed on disk (another tool, an agent). Applied as an
   * undoable edit unless the document has unsaved changes. */
  sceneChangedOnDisk(scene: SceneFile) {
    if (this.dirty) {
      this.pendingScene = scene;
      this.#log(
        "warn",
        "dev",
        `${this.sceneName} changed on disk; you have unsaved edits`,
      );
      this.#changed();
      return;
    }
    const before = this.#document;
    const after = this.#snapshotOf(scene);
    after.state[1] = before.state[1];
    if (
      sameState(before.state, after.state) &&
      sameNames(before.names, after.names)
    ) return;
    this.#document = after;
    this.#record("Change on disk", "document", before, after);
    this.#log("info", "dev", `${this.sceneName} reloaded from disk`);
    this.#changed();
  }

  acceptPendingScene() {
    if (!this.pendingScene) return;
    const scene = this.pendingScene;
    this.pendingScene = null;
    this.dirty = false;
    this.sceneChangedOnDisk(scene);
  }

  toScene(snapshot: Snapshot = this.#document): SceneFile {
    return worldToScene(
      snapshot.schema,
      this.worldOf(snapshot),
      snapshot.names,
      snapshot.catalog,
    );
  }

  markSaved() {
    this.dirty = false;
    this.#changed();
  }

  // Comments ----------------------------------------------------------------------

  /** Replace comments with what is on disk (no persistence callback). */
  setComments(comments: readonly Comment[]) {
    this.comments = comments;
    this.#changed();
  }

  addComment(
    comment:
      & Omit<Comment, "id" | "created" | "status">
      & Partial<Pick<Comment, "id" | "created" | "status">>,
  ): Comment {
    const full: Comment = {
      ...comment,
      id: comment.id ?? commentId(),
      created: comment.created ?? new Date().toISOString(),
      status: comment.status ?? "open",
    };
    this.#setComments([...this.comments, full]);
    return full;
  }

  updateComment(id: string, patch: Partial<Comment>) {
    if (!this.comments.some((c) => c.id === id)) {
      throw new Error(`no comment ${id}`);
    }
    this.#setComments(
      this.comments.map((c) => (c.id === id ? { ...c, ...patch, id } : c)),
    );
  }

  replyToComment(id: string, reply: NonNullable<Comment["replies"]>[number]) {
    const comment = this.comments.find((c) => c.id === id);
    if (!comment) throw new Error(`no comment ${id}`);
    this.updateComment(id, { replies: [...(comment.replies ?? []), reply] });
  }

  removeComment(id: string) {
    this.#setComments(this.comments.filter((c) => c.id !== id));
  }

  #setComments(comments: readonly Comment[]) {
    this.comments = comments;
    for (const listener of this.#commentListeners) listener(comments);
    this.#changed();
  }

  // Console -----------------------------------------------------------------------

  info(text: string, source: LogEntry["source"] = "session") {
    this.#log("info", source, text);
    this.#changed();
  }

  warn(text: string, source: LogEntry["source"] = "session") {
    this.#log("warn", source, text);
    this.#changed();
  }

  error(text: string, source: LogEntry["source"] = "session", detail?: string) {
    this.#log("error", source, text, detail);
    this.#changed();
  }

  clearLog() {
    this.log = [];
    this.#changed();
  }

  #log(
    level: LogEntry["level"],
    source: LogEntry["source"],
    text: string,
    detail?: string,
  ) {
    const entry: LogEntry = {
      id: ++this.#logId,
      time: Date.now(),
      tick: this.#live ? this.#live.state[1] : this.#document.state[1],
      mode: this.mode,
      level,
      source,
      text,
      detail,
    };
    const log = [...this.log, entry];
    this.log = log.length > LOG_LIMIT ? log.slice(log.length - LOG_LIMIT) : log;
  }

  dispose() {
    this.#driver?.dispose();
    this.#driver = null;
    this.#game?.dispose();
    this.#game = null;
    this.#listeners.clear();
    this.#eventListeners.clear();
    this.#commentListeners.clear();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortPath(path: string): string {
  const parts = path.split("/");
  return parts.slice(-2).join("/");
}

function sameState(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameNames(
  a: ReadonlyMap<number, string>,
  b: ReadonlyMap<number, string>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, name] of a) if (b.get(id) !== name) return false;
  return true;
}
