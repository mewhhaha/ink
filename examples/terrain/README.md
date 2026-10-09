# Terrain Lab

The gate scene for large worlds: a 2 km × 2 km heightfield (about 4.2 km²) with
100,000 scattered trees, rocks and grass clumps, edited and played in the
browser. The terrain tools and the `ink/terrain` game library plug into this
project.

The big binaries are generated, not committed. **Run this first:**

```sh
deno task gen:terrain          # about 20 s, deterministic
deno task ink dev examples/terrain
```

It writes `assets/terrain/world.terrain` (21 MB: 2049² heights at 1 m, a 1024²
splat map, four layers), the four `assets/scatter/*.scatter` placement files
(2.4 MB), the tileable ground textures and scatter meshes, and
`scenes/main.scene.json`. `world.terrain` and `*.scatter` are git-ignored; the
textures, meshes and the scene are committed and a second run rewrites them byte
for byte.

| Script                | Output                                                   |
| --------------------- | -------------------------------------------------------- |
| `scripts/world.ts`    | The land itself: noise, `elevation`, splat, start point  |
| `scripts/terrain.ts`  | `assets/terrain/world.terrain`                           |
| `scripts/textures.ts` | grass, rock, dirt, sand: `<n>.png`, `_n.png`, `_orm.png` |
| `scripts/meshes.ts`   | `pine.glb`, `oak.glb`, `rock.glb`, `grass.glb`           |
| `scripts/scatter.ts`  | `pines`, `oaks`, `rocks`, `grass` `.scatter`             |
| `scripts/scene.ts`    | `scenes/main.scene.json`                                 |

`deno test -A examples/terrain` runs the generators on a reduced world and
checks determinism, the placement rules, the meshes and that the committed scene
is what the generators write.
