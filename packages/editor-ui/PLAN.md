# Editor UI implementation plan

- [x] Establish compact light/dark tokens and comfortable/compact density.
- [x] Provide buttons, form controls, overlays, dialogs, and feedback states.
- [x] Provide editor layout, inspector, outliner, asset, and command chrome.
- [x] Provide timeline, curve, socket, and node-graph presentation shells.
- [x] Preserve native semantics, controlled state, focus visibility, keyboard
      navigation, and reduced-motion behavior.
- [x] Exercise public semantic output through server-rendered behavior tests.
- [x] Demonstrate the complete surface in a focused Vite component gallery.

Performance benchmarks are not useful for these thin React presentation
components. Applications should profile the actual editor trees and data volumes
they compose rather than treating isolated SSR timing as a runtime budget.
