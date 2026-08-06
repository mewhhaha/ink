# Procedural package plan

Status: implemented.

## Boundary

`@ink/procedural` owns deterministic synthesis from explicit recipes into
immutable engine-neutral or shared-world products. It does not own runtime
streaming, rendering resources, shader execution, physics bodies, editor panels,
or game-specific generation rules.

## Delivery tasks

- [x] **PROC-001:** Add branded unsigned seeds, explicit generator revisions,
      and coordinate/channel-stable random sampling.
- [x] **PROC-002:** Bake validated two-dimensional scalar fields into immutable
      heightfields using world-space sample coordinates.
- [x] **PROC-003:** Adapt procedural heightfields and surface maps into the
      shared `@ink/world` terrain contract.
- [x] **PROC-003A:** Adapt deterministic `@ink/noise` fractals into procedural
      scalar fields without moving terrain ownership into the noise package.
- [x] **PROC-004:** Classify elevation, moisture, and temperature using authored
      biome ranges, falloffs, priorities, and stable tie breaking.
- [x] **PROC-005:** Generate deterministic bounded scatter products with density
      masks, stable identities, variation channels, limits, and minimum spacing.
- [x] **PROC-006:** Provide sphere and box signed-distance fields plus union,
      intersection, subtraction, smoothing, and offsets.
- [x] **PROC-007:** Polygonize signed-distance fields with a first-party
      marching-tetrahedra implementation and validated mesh output.
- [x] **PROC-008:** Compose heightfield, biome, terrain, and scatter publication
      through one explicit recipe without hidden I/O or global randomness.
- [x] **PROC-009:** Cover deterministic replay, malformed boundaries, empty
      surfaces, biome gaps, placement separation, and shared-world adaptation.
- [x] **PROC-010:** Pin representative heightfield and distance-meshing
      benchmark baselines with the workspace default 10% regression threshold.

## Completion criteria

- The same seed, revision, recipe, and field samples produce byte-equivalent
  typed arrays and stable placement identities in the same build.
- Algorithm changes require a new generator revision rather than silently
  changing saved-world results.
- Consumers can use procedural results without depending on an editor or GPU.
