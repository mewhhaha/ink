/**
 * Small external stores for presentation state that is not game state: the
 * editor layout, tools, comment mode, editor cameras. Persisted per project
 * in localStorage so a reload (or a hot reload of the page) lands where you
 * were.
 */
import { useSyncExternalStore } from "react";

export class Store<T extends object> {
  #value: T;
  #listeners = new Set<() => void>();
  constructor(initial: T, readonly key?: string) {
    let restored: Partial<T> = {};
    if (key) {
      try {
        restored = JSON.parse(localStorage.getItem(key) ?? "{}");
      } catch {
        // ignore unreadable storage
      }
    }
    this.#value = { ...initial, ...restored };
  }
  get = (): T => this.#value;
  set = (patch: Partial<T> | ((value: T) => Partial<T>)) => {
    const next = typeof patch === "function" ? patch(this.#value) : patch;
    this.#value = { ...this.#value, ...next };
    if (this.key) {
      try {
        localStorage.setItem(this.key, JSON.stringify(this.#value));
      } catch {
        // storage full or blocked; state still works in memory
      }
    }
    for (const listener of this.#listeners) listener();
  };
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
}

export function useStore<T extends object, U>(
  store: Store<T>,
  select: (value: T) => U,
): U {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

export type Tool = "select" | "move" | "rotate" | "scale";

export interface UiState {
  /** "editor" shows the tools; "game" is the game alone, full screen. */
  layout: "editor" | "game";
  tool: Tool;
  /** Clicking in a viewport pins a comment instead of selecting. */
  commenting: boolean;
  snap: boolean;
  grid: number;
  angleSnap: number;
  space: "world" | "local";
  palette: boolean;
  handoff: boolean;
  /** Pane sizes by id, in pixels. */
  sizes: Record<string, number>;
}

export const defaultUi: UiState = {
  layout: "editor",
  tool: "move",
  commenting: false,
  snap: true,
  grid: 0.5,
  angleSnap: 15,
  space: "world",
  palette: false,
  handoff: false,
  sizes: {},
};
