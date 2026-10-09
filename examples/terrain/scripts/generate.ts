/**
 * Regenerates everything under examples/terrain/assets/ and scenes/: ground
 * textures, scatter meshes, the heightfield, the placements and the scene.
 * Deterministic: a second run writes the same bytes.
 *
 *   deno task gen:terrain
 */
import { writeTextures } from "./textures.ts";
import { writeMeshes } from "./meshes.ts";
import { writeTerrain } from "./terrain.ts";
import { writeScatter } from "./scatter.ts";
import { writeScene } from "./scene.ts";

const started = performance.now();
await writeTextures();
await writeMeshes();
await writeTerrain();
await writeScatter();
await writeScene();
console.log(`done in ${((performance.now() - started) / 1000).toFixed(1)} s`);
