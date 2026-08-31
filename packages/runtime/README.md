# @ink/runtime

Runtime publishes the language-neutral artifact, identity, digest, frame, JSON
Lines, and session contracts used by browser and headless hosts.

Graph resolution, lifecycle transitions, scheduling, snapshot machinery, and
Wasm instantiation are tested package internals. Callers compose them through a
runtime session rather than importing the implementation modules directly.

Rendering accumulation and other presentation-only state never enters runtime
snapshots, saves, replays, or checksums.
