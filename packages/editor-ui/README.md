# `@ink/editor-ui`

Accessible, compact React 19 primitives for specialized Ink development tools.
The package owns reusable editor chrome, not editor behavior: applications keep
selection, mutations, commands, layout persistence, and domain vocabulary.

Import components from `@ink/editor-ui` and import `@ink/editor-ui/styles.css`
once in the application. Theme and density are set on an ancestor with
`data-theme="light|dark"` and `data-density="comfortable|compact"`. CSS custom
properties are the supported styling seam.

Interaction primitives build on `@comp0/react`; direct form and structural
semantics stay native. Public values are controlled, icon-only controls require
an accessible label, tree and tab widgets include keyboard behavior, dialogs use
the native dialog role, and animation respects reduced-motion preferences.
