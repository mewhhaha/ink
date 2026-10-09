# The asset pipeline

Drop a file into a project's `assets/` folder and the dev server imports it:
textures become GPU-compressed KTX2 with precomputed mips, glTF models get
optimised, compressed geometry and simplified levels, sounds become Ogg Opus.
Nothing blocks the editor and nothing is imported twice.

```
assets/models/rock.glb ──watch──> hash (source bytes + importer version + settings)
        │                              │ hit: use .ink/cache/<sha256>/
        │                              v miss
        │                    worker pool (Deno workers, off the main thread)
        │                    preview stage: seconds       full stage: final quality
        v                              │
GET /__ink/assets/models/rock.glb ─ previous result, else preview, else the source
```

## What each kind becomes

| Source               | Preview stage (seconds)                                          | Full stage                                                                                                           |
| -------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `.glb` / `.gltf`     | one GLB: reordered, meshopt-compressed geometry, 256 px textures | same plus simplified levels (`INK_mesh_lods`) and Basis textures; external buffers and images are folded in          |
| `.png` / `.jpg`      | uncompressed RGBA8 KTX2 with a complete mip chain, 256 px        | Basis KTX2 with mips: ETC1S for colour, UASTC for normal and data maps (`balanced`), at most 4096 px (12 Mtexel cap) |
| `.wav` `.ogg` `.mp3` | (single stage)                                                   | Ogg Opus 96 kbps stereo / 64 mono (`audio.ts`); see below                                                            |

Sources under 512 KiB (`import.minBytes`) are served unchanged, and sources
under 1 MiB skip the preview stage. Files the importer cannot handle (Draco,
WebP, an already compressed model, a parse error) are served as they are and the
asset browser says so.

- **Textures.** Sampling role comes from the glTF material slot, or for loose
  files from the name (`*_n`, `*_normal` normal; `*_orm`, `*_rough`, `*_ao`...
  data; everything else colour). Colour is averaged in linear light when
  resized. The renderer picks the GPU format at load (BC7, ASTC, ETC2 or RGBA8),
  see `packages/render/README.md`.
- **Meshes.** Vertex cache/fetch reordering (`meshopt`), positions and UVs
  through the exponential filter (16/18 bit mantissa) and normals through the
  octahedral filter (12 bit) once a primitive has 2048 vertices; smaller ones
  stay lossless. Primitives of 3000+ triangles that are not skinned or morphed
  get up to four levels at 50/25/25/25 % of the previous one, simplified with
  normal and UV weights, sharing the vertex buffer; their geometric error is
  stored for the renderer's screen-space choice. Skins, morph targets and
  animation channels are carried through untouched (skinned primitives keep all
  vertices and attributes).
- **Audio.** `opusscript` (libopus compiled to wasm, no native build) encodes
  Opus after a polyphase resample to 48 kHz and an Ogg muxer written for Ink;
  output is deterministic. WAV is the pure path. For mp3/Ogg/FLAC input ffmpeg
  is used as a decoder when it is installed; otherwise those files pass through.
  Browsers decode Ogg Opus with `decodeAudioData` (Chromium, Firefox; Safari
  support varies by version).

## Terrain and scatter files

`*.terrain` (heightfield and splat weights) and `*.scatter` (instance
placements) are catalog kinds of their own (`terrain`, `scatter`). The importer
does not touch them: the dev server serves them as they are, the terrain tools
write edited regions back with `PATCH /__ink/assets-write/<path>`, and an edit
made by the tools does not reload them (a script rewriting the file does). They
stream in the renderer and the player; see `docs/terrain.md`. Imported glTF
files used as scatter meshes keep their `INK_mesh_lods` levels and vertex
colours when they hold a single primitive.

## The cache

`.ink/cache/<sha256>/` holds one import: the output file and `manifest.json`.
The key hashes the source bytes (plus the bytes of files a `.gltf` references),
the importer version, the stage, the kind and the settings, so editing a file
back to an earlier state is a cache hit and unrelated edits never invalidate
anything. Entries are written to a temporary directory and renamed into place.
Entries unused for two weeks are removed at startup. Thumbnails live in the same
cache under their own key. The directory is disposable (`.ink/` is git-ignored).

## While it runs

- `GET /__ink/imports` and the `ink:imports` event carry per-asset state, stage,
  progress and timings. The asset browser shows a progress bar, a badge on each
  importing asset and the byte savings in the tooltip; the editor console logs
  each finished stage.
- An asset keeps serving its previous result until the new one is ready. The
  first request for a new large asset waits (up to 20 s) for its preview rather
  than downloading the source. When a stage finishes the server sends the
  existing `ink:asset` event and the renderer reloads the asset in place.
- Settings go in `ink.config.ts`:
  `import: { minBytes, textures: { mode:
  "size" | "balanced" | "quality", maxSize, previewSize }, meshes: {
  quantizeAbove, lodAbove, lodRatios } }`.

## Thumbnails

Textures get 128 px PNG thumbnails from the importer. Meshes, and the materials
of imported glTF files (a "material" tab), are drawn by the editor's own
renderer (`renderThumbnail`) the first time they scroll into the browser and
`PUT` to `/__ink/thumbs/...`, keyed by the source content hash, so they survive
reloads and are shared by everyone using the same `.ink/`.

## Builds

`ink build` imports with the full stage only (a warm cache makes that a copy)
and writes `assets/<path>.ink.<ext>` plus `assets/ink-assets.json`, a map from
catalog path to stored file that the player loads before creating its renderer.
Scenes and the catalog keep logical paths. Files folded into a `.gltf` (`.bin`)
are not shipped.

## Gate

`scripts/gen-big-gltf.ts` writes a reproducible ~55 MB GLB (about 900,000
triangles, four PNG textures) to `tmp/big-scene.glb`; `deno task test:assets`
drops it into a running editor and a build, with and without the pipeline.
