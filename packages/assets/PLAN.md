# @ink/assets plan

Status: implemented; the development preview consumes the shared OBJ mesh
packing boundary.

## Purpose

Turn authored resources into stable, observable runtime assets that can stream,
share dependencies, and hot-reload without coupling games to URLs or GPU
objects.

## Ownership

This package owns asset identities, manifests, dependency graphs, source
importers, derived artifacts, loaders, decoders, cache state, streaming, and hot
replacement. It does not own GPU allocation, material interpretation, scene
ownership, audio playback, editor file watching, or game-specific asset meaning.

All format importers, derived-artifact transforms, and decoding adapters are
Ink-owned. Native browser image and audio codecs, storage, and fetch may be used
as explicit platform capabilities.

## Planned contracts

- Type-branded `AssetId`, `AssetRef`, content digest, source revision, and
  artifact revision values.
- Versioned manifests describing type, dependencies, variants, digest, size, and
  canonical artifact location.
- Registered import and load capabilities with typed ready, pending, failed,
  evicted, and replaced states.
- Reference-counted cache leases, priority requests, cancellation, budgets, and
  dependency-aware hot replacement.
- First-party glTF/GLB and OBJ parsers producing validated format-level
  documents and asset references. Owning downstream packages convert those
  documents into scene, material, animation, audio, and rendering contracts.
- Image, texture, and audio decoding adapters over explicit native browser codec
  capabilities.

## Dependencies and integration

Direct dependency: `@ink/observability`.

Scene stores asset references. Rendering, materials, animation, audio, and world
own the interpretation and device upload of loaded values. Existing OBJ parsing,
preview asset loading, build copying, and Vite asset replacement are extraction
inputs.

## Tasks

- [x] **ASSET-001:** Define identities, manifest versioning, dependency cycles,
      variants, lifecycle states, leases, and error evidence.
- [x] **ASSET-002:** Implement manifest construction, digest verification,
      dependency ordering, cancellation, cache budgets, and eviction.
- [x] **ASSET-003:** Implement first-party glTF/GLB and OBJ parsing into neutral
      validated documents with mesh, skin, animation, material, and scene
      records separated by asset identity.
- [x] **ASSET-004:** Implement browser image and audio decoding adapters plus
      texture mip and color-space metadata without creating renderer resources.
- [x] **ASSET-005:** Implement streaming priorities and atomic dependency-aware
      hot replacement that retains the last usable revision on failure.
- [x] **ASSET-006:** Integrate the app build boundary so authored files produce
      manifests and content-addressed derived artifacts.
- [x] **ASSET-007:** Add malformed-format, cycle, cancellation, eviction,
      partial-fetch, digest-mismatch, and failed-replacement tests.
- [x] **ASSET-008:** Benchmark parse, decode, cache pressure, and replacement
      against small, shared, and streamed-world fixture sets.

## Operational requirements

- Untrusted manifests and formats return typed failures carrying source, offset
  or field, asset identity, and revision; failed replacement retains the last
  ready revision.
- Unavailable native codecs or storage produce explicit capability failures and
  typed fallback assets only where the consumer declared one.
- Loads, failures, cancellation, eviction, bytes, durations, cache pressure, and
  replacement revisions are observed with bounded evidence.
- Manifest ordering, digests, parsing, and dependency resolution are
  deterministic; native decoded media bytes need not be bit-identical across
  browsers.

## Acceptance

Consumers never observe a manifest pointing at half-published artifacts. A
failed replacement retains the previous ready revision and reports the source
and failure. Cancelled or evicted loads release their leases and platform
resources. Malformed untrusted input cannot introduce partially trusted asset
values.
