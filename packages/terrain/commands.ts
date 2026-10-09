import type { Command } from "@ink/react";
import { rebuildCollisionGrids } from "./edit.ts";
import { worldRefs } from "./world.ts";

/** Commands for the command palette: pass them to `<InkApp commands>`. */
export const terrainCommands: Command[] = [
  {
    id: "terrain-rebuild-grid",
    label: "Rebuild terrain collision grid",
    icon: "mountain",
    group: "Terrain",
    enabled: (ink) =>
      !!ink.renderer &&
      worldRefs(ink.session.world, ink.session.catalog).terrains.length > 0,
    run(ink) {
      if (!ink.renderer) return;
      // The selected terrains, or all of them when none is selected.
      const terrains = worldRefs(ink.session.world, ink.session.catalog)
        .terrains.map((t) => t.entity);
      const selected = ink.session.selection.filter((id) =>
        terrains.includes(id)
      );
      const count = rebuildCollisionGrids(
        ink.session,
        ink.renderer.assets,
        selected.length ? selected : undefined,
      );
      ink.session.info(
        count
          ? `rebuilt the collision grid of ${count} terrain${
            count > 1 ? "s" : ""
          }`
          : "no terrain data is loaded yet",
        "session",
      );
    },
  },
];
