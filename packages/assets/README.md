# @ink/assets

`@ink/assets` owns content identities, versioned manifests, digest verification,
dependency closure loading, cache leases, and atomic multi-asset replacement.
Consumers refer to `AssetId` values. URLs and platform reads stop at the
`ArtifactReader` boundary.

`build_prepared_static_gltf_scene` converts an imported static glTF scene into
bounded mesh chunks, material chunks, and encoded level-zero texture chunks.
`build_asset_manifest` hashes those outputs and assigns content-addressed
locations. Runtime code verifies the manifest and every artifact before
publishing a complete dependency closure to `AssetCache`.

The prepared scene format is versioned and deterministic. It stores CPU asset
records, not renderer resources. Image decoding, GPU allocation, and generated
GPU mip levels remain presentation responsibilities.

A failed read, size check, digest check, or replacement leaves the current
leased revision usable. Retired bytes remain resident until the last lease is
released.

General glTF parsing, platform media decoding, and prioritized streaming are
experimental. Their exports live under `@ink/assets/experimental/*`. The OBJ
grammar parser is private to the stable high-level mesh preparation API.
