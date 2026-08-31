# @ink/physics

The physics package owns deterministic 2D and 3D collision worlds, shapes,
queries, rigid-body integration, joints, character motion, identities, and debug
geometry. It accepts explicit clocks and observations and does not own scene
hierarchy, terrain residency, ECS publication, or application state.

Applications compose scene nodes, terrain, and gameplay entities with physics at
their own boundary. Keeping those mappings out of core prevents a second mutable
scene or ECS authority from growing inside the simulation.
