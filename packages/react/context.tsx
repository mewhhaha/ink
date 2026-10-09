/**
 * The Ink context: one session, one renderer, presentation stores, the frame
 * loop and the views on screen. Hooks read from it with fine-grained
 * subscriptions so a 60 Hz game does not re-render panels that did not change.
 */
import { createContext, useContext, useRef, useSyncExternalStore } from "react";
import { type CameraPose, epochNow, type Session } from "@ink/core";
import type { AssetStore, Renderer, RenderScene } from "@ink/render";
import { extractScene } from "@ink/render";
import type { EntityModel, RecordValue, WorldModel } from "@ink/schema";
import type { Store, UiState } from "./store.ts";
import type { DevConnection } from "./dev.ts";

/** A view registered by a mounted viewport, for captures and hand-offs. */
export interface ViewHandle {
  id: string;
  label: string;
  /** PNG data URL of the view as it is now. */
  capture(): Promise<string>;
  pose(): CameraPose | null;
  /** Project a world point to CSS pixels inside the viewport, or null. */
  project(point: [number, number, number]): [number, number] | null;
}

export class FrameLoop {
  #callbacks = new Set<(dt: number) => void>();
  #frame = 0;
  #last = 0;
  #drawSeconds = 0;
  #pending: Promise<void> | null = null;
  #ticking = false;
  #kicked = false;
  /** A change arrived while the GPU was busy: draw when it is free. */
  #wanted = false;
  #lastKick = 0;
  #unsubscribe: (() => void) | null = null;
  #ticks = 0;
  device: GPUDevice | null = null;
  constructor(readonly session: Session) {}

  /** Draw the views once, and follow the frame to the screen for a trace. */
  #draw(dt: number, started: number, stepEnd: number, stepped: boolean) {
    const profiler = this.session.profiler;
    for (const callback of this.#callbacks) callback(dt);
    const traced = profiler.tail({
      start: started,
      stepEnd,
      stepped,
      end: epochNow(),
    });
    // Pixels are on screen at the first animation frame after the GPU
    // finishes the work this draw submitted.
    const presented = () => {
      profiler.gpuDone();
      requestAnimationFrame(() => profiler.presented());
    };
    if (this.device) {
      const pending = this.device.queue.onSubmittedWorkDone();
      this.#pending = pending;
      const done = () => {
        if (this.#pending !== pending) return;
        this.#pending = null;
        if (this.#wanted && !this.#kicked) this.#kick();
      };
      pending.then(done, done);
      if (traced) pending.then(presented, () => {});
    } else if (traced) presented();
  }

  start() {
    const profiler = this.session.profiler;
    const tick = (now: number) => {
      const started = epochNow();
      profiler.beginTick();
      const dt = this.#last ? (now - this.#last) / 1000 : 0;
      if (this.#last) profiler.sample("frame", now - this.#last);
      this.#last = now;
      this.#ticking = true;
      const stepped = this.session.advance(dt);
      this.#ticking = false;
      const stepEnd = epochNow();
      this.#drawSeconds += dt;
      // Keep simulation/input responsive while a slow adapter finishes the
      // previous frame. Queuing every RAF can otherwise delay pixels for minutes.
      if (!this.#pending) {
        this.#wanted = false;
        const seconds = Math.min(this.#drawSeconds, 0.25);
        this.#drawSeconds = 0;
        this.#draw(seconds, started, stepEnd, stepped);
      }
      if (++this.#ticks % 15 === 0) profiler.flush();
      this.#frame = requestAnimationFrame(tick);
    };
    this.#frame = requestAnimationFrame(tick);
    // A change made between frames (an inspector field, a file reloaded from
    // disk) is drawn at once instead of waiting for the next animation frame:
    // the GPU works while the browser waits for the vsync, so the picture is
    // ready for the first one that can show it. Once per frame, never while
    // the previous frame is still on the GPU, and never for the session's own
    // steps, which the tick draws.
    this.#unsubscribe = this.session.subscribe(() => {
      if (this.#ticking || this.#kicked) return;
      if (this.#pending || performance.now() - this.#lastKick < 4) {
        this.#wanted = true;
      } else this.#kick();
    });
  }

  #kick() {
    // `#kicked` only coalesces changes made in one task.
    this.#kicked = true;
    this.#wanted = false;
    queueMicrotask(() => {
      this.#kicked = false;
      this.#lastKick = performance.now();
      if (this.#pending) return;
      const started = epochNow();
      this.session.profiler.beginTick();
      this.#draw(0, started, started, false);
    });
  }

  stop() {
    cancelAnimationFrame(this.#frame);
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#last = 0;
    this.#drawSeconds = 0;
  }

  /** Run every frame after the session advanced. */
  add(callback: (dt: number) => void): () => void {
    this.#callbacks.add(callback);
    return () => this.#callbacks.delete(callback);
  }
}

export interface Ink {
  session: Session;
  renderer: Renderer | null;
  ui: Store<UiState>;
  loop: FrameLoop;
  views: Map<string, ViewHandle>;
  dev: DevConnection | null;
  /** Project directory relative to the workspace, for commands in hand-offs. */
  project: string;
  title: string;
  /** Render scene of the world on screen, extracted once per state. */
  scene(): RenderScene;
}

export const InkContext = createContext<Ink | null>(null);

export function useInk(): Ink {
  const ink = useContext(InkContext);
  if (!ink) {
    throw new Error("Ink hooks need an <InkApp> or <InkProvider> above them");
  }
  return ink;
}

export function useSession(): Session {
  return useInk().session;
}

export function useRenderer(): Renderer | null {
  return useInk().renderer;
}

/** Subscribe to a value derived from the session. Re-renders only when the
 * selected value changes by `equal`. */
export function useSessionValue<T>(
  select: (session: Session) => T,
  equal: (a: T, b: T) => boolean = Object.is,
): T {
  const session = useSession();
  const cache = useRef<{ version: number; select: unknown; value: T } | null>(
    null,
  );
  const read = () => {
    const cached = cache.current;
    if (
      cached && cached.version === session.version && cached.select === select
    ) {
      return cached.value;
    }
    const value = select(session);
    if (cached && equal(cached.value, value)) {
      cached.version = session.version;
      cached.select = select;
      return cached.value;
    }
    cache.current = { version: session.version, select, value };
    return value;
  };
  return useSyncExternalStore(session.subscribe, read);
}

export const jsonEqual = <T,>(a: T, b: T) =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

export const arrayEqual = <T,>(a: readonly T[], b: readonly T[]) =>
  a === b || (a.length === b.length && a.every((x, i) => Object.is(x, b[i])));

export function useWorld(): WorldModel {
  return useSessionValue((s) => s.world);
}

export function useEntity(id: number | undefined): EntityModel | undefined {
  return useSessionValue(
    (
      s,
    ) => (id === undefined
      ? undefined
      : s.world.entities.find((e) => e.id === id)),
    jsonEqual,
  );
}

export function useComponent(
  id: number | undefined,
  component: string,
): RecordValue | undefined {
  return useSessionValue(
    (s) => s.world.entities.find((e) => e.id === id)?.components[component],
    jsonEqual,
  );
}

/** A world resource, e.g. a score for a HUD. */
export function useResource(name: string): RecordValue | undefined {
  return useSessionValue((s) => s.world.resources[name], jsonEqual);
}

export function useSelection(): readonly number[] {
  return useSessionValue((s) => s.selection);
}

export function useMode(): { mode: "edit" | "play"; paused: boolean } {
  return useSessionValue(
    (s) => ({ mode: s.mode, paused: s.paused }),
    jsonEqual,
  );
}

export function useUi<T>(select: (ui: UiState) => T): T {
  const store = useInk().ui;
  const cache = useRef<{ state: UiState; value: T } | null>(null);
  return useSyncExternalStore(store.subscribe, () => {
    const state = store.get();
    if (cache.current?.state === state) return cache.current.value;
    const value = select(state);
    if (cache.current && jsonEqual(cache.current.value, value)) {
      cache.current.state = state;
      return cache.current.value;
    }
    cache.current = { state, value };
    return value;
  });
}

/** Scene extraction cached by state identity, shared by every viewport. */
export function sceneCache(
  session: Session,
  assets?: () => AssetStore | undefined,
  hidden?: () => readonly number[],
): () => RenderScene {
  let state: Float32Array | null = null;
  let catalog: unknown = null;
  let scene: RenderScene | null = null;
  let events = -1;
  let assetsVersion = -1;
  let locale = "";
  let hiding: readonly number[] = [];
  return () => {
    const hide = hidden?.() ?? hiding;
    if (
      scene && state === session.state && catalog === session.catalog &&
      locale === session.locale && hiding === hide &&
      events === session.timeline.events.version &&
      assetsVersion === (assets?.()?.version ?? -1)
    ) {
      return scene;
    }
    const started = performance.now();
    state = session.state;
    catalog = session.catalog;
    events = session.timeline.events.version;
    assetsVersion = assets?.()?.version ?? -1;
    locale = session.locale;
    hiding = hide;
    scene = extractScene(session.world, session.catalog, {
      hidden: session.mode === "play" ? undefined : new Set(hide),
      dt: session.dt,
      events: session.presentationEvents,
      assets: assets?.(),
      text: (entity, message, a, b) =>
        message ? session.message(message, a, b) : session.names.get(entity) ??
          session.schema.names.find((n) =>
            n.id === session.world.entities.find((e) => e.id === entity)?.nameId
          )?.text ?? "",
    });
    session.profiler.spend("extract", performance.now() - started);
    return scene;
  };
}
