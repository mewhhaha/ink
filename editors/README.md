# Specialized editors

Ink editors are genre fine-tunes: small authoring packages that open with useful
defaults and speak the creator's vocabulary. They compose core Ink libraries
without adding genre assumptions to those libraries or hiding every capability
behind one universal editor model.

| Package                   | Fine-tunes                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `@ink/platformer-editor`  | Classic adventure, precision, momentum, aerial acrobatics, exploration, auto-runner, puzzle platformer, cinematic chase |
| `@ink/shooter-editor`     | Boomer shooter, arena shooter, tactical shooter, horde shooter, immersive sim                                           |
| `@ink/roleplaying-editor` | Tactical CRPG, action RPG, dungeon crawler, roguelite, cozy farming                                                     |
| `@ink/narrative-editor`   | Kinetic novel, branching visual novel, dating sim, investigation                                                        |
| `@ink/strategy-editor`    | Tower defense, real-time strategy, tactics, city builder, automation                                                    |
| `@ink/adventure-editor`   | Point-and-click, survival horror, third-person action adventure                                                         |
| `@ink/vehicle-editor`     | Racer, arcade flight, submarine, space combat                                                                           |

Each package owns its document, pure commands, actionable diagnostics, valid
starter, tool catalog, and preset defaults. Development applications may compose
those contracts with `@ink/editor-ui`.

Playable state, rules, actions, and outcomes belong to the development
application's Blot sources. TypeScript builds and hosts the Wasm guest and tests
its observable behavior; it does not reimplement the game.
