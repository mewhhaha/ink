# @ink/camera plan

Status: implemented; development's preview projection now uses the shared camera
view adapter.

## Purpose

Make cameras game-authored scene capabilities instead of renderer-global zoom
and projection switches.

## Ownership

This package owns camera identity, pose, projections, viewports, view families,
camera stacks, render jitter/history, screen/world conversion, and reusable
controllers. It does not own input mapping, scene visibility, render targets,
post-processing, XR device discovery, or gameplay camera rules.

## Planned contracts

- Tagged perspective, orthographic, physical, custom, and XR projection values
  that cannot contain invalid near/far or viewport combinations.
- `CameraPose`, `CameraView`, `ViewFamily`, viewport, clear, depth, layer, and
  stack composition values.
- World-to-screen, screen-to-world, depth reconstruction, ray construction, and
  frustum derivation using shared math.
- Optional first-person, orbit, pan/zoom, follow, and shake controllers that
  consume named input actions and return camera state.
- Separate stable culling matrices and jittered rendering matrices.

## Dependencies and integration

Direct dependencies: `@ink/math`, `@ink/geometry`, `@ink/scene`, `@ink/input`,
and `@ink/observability`.

Visibility consumes stable views; rendering consumes both stable and jittered
views; UI may attach to a view or viewport. Existing fixed projection,
translation, zoom, picking, and semantic projection code is extracted here.

## Tasks

- [x] **CAMERA-001:** Define projection variants, near/far policy, viewport,
      layer masks, view families, stack order, and matrix history.
- [x] **CAMERA-002:** Implement view/projection construction, frusta, screen and
      world conversion, rays, depth reconstruction, and sub-viewports.
- [x] **CAMERA-003:** Implement temporal jitter with stable culling matrices and
      reset rules for cuts, resize, projection changes, and teleports.
- [x] **CAMERA-004:** Implement pure controller state transitions for
      first-person, orbit, orthographic pan/zoom, follow, and shake.
- [x] **CAMERA-005:** Implement stereo/XR view-family adaptation without making
      XR mandatory for ordinary views.
- [x] **CAMERA-006:** Replace renderer-global projection and zoom with
      game-authored cameras and shared picking math.
- [x] **CAMERA-007:** Test invalid projections, aspect changes, camera cuts,
      nested viewports, stack composition, round trips, jitter, and controllers.

## Operational requirements

- Invalid projection, viewport, stack, or singular conversion inputs return
  typed failures carrying the camera and offending values.
- Unavailable XR yields an absent XR view family while ordinary cameras remain
  usable; controllers have no hidden platform fallback.
- View creation, cuts, history resets, stack composition, and invalid
  conversions emit structured observations.
- Views, controllers, projection, picking, and history decisions are
  deterministic from camera state, input frame, and viewport.

## Acceptance

Projection and picking agree with the renderer for every view type and viewport.
Culling is unaffected by temporal jitter. A camera cut cannot reuse history from
the previous pose. Controllers remain pure and can be driven by recorded input
in headless tests.
