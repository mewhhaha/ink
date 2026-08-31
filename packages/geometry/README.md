# @ink/geometry

`@ink/geometry` provides game-neutral shapes, intersection queries, frusta, mesh
processing, a dynamic broad-phase tree, and a deterministic CPU static BVH.
These modules use canonical Ink math values and fail at construction or query
boundaries when geometry is malformed.

The CPU BVH is a correctness oracle. Ray tracing owns its separate packed
GPU-oriented triangle, BLAS, and TLAS representation instead of extending these
types with device concepts.
