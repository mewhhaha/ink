# @ink/authoring

Small game-neutral contracts shared by specialized editors:

- bounded immutable document history with branching undo/redo;
- actionable diagnostics with stable codes and recovery text;
- discovery metadata for editor tools and subgenre presets.

The package deliberately has no universal scene document, property inspector,
panel registry, prefab model, or gameplay logic graph. Each specialized editor
owns those concepts in its genre vocabulary.
