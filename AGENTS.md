# Project intent

Ink is a foundation for building specialized game-development environments, not
a single general-purpose game editor.

Work should fit into three layers:

1. **Core Ink libraries** provide game-neutral contracts and capabilities such
   as the Wasm boundary, effects, accessibility, observability, hot reload,
   save/load, replay, headless execution, and reusable rendering primitives.
2. **Specialized editors** compose those libraries into an opinionated workflow
   for a genre or use case. They own the relevant panels, defaults, tools, and
   vocabulary instead of exposing every possible engine feature.
3. **Development applications** choose a specialized editor and connect it to a
   concrete game, assets, source language, and project configuration.

The conceptual path is core libraries -> specialized editor -> development
application. Source dependencies point back toward the more general layer: an
application may depend on its editor and Ink, while Ink must not depend on a
particular editor or game.

The browser is what makes specialization inexpensive. Prefer ordinary web
composition—React, native HTML, CSS, Vite plugins, and explicit host effects—so
an editor can be reshaped or replaced without forking the engine. Do not grow a
universal editor abstraction when a focused editor can express the use case
directly.

Place behavior in the narrowest layer that can honestly own it. Promote a
capability into core only when it is game-neutral and useful across different
editor specializations. Keep genre assumptions in the specialized editor and
game-specific rules in the development application.
