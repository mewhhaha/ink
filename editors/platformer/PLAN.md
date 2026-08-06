# Platformer editor plan

Status: implemented.

- [x] Define immutable projects, levels, layers, movement, and camera settings.
- [x] Model platforms, slopes, hazards, spawns, checkpoints, exits,
      collectibles, enemies, moving paths, trigger zones, and camera zones.
- [x] Add pure placement, movement, removal, and logic connection commands.
- [x] Add typed platformer history over game-neutral authoring revisions.
- [x] Represent logic explicitly as trigger → condition → action connections.
- [x] Validate exact spawn and exit counts, entry and exit destinations,
      identities, bounds, paths, kill planes, trigger events, and orphaned
      references with actionable authoring diagnostics.
- [x] Provide a deeply immutable playable starter project.
- [x] Provide eight named presets with distinct movement, camera, and default
      mechanic choices.
- [x] Publish specialized-editor discovery metadata and canonical project
      serialization.
- [x] Cover public behavior, invalid authoring edges, immutability, presets,
      commands, logic, and serialization with tests.

The editor owns platformer vocabulary and workflow defaults. Runtime gameplay,
Blot compilation, assets, rendering, physics adapters, and concrete UI panels
remain in development applications or game-neutral Ink packages.
