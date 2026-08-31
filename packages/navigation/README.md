# @ink/navigation

The stable navigation boundary owns canonical identities and agent profiles,
deterministic grid-tile baking, immutable navmesh publication, and bounded path
queries. Adventure compiles its authored floor, walls, and oak gate through that
boundary: the closed-gate snapshot has no exit path, while removing the gate
produces the route that Blot uses for movement and exit availability.

`identity.ts`, `profile.ts`, `tile.ts`, `navmesh.ts`, and `query.ts` are stable.
Crowd steering and the scene, physics, terrain, and origin adapters remain under
`experimental/`; no editor game uses those composition paths as gameplay
authority.
