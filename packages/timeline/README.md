# @ink/timeline

`@ink/timeline` is Ink's renderer- and genre-neutral sequence contract. It owns
branded timeline, track, and clip identities; immutable value, clip, and event
tracks; deterministic evaluation; and forward, reverse, and looping event
traversal.

The package does not apply bindings or own clocks, animation clips, cameras,
audio voices, dialogue rules, or editor panels. A specialized editor or
application maps evaluated values and events into those domains. The
role-playing editor game proves the stable `timeline.ts` export by compiling
authored pilgrimage beats into deterministic Blot order and timing.
