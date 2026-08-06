# @ink/navigation plan

Status: implemented and verified.

## Purpose

Build and query traversable space while keeping movement goals and tactical AI
inside specialized games.

## Ownership

This package owns first-party tiled navmesh generation, agent profiles,
connectivity, path search, path smoothing, dynamic obstacles, off-mesh links,
local steering, crowds, query snapshots, and diagnostics. It does not own
behavior trees, target selection, combat tactics, character physics, authored
terrain, or scene streaming policy.

## Planned contracts

- Agent profiles with radius, height, climb, slope, speed, acceleration, and
  area-cost policy.
- Versioned tile inputs and navmesh tiles with polygons, portals, areas,
  adjacency, detail surfaces, and off-mesh links.
- Nearest-point, reachability, raycast, A* corridor, and funnel path results
  with partial-path and stale-revision states.
- Dynamic obstacle overlays and bounded tile rebuilds.
- Deterministic steering and crowd desired-velocity outputs; physics remains
  authoritative for final movement.

## Dependencies and integration

Direct dependencies: `@ink/math`, `@ink/geometry`, `@ink/world`, `@ink/physics`,
and `@ink/observability`.

World supplies resident geometry and tile lifecycle. Physics supplies dynamic
obstacle queries and consumes desired movement through character adapters. No
third-party navmesh backend will be introduced.

## Tasks

- [x] **NAV-001:** Define agent, area, tile, polygon, link, revision, partial
      result, and streaming semantics.
- [x] **NAV-002:** Implement first-party voxelization, walkable filtering,
      distance field, region construction, contours, polygonization, and detail
      surfaces.
- [x] **NAV-003:** Implement tiled adjacency, nearest-point, raycast, A* with
      area costs, corridor repair, funnel smoothing, and off-mesh links.
- [x] **NAV-004:** Implement dynamic obstacle overlays, bounded asynchronous
      tile rebuilds, and stale-path reporting.
- [x] **NAV-005:** Implement deterministic local avoidance, steering, crowd
      neighborhoods, and desired-velocity output.
- [x] **NAV-006:** Integrate world residency, terrain, physics queries,
      character movers, origin rebasing, snapshots, and observations.
- [x] **NAV-007:** Test narrow passages, slopes, steps, islands, partial paths,
      cost changes, links, tile seams, streamed tiles, obstacles, crowds,
      rebasing, and malformed geometry.
- [x] **NAV-008:** Benchmark bake time, tile rebuild, memory, query latency,
      corridor repair, and crowd updates.

## Operational requirements

- Malformed geometry, invalid profiles, missing tiles, stale revisions, and
  unreachable goals return distinct typed results with affected tile or polygon
  identity.
- Missing or rebuilding tiles produce unavailable, stale, or partial paths
  according to caller policy; they never fabricate connectivity.
- Bake stages, tile revisions, open-set work, path status, obstacle rebuilds,
  crowd neighbors, and query timings emit bounded observations.
- Tile builds, A* tie-breaking, funnels, corridor repair, and steering are
  deterministic for the same ordered inputs and build.

## Acceptance

Path results name the navmesh revision they use and distinguish complete,
partial, unavailable, and stale results. Streamed tile removal cannot leave
dangling polygon references. Crowd output is deterministic and cannot directly
teleport or mutate authoritative character state.
