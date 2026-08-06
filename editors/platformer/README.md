# @ink/platformer-editor

A specialized authoring model for bounded 2D and 2.5D platformers. It owns the
creator vocabulary—levels, collision surfaces, gameplay records, moving routes,
camera zones, and trigger logic—without adding those genre assumptions to Ink's
core libraries.

The public API provides:

- an immutable `PlatformerProject` document and stable record identities;
- pure place, move, remove, connect, and disconnect commands;
- typed bounded undo and redo history backed by `@ink/authoring`;
- actionable validation for playable level structure and stale references;
- eight opinionated movement, camera, and mechanic presets;
- a valid playable starter project and deterministic JSON serialization;
- discovery metadata suitable for a specialized editor shell.

Game behavior, assets, Blot source generation, runtime adapters, and UI panels
belong to a development application such as a platformer studio. Removing a
record deliberately does not delete connections that reference it: validation
surfaces those connections so a creator can reconnect or intentionally remove
them instead of losing authored logic silently.

```ts
import {
  create_platformer_starter,
  platformer_editor_descriptor,
  validate_platformer_project,
} from "@ink/platformer-editor";

const project = create_platformer_starter("precision");
const diagnostics = validate_platformer_project(project);
console.log(platformer_editor_descriptor.label, diagnostics);
```

Run `pnpm check` and `pnpm test` from this directory.
