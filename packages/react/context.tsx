/**
 * The Ink context: one session, one renderer, presentation stores, the frame
 * loop and the views on screen. Hooks read from it with fine-grained
 * subscriptions so a 60 Hz game does not re-render panels that did not change.
 */
import { createContext, useContext, useRef, useSyncExternalStore } from "react";
import type { CameraPose, Session } from "@ink/core";
import type { Renderer, RenderScene } from "@ink/render";
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
  device: GPUDevice | null = null;
  constructor(readonly session: Session) {}
  start() {
    const tick = (now: number) => {
      const dt = this.#last ? (now - this.#last) / 1000 : 0;
      this.#last = now;
      this.session.advance(dt);
      this.#drawSeconds += dt;
      // Keep simulation/input responsive while a slow adapter finishes the
      // previous frame. Queuing every RAF can otherwise delay pixels for minutes.
      if (!this.#pending) {
        for (const callback of this.#callbacks) {
          callback(Math.min(this.#drawSeconds, 0.25));
        }
        this.#drawSeconds = 0;
        if (this.device) {
          const pending = this.device.queue.onSubmittedWorkDone();
          this.#pending = pending;
          const done = () => {
            if (this.#pending === pending) this.#pending = null;
          };
          pending.then(done, done);
        }
      }
      this.#frame = requestAnimationFrame(tick);
    };
    this.#frame = requestAnimationFrame(tick);
  }
  stop() {
    cancelAnimationFrame(this.#frame);
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
export function sceneCache(session: Session): () => RenderScene {
  let state: Float32Array | null = null;
  let catalog: unknown = null;
  let scene: RenderScene | null = null;
  let events = -1;
  return () => {
    if (
      scene && state === session.state && catalog === session.catalog &&
      events === session.timeline.events.version
    ) {
      return scene;
    }
    state = session.state;
    catalog = session.catalog;
    events = session.timeline.events.version;
    scene = extractScene(session.world, session.catalog, {
      dt: session.dt,
      events: session.presentationEvents,
    });
    return scene;
  };
}
