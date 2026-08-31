# @ink/visibility

The stable visibility surface contains the game-neutral model in `model.ts` and
the deterministic raster selection pipeline in `pipeline.ts`. A per-frame
evaluation applies view layers, maximum distance, the camera frustum,
projected-size thresholds, and LOD hysteresis to immutable object bounds.
Results retain the submitted LOD and a reason for every rejected candidate.

The canonical renderer uses this selection only for raster color instances.
Shadow and path-tracing extraction retain active geometry that can contribute
outside the camera frustum.

Software occlusion and portal traversal remain under
`@ink/visibility/experimental/*` until an editor game executes those contracts.
