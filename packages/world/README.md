# @ink/world

The stable surface is the terrain and vegetation path exercised by the strategy
editor game:

- `identity.ts` owns world and global-position identities.
- `terrain.ts` owns immutable terrain descriptors and sampling.
- `vegetation.ts` places deterministic vegetation against terrain.

Origin rebasing, partitioning, and streaming remain under
`@ink/world/experimental/*` until gameplay exercises them.
