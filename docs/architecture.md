# Architecture

Ink makes specialized game-development environments inexpensive to build. It
does not provide a universal editor. Each application selects one focused
editor, one game, and the game-neutral Ink capabilities it can prove end to end.

## Layers and ownership

Dependencies point from concrete code toward general contracts:

```text
core package <- specialized editor <- development application
```

Core packages cannot depend on an editor or game. An editor may depend on core
authoring and UI contracts. An application may depend on its single editor and
the core capabilities needed to compile, run, and present that game.

Place behavior in the narrowest honest layer:

| Layer       | Owns                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Core        | Wasm/runtime contracts, typed effects, assets, input, observability, semantic UI, rendering primitives, and reusable game-neutral algorithms. |
| Editor      | Immutable genre documents, identities, commands, validation, serialization, presets, and the focused authoring workspace.                     |
| Application | Blot rules and state, project compilation, concrete assets, host-effect bindings, presentation composition, and development controls.         |

The browser is ordinary composition: React, native HTML and CSS, Vite, typed
host effects, and explicit package imports. A feature is not promoted into core
merely because two games look similar.

## Runtime flow

The editor document and Blot guest are the authorities; host adapters do not
reconstruct gameplay from pixels or duplicate it in TypeScript.

```text
editor document
      |
      v
application compiler --> generated Blot source/data assets
      |                              |
      +------------------------------+
                     |
                     v
        production or retained development build
                     |
                     v
          canonical runtime session
           /          |           \
          v           v            v
   semantic UI   typed effects   render scene
          |           |            |
          v           v            v
   HTML/headless   audio/debug   one renderer
```

Blot owns deterministic rules, state transitions, authored timing, scene
choices, camera/light/audio/UI intent, and outcomes. TypeScript is responsible
for boundary work: parsing editor documents, publishing assets, normalizing
browser input, applying host effects, rendering, semantic HTML, development
controls, and headless orchestration.

Presentation-only state does not enter runtime snapshots, saves, replay
checksums, or Blot cells. This includes a free debug camera, WebGPU resource
state, and path-tracing accumulation.

## Blot boundary and reload

`@ink/blot` derives host imports, required guest exports, codecs, manifest
validation, and ABI fixtures from one registry. The protocol adapts a Blot
artifact to the language-neutral runtime session and canonical UI snapshot.
There is no parallel semantic DTO, URL-based game loader, deterministic debug
camera, or frame-action protocol.

Production and headless execution use whole-program artifacts. Development uses
the local Blot `development-profile` compiler, retained project state, and
atomic multi-unit activation. A build prepares changed units before publication;
the runtime prepares every replacement before commit. A failure aborts the
activation and leaves the previous executable graph running.

The Vite integration owns watching and browser notification, not compiler
policy. Blot owns compiler configuration and incremental unit identity.

## Canonical presentation

Applications publish immutable scene hierarchies, canonical PBR material
records, physical lights, canonical camera definitions, semantic UI snapshots,
and normalized input actions.

`@ink/rendering` is the sole presentation backend. It owns:

- the WebGPU adapter, device, canvas surface, and device-loss lifecycle;
- mesh, texture, sampler, storage-texture, and pipeline resources;
- raster and compute pass encoding, submission, HDR composition, tone mapping,
  antialiasing, and picking;
- raster visibility selection without removing geometry needed by reflected or
  shadow rays; and
- the switch between raster preview and progressive path tracing.

Asset builds parse source scenes before first frame and publish digest-keyed
mesh, material, texture-mip, and prepared-scene artifacts. Applications load
those artifacts through manifests, verify every digest, lease cache entries, and
atomically replace complete bundles.

Semantic UI has one structure in browser and headless execution. Blot emits the
meaningful tree and actions; `@ink/ui` lays it out and maps it to native HTML.
Focus, keyboard activation, accessibility names, and replay-visible actions do
not depend on canvas pixel inspection.

## Portable path tracing

Stable ray tracing is standard browser WebGPU compute. It does not claim a
ray-query API, hardware RT cores, fake acceleration-structure handles, or a
second renderer.

`@ink/ray-tracing` owns branded ray-domain identities, deterministic triangle,
material, BLAS and TLAS packing, a CPU nearest-hit oracle, progressive
accumulation rules, and composed traversal/shading/denoising WGSL modules.
`@ink/rendering` owns GPU buffers, compute pipelines, storage textures, graph
passes, submission, and fallback.

Geometry changes rebuild BLAS data. Transform changes rebuild TLAS data.
Material, light, camera, viewport, exposure, fog, and technique changes reset
accumulation without changing game state. While the debug camera moves, the
renderer presents raster output; convergence resumes from a reset after motion
stops.

The stable path is proven in three stages:

1. A Cornell-style room checks color bleed, penumbra, indirect light, and an
   off-camera object visible only in a mirror.
2. The Fog room checks loaded geometry, normal mapping, brass and ceramic
   response, emissive surfaces, soft shadows, and bounded denoised variance.
3. Adventure checks identical gameplay and semantic observations under raster
   and path-traced presentation, including CPU-oracle pick identity.

## Observability and determinism

Each application supplies a bounded observation sink with boundary redaction.
Lifecycle events, typed host effects, rendering status, and failures are visible
to the development debugger. Observations never affect game behavior.

Input recordings and synthetic actions cross the same action-map boundary as
browser devices. Headless and browser scenarios compare replay checksums and
semantic presentation. Expected user mistakes are typed results; violated
runtime invariants fail with the relevant identity, revision, and value.

## Executable stability

Package stability is physical and executable, not a declaration in a plan.

- Stable exports map outside `src/experimental`.
- Experimental exports map inside `src/experimental`.
- Stable application and core source cannot import experimental modules.
- Every stable core export must be reached through production imports from an
  editor-game scenario.
- The scenario must report every declared assertion as passed across its real
  headless and browser commands.
- Each editor has exactly one editor-game owner.
- Capability demos can exercise a feature but cannot promote its export.

The generated `architecture/proof-report.json` inventories every package export
and scenario from those authoritative files. It does not replace scenario
execution; `pnpm check:workspace` performs that execution.

## Applications

The editor games are adventure, visual novel, platformer, role-playing, shooter,
strategy, and vehicle. Lighting and shrubbery are capability demos. Each game
has one production edit/rebuild/play outcome, deterministic headless proof, real
browser proof, and retained screenshot evidence where pixels are part of the
claim.

No compatibility renderer, Simple3D renderer, isometric compatibility module,
generic development application, or duplicate runtime is retained.
