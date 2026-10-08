/**
 * Plays `sound` events (the standard event: clip, volume, pitch, position,
 * spatial) with Web Audio. Spatial sounds pan by where they are relative to
 * the listener's view.
 */
import type { Catalog, EventModel } from "@ink/schema";

interface AudioSource {
  readonly catalog: Catalog;
  onEvents(listener: (events: EventModel[], tick: number) => void): () => void;
}
import { assetPath } from "@ink/schema";

export function connectAudio(
  session: AudioSource,
  url: (path: string) => string,
  listener?: () => {
    right: [number, number, number];
    position: [number, number, number];
  } | null,
): () => void {
  let context: AudioContext | null = null;
  const buffers = new Map<string, Promise<AudioBuffer | null>>();
  const unlock = () => {
    context ??= new AudioContext();
    if (context.state === "suspended") context.resume();
  };
  addEventListener("pointerdown", unlock);
  addEventListener("keydown", unlock);
  const load = (path: string) => {
    let buffer = buffers.get(path);
    if (!buffer) {
      buffer = fetch(url(path)).then((r) => r.arrayBuffer()).then((bytes) =>
        context!.decodeAudioData(bytes)
      ).catch(() => null);
      buffers.set(path, buffer);
    }
    return buffer;
  };
  const off = session.onEvents((events) => {
    if (!context) return;
    for (const event of events) {
      if (event.name !== "sound") continue;
      const value = event.value as {
        clip: number;
        volume: number;
        pitch: number;
        position: number[];
        spatial: boolean;
      };
      const path = assetPath(session.catalog, "sound", value.clip);
      if (!path) continue;
      load(path).then((buffer) => {
        if (!buffer || !context) return;
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = value.pitch || 1;
        const gain = context.createGain();
        gain.gain.value = value.volume;
        let node: AudioNode = gain;
        const view = value.spatial ? listener?.() : null;
        if (view) {
          const d = [0, 1, 2].map((i) => value.position[i] - view.position[i]);
          const distance = Math.hypot(d[0], d[1], d[2]) || 1;
          const across = (d[0] * view.right[0] + d[1] * view.right[1] +
            d[2] * view.right[2]) / distance;
          const panner = context.createStereoPanner();
          panner.pan.value = Math.max(-1, Math.min(1, across)) * 0.8;
          gain.gain.value = value.volume / (1 + Math.max(0, distance - 8) / 20);
          gain.connect(panner);
          node = panner;
        }
        source.connect(gain);
        node.connect(context.destination);
        source.start();
      });
    }
  });
  return () => {
    off();
    removeEventListener("pointerdown", unlock);
    removeEventListener("keydown", unlock);
    context?.close();
  };
}
