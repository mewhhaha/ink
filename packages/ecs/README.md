# @ink/ecs

The stable package surface is the Blot entity, component-schema, and indexed
seed boundary in `@ink/ecs/blot.ts`.

The parallel TypeScript world, codecs, scheduler, snapshots, and sparse storage
remain below `@ink/ecs/experimental/*`. Shooter, role-playing, or strategy may
promote only the host ECS paths a real editor game needs; isolated package tests
do not establish public stability.
