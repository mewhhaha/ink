# @ink/animation

The stable exports cover skeleton identity and hierarchy, animation clips,
deterministic clip sampling, pose blending, and matrix generation. Adventure
uses them to open the oak gate, and platformer uses them for the player's jump
and landing poses. Both scenarios assert the resulting canonical render-scene
transforms in headless and browser playthroughs.

Animation graphs, state transitions, IK and aim constraints, retargeting, and
cross-domain adapters remain below `@ink/animation/experimental/*`. Package
tests preserve their behavior, but no editor game currently exercises those
exports.

Retarget semantics belong to an experimental `RetargetProfile`, separate from
the stable `Skeleton`. A profile maps validated skeleton joints to semantic
identities and translation scales. This keeps retarget metadata out of clip and
pose playback while preventing a profile from referring to missing joints or
repeating a semantic.
