# @ink/lighting

The stable lighting surface contains branded identities, validated physical
light definitions, and the game-neutral lighting model consumed by the canonical
renderer. Directional illuminance, point and spot intensity, source size, color,
layers, importance, and shadow intent remain explicit authored values.

Raster clustering, shadow-atlas planning, probes, environment processing,
quality plans, and standalone BRDF utilities remain under
`@ink/lighting/experimental/*` until an editor game executes those specific
contracts.
