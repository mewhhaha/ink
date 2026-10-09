/** Mounts `WorldSync` for an editor: undo, redo and the timeline move the
 * terrain and scatter data with the scene, and edits are saved to disk. */
import { useEffect } from "react";
import { useInk } from "@ink/react";
import { WorldSync } from "./sync.ts";

/** Follow the session: keep terrain and scatter data at the revision the
 * scene records, and save every edit to its asset file through the dev
 * server (`save: false` keeps edits in memory only). */
export function useTerrainSync(options: { save?: boolean } = {}): void {
  const ink = useInk();
  const assets = ink.renderer?.assets;
  const sink = options.save === false ? undefined : ink.dev?.client;
  useEffect(() => {
    if (!assets) return;
    return new WorldSync(ink.session, assets, {
      sink,
      save: {
        onError: (error) =>
          ink.session.error(`could not save terrain data: ${error}`, "dev"),
      },
    }).start();
  }, [ink.session, assets, sink]);
}

/** Renders nothing; mount once inside `<InkApp>` (`<TerrainToolbar>` does). */
export function TerrainSync(props: { save?: boolean }): null {
  useTerrainSync(props);
  return null;
}
