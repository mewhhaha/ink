/** Atlas files (`*.atlas.json`) fetched and parsed on demand. A change in the
 * file, the text parser's result or the image it names reaches views through
 * the asset store's change notification. */
import { type Atlas, parseAtlas } from "@ink/schema";

interface Entry {
  state: "loading" | "ready" | "failed";
  atlas?: Atlas;
  token: number;
  /** When the last load failed, and what it said (to warn once). */
  failedAt?: number;
  error?: string;
}

/** A missing or broken file is asked for again this often while drawn. */
const RETRY_MS = 1000;

export class AtlasStore {
  private entries = new Map<string, Entry>();
  constructor(
    private url: (path: string, bust: boolean) => string,
    private changed: () => void,
    private track: (work: Promise<void>) => Promise<void>,
  ) {}

  /** The atlas once loaded; starts loading it on first use. */
  get(path: string): Atlas | undefined {
    let entry = this.entries.get(path);
    if (!entry) {
      entry = { state: "loading", token: 0 };
      this.entries.set(path, entry);
      void this.track(this.load(path, false));
    } else if (
      entry.state === "failed" && Date.now() - (entry.failedAt ?? 0) > RETRY_MS
    ) {
      // The file may have appeared since (an atlas added after its users).
      entry.state = "loading";
      void this.track(this.load(path, true));
    }
    return entry.atlas;
  }

  /** Register an atlas without fetching, for headless runs and tests. */
  set(path: string, atlas: Atlas): void {
    const entry = this.entries.get(path);
    if (entry) {
      entry.atlas = atlas;
      entry.state = "ready";
      entry.token++;
    } else this.entries.set(path, { state: "ready", atlas, token: 0 });
    this.changed();
  }

  reload(path: string): void {
    if (this.entries.has(path)) void this.track(this.load(path, true));
  }

  private async load(path: string, bust: boolean): Promise<void> {
    const entry = this.entries.get(path)!;
    const token = ++entry.token;
    try {
      const response = await fetch(this.url(path, bust));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const atlas = parseAtlas(await response.text(), path);
      if (entry.token !== token) return;
      entry.atlas = atlas;
      entry.state = "ready";
      entry.error = undefined;
    } catch (error) {
      if (entry.token !== token) return;
      // Keep showing the last good atlas while a broken edit is being fixed.
      if (entry.state !== "ready") entry.state = "failed";
      entry.failedAt = Date.now();
      const message = String(error);
      if (entry.error !== message) {
        console.warn(`ink: could not load atlas "${path}": ${message}`);
      }
      entry.error = message;
      return;
    }
    this.changed();
  }
}
