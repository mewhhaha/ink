# @ink/camera

The stable camera contract is split between immutable camera definitions in
`model.ts` and resolved per-frame views in `view.ts`. View construction owns
projection validation, pixel viewports, stable and jittered matrices, culling
frusta, screen conversion, rays, and explicit history-reset reasons.

Input-driven camera controllers and XR views remain under
`@ink/camera/experimental/*`. Applications map typed actions into camera changes
at their boundary; deterministic game cameras remain Blot presentation intent.
