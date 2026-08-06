# Development input migration

`development_action_map` and `development_input_gestures` are the adapter
boundary for replacing the current editor's pointer and wheel handling. The
consumer cutover remains intentionally outside this package because development,
camera, and UI composition are owned elsewhere.

The later development change should:

1. Own one `BrowserInputAdapter` and `ActionEvaluator`, created from
   `development_action_map`.
2. Capture one input frame with the runtime `FrameId` at the existing frame
   boundary instead of scheduling a separate wheel animation frame.
3. Translate each zoom gesture to the existing `{ type: "zoom", direction }`
   game action.
4. Subtract the surface bounds from each primary-pointer position before passing
   it to the existing game-specific `pointer_action`; retain the current
   semantic-region exclusion and duplicate-paint suppression.
5. Remove `wheel_zoom_action`, accumulated wheel state, and the parallel React
   pointer-capture state after the normalized path owns those events.

Semantic UI activation remains a UI adapter responsibility and should enter an
input frame only after the accessible UI contract exists.
