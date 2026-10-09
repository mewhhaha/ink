/** Terrain and scatter regressions shared by Deno and the Chromium smoke
 * test. Each check renders a procedural world (terrain_fixture.ts), asserts
 * on pixels, picks and counters, and returns a picture to look at. */
import { terrainHeightAt } from "@ink/geometry";
import { lookAtCamera } from "./camera.ts";
import type { PixelData, Renderer } from "./types.ts";
import {
  forest,
  hills,
  installScatter,
  installTerrain,
  layerTextures,
  scatterDraw,
  terrainDraw,
  worldScene,
} from "./terrain_fixture.ts";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const W = 800, H = 450;
const params = (size: number, detail = terrainDraw(size).detail) => ({
  size,
  heightScale: 1,
  detail,
});

function differing(a: PixelData, b: PixelData, tolerance = 3): number {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      Math.abs(a.data[i] - b.data[i]) +
          Math.abs(a.data[i + 1] - b.data[i + 1]) +
          Math.abs(a.data[i + 2] - b.data[i + 2]) > tolerance
    ) n++;
  }
  return n;
}

export interface TerrainCheck {
  name: string;
  run(renderer: Renderer): Promise<PixelData>;
}

export const terrainChecks: TerrainCheck[] = [
  {
    name: "terrain renders lit and textured, repeating exactly",
    async run(renderer) {
      layerTextures(renderer);
      installTerrain(renderer, hills(256, 512));
      const scene = worldScene([terrainDraw(512)]);
      const view = renderer.createView({ width: W, height: H });
      try {
        const camera = lookAtCamera(
          [-180, 90, 220],
          [0, 10, 0],
          { far: 2000 },
          W / H,
        );
        const options = { still: true, quality: "high" as const };
        view.render(scene, camera, options);
        const a = await view.readPixels();
        view.render(scene, camera, options);
        const b = await view.readPixels();
        check(
          differing(a, b, 0) === 0,
          "terrain frames differ between repeats",
        );
        check(
          view.stats.terrainPatches > 8,
          `${view.stats.terrainPatches} patches`,
        );
        let ground = 0;
        const colors = new Set<number>();
        for (let i = 0; i < a.data.length; i += 4) {
          if (a.data[i + 1] > a.data[i + 2] + 8) ground++;
          colors.add(
            ((a.data[i] >> 3) << 10) | ((a.data[i + 1] >> 3) << 5) |
              (a.data[i + 2] >> 3),
          );
        }
        check(ground > W * H * 0.2, `ground covers ${ground} pixels`);
        check(colors.size > 150, `${colors.size} colours`);
        return a;
      } finally {
        view.dispose();
      }
    },
  },
  {
    name: "picking the terrain returns its entity and the CPU height",
    async run(renderer) {
      layerTextures(renderer);
      const field = hills(256, 512);
      installTerrain(renderer, field);
      // Large-wavelength detail: every octave is resolved at the finest level.
      const draw = terrainDraw(512, {
        detail: { seed: 3, amplitude: 0.5, wavelength: 96, octaves: 2 },
      });
      const view = renderer.createView({ width: W, height: H });
      try {
        const camera = lookAtCamera(
          [-60, 60, 90],
          [0, 10, 0],
          { far: 2000 },
          W / H,
        );
        view.render(worldScene([draw]), camera, { still: true });
        const hit = await view.pick(W / 2, H * 0.75);
        check(hit?.entity === 77, `picked ${hit?.entity}`);
        const expected = terrainHeightAt(
          field,
          params(512, draw.detail),
          hit!.point[0],
          hit!.point[2],
        );
        check(
          Math.abs(hit!.point[1] - expected) < 0.6,
          `height ${hit!.point[1]} against CPU ${expected}`,
        );
        check(hit!.normal[1] > 0.2, "normal points down");
        return await view.readPixels();
      } finally {
        view.dispose();
      }
    },
  },
  {
    name: "terrain levels meet without cracks",
    async run(renderer) {
      layerTextures(renderer);
      installTerrain(renderer, hills(512, 1024, { height: 120 }));
      const scene = worldScene([terrainDraw(1024, { lodDistance: 64 })]);
      const view = renderer.createView({ width: W, height: H });
      try {
        let last!: PixelData;
        // Looking down on the whole terrain from several heights and places:
        // anything missing between patches would show the magenta clear colour.
        for (
          const [x, y, z] of [[0, 900, 1], [200, 380, 300], [-300, 150, -350]]
        ) {
          const camera = lookAtCamera([x, y, z], [x * 0.5, 0, z * 0.5 + 1], {
            far: 4000,
            fov: 70,
          }, W / H);
          view.render(scene, camera, {
            still: true,
            background: [1, 0, 1, 1],
            environment: { fogDensity: 0 },
          });
          last = await view.readPixels();
          let holes = 0;
          for (let i = 0; i < last.data.length; i += 4) {
            if (
              last.data[i] > 200 && last.data[i + 1] < 60 &&
              last.data[i + 2] > 200
            ) holes++;
          }
          // The terrain edge and the horizon may show the clear colour; the
          // middle of the frame is all ground.
          let middle = 0;
          for (let y2 = H * 0.5; y2 < H * 0.9; y2++) {
            for (let x2 = W * 0.4; x2 < W * 0.6; x2++) {
              const k = (Math.floor(y2) * W + Math.floor(x2)) * 4;
              if (
                last.data[k] > 200 && last.data[k + 1] < 60 &&
                last.data[k + 2] > 200
              ) middle++;
            }
          }
          check(
            middle === 0,
            `${middle} background pixels inside the terrain from [${x},${y},${z}] (${holes} total)`,
          );
        }
        return last;
      } finally {
        view.dispose();
      }
    },
  },
  {
    name: "scatter instances follow the terrain and are culled",
    async run(renderer) {
      layerTextures(renderer);
      installTerrain(renderer, hills(256, 512));
      installScatter(renderer, forest(3500, 500, 5));
      const scene = worldScene([terrainDraw(512)], [
        scatterDraw({ maxDistance: 600 }),
      ]);
      const view = renderer.createView({ width: W, height: H });
      try {
        const camera = lookAtCamera(
          [-150, 70, 190],
          [0, 20, 0],
          { far: 2000 },
          W / H,
        );
        const options = { still: true, quality: "high" as const };
        const total = async () =>
          (await view.scatterCounts!())[0].counts[0].reduce((a, b) => a + b, 0);
        view.render(scene, camera, { ...options, culling: "none" });
        const all = await view.readPixels();
        const allCount = await total();
        view.render(scene, camera, { ...options, culling: "frustum" });
        const culled = await view.readPixels();
        const culledCount = await total();
        check(allCount === 3500, `${allCount} of 3500 kept without culling`);
        check(
          culledCount > 100 && culledCount < allCount,
          `${culledCount} kept by the frustum`,
        );
        const different = differing(all, culled);
        check(different < 200, `${different} pixels change when culling`);
        return culled;
      } finally {
        view.dispose();
      }
    },
  },
  {
    name: "scatter instances sit on the terrain in every list, level and chunk",
    async run(renderer) {
      layerTextures(renderer);
      const field = hills(512, 1024, { height: 120 });
      installTerrain(renderer, field);
      installScatter(renderer, forest(6000, 1000, 11, 6), "scatter/a.scatter");
      installScatter(renderer, forest(6000, 1000, 12, 2), "scatter/b.scatter");
      const draw = terrainDraw(1024, { lodDistance: 64 });
      const scene = worldScene([draw], [
        scatterDraw({
          entity: 88,
          placements: "scatter/a.scatter",
          maxDistance: 500,
        }),
        scatterDraw({
          entity: 89,
          placements: "scatter/b.scatter",
          maxDistance: 300,
          alignToGround: 0.6,
          mesh: "builtin:sphere",
        }),
      ]);
      const view = renderer.createView({ width: W, height: H });
      try {
        let last!: PixelData;
        let checked = 0;
        // The camera moves between far-apart places, so chunks stream in and
        // out; every kept instance, in every list and level, must stand on
        // the ground the terrain draws.
        for (const [x, z] of [[-400, -400], [380, 300], [-300, 350], [0, 0]]) {
          const y = terrainHeightAt(field, params(1024, draw.detail), x, z) +
            25;
          const camera = lookAtCamera([x, y, z], [x * 0.5, y - 10, z * 0.5], {
            far: 4000,
          }, W / H);
          for (let i = 0; i < 2; i++) {
            view.render(scene, camera, { still: true });
          }
          last = await view.readPixels();
          for (const layer of await view.scatterPositions!()) {
            for (const list of layer.positions) {
              for (const level of list) {
                for (let i = 0; i < level.length; i += 3) {
                  const expected = terrainHeightAt(
                    field,
                    params(1024, draw.detail),
                    level[i],
                    level[i + 2],
                  );
                  check(
                    Math.abs(level[i + 1] - expected) < 0.05,
                    `layer ${layer.entity} instance at ${
                      level[i].toFixed(1)
                    }, ${level[i + 2].toFixed(1)} is ${
                      level[i + 1].toFixed(2)
                    } but the ground is ${
                      expected.toFixed(2)
                    } (camera ${x}, ${z})`,
                  );
                  checked++;
                }
              }
            }
          }
        }
        check(checked > 2000, `only ${checked} instances checked`);
        return last;
      } finally {
        view.dispose();
      }
    },
  },
  {
    name: "occlusion culling drops instances hidden behind terrain",
    async run(renderer) {
      layerTextures(renderer);
      const field = hills(256, 512, { height: 140 });
      installTerrain(renderer, field);
      installScatter(renderer, forest(3500, 500, 9, 12));
      const eye = terrainHeightAt(field, params(512), -230, 230) + 4;
      const scene = worldScene([terrainDraw(512)], [
        scatterDraw({ maxDistance: 900 }),
      ]);
      const view = renderer.createView({ width: W, height: H });
      try {
        const camera = lookAtCamera([-230, eye, 230], [0, eye + 10, 0], {
          far: 2000,
        }, W / H);
        const keep = async (culling: "frustum" | "occlusion") => {
          view.render(scene, camera, { still: true, culling });
          view.render(scene, camera, { still: true, culling });
          const pixels = await view.readPixels();
          const counts = (await view.scatterCounts!())[0].counts[0].reduce(
            (a, b) => a + b,
            0,
          );
          return { pixels, counts };
        };
        const frustum = await keep("frustum");
        const occlusion = await keep("occlusion");
        check(
          occlusion.counts < frustum.counts * 0.9,
          `${occlusion.counts} kept with occlusion, ${frustum.counts} without`,
        );
        const different = differing(frustum.pixels, occlusion.pixels);
        check(different < 400, `${different} pixels change with occlusion`);
        return occlusion.pixels;
      } finally {
        view.dispose();
      }
    },
  },
  {
    name: "terrain edits appear at once, in place",
    async run(renderer) {
      layerTextures(renderer);
      const field = hills(256, 512);
      const resource = installTerrain(renderer, field);
      const scene = worldScene([terrainDraw(512)]);
      const view = renderer.createView({ width: W, height: H });
      try {
        const camera = lookAtCamera(
          [-120, 120, 160],
          [0, 20, 0],
          { far: 2000 },
          W / H,
        );
        view.render(scene, camera, { still: true });
        const before = await view.readPixels();
        // Raise a mound and paint it with layer 3.
        const stroke = resource.stroke({ x0: 118, z0: 118, x1: 138, z1: 138 });
        for (let z = 118; z < 138; z++) {
          for (let x = 118; x < 138; x++) {
            const d = Math.hypot(x - 128, z - 128) / 10;
            if (d < 1) field.heights[z * field.stride + x] += 25 * (1 - d * d);
          }
        }
        for (let z = 60; z < 68; z++) {
          for (let x = 60; x < 68; x++) {
            const at = (z * field.splatCells + x) * 4;
            field.splat[at] = 0;
            field.splat[at + 1] = 0;
            field.splat[at + 2] = 0;
            field.splat[at + 3] = 255;
          }
        }
        stroke.touch({ x0: 118, z0: 118, x1: 138, z1: 138 }, {
          x0: 56,
          z0: 56,
          x1: 70,
          z1: 70,
        });
        check(stroke.finish() !== null, "the stroke changed nothing");
        view.render(scene, camera, { still: true });
        const after = await view.readPixels();
        const changed = differing(before, after);
        check(changed > 300, `only ${changed} pixels changed after the edit`);
        // Undo restores the picture exactly.
        check(resource.seek(0), "seek failed");
        view.render(scene, camera, { still: true });
        const undone = await view.readPixels();
        check(
          differing(before, undone, 0) === 0,
          "undo did not restore the picture",
        );
        return after;
      } finally {
        view.dispose();
      }
    },
  },
  {
    name: "terrain and scatter work with temporal anti-aliasing and picking",
    async run(renderer) {
      layerTextures(renderer);
      installTerrain(renderer, hills(256, 512));
      installScatter(renderer, forest(2500, 500, 3));
      const scene = worldScene([terrainDraw(512)], [scatterDraw()]);
      const view = renderer.createView({ width: W, height: H });
      try {
        let last!: PixelData;
        for (let i = 0; i < 12; i++) {
          const camera = lookAtCamera([-160 + i * 0.5, 80, 200], [0, 20, 0], {
            far: 2000,
          }, W / H);
          view.render(scene, camera, { temporal: true, renderScale: 0.75 });
          last = await view.readPixels();
        }
        check(
          view.stats.temporalFrames >= 6,
          `${view.stats.temporalFrames} temporal frames`,
        );
        check(
          view.stats.renderWidth === 600,
          `render width ${view.stats.renderWidth}`,
        );
        let sum = 0;
        for (let i = 0; i < last.data.length; i += 4) sum += last.data[i + 1];
        check(sum / (last.data.length / 4) > 30, "the frame is black");
        const hit = await view.pick(W / 2, H * 0.85);
        check(
          hit?.entity === 77 || hit?.entity === 88,
          `picked ${hit?.entity}`,
        );
        return last;
      } finally {
        view.dispose();
      }
    },
  },
];
