# @ink/math

Ink uses right-handed, Y-up coordinates with negative Z forward. Matrices are
column-major and operate on column vectors; local transforms apply scale,
rotation, then translation. Angles are radians, distances are metres, durations
are seconds, and WebGPU projections map depth to zero through one.

The stable package contains finite scalar, vector, matrix, quaternion,
transform, and projection operations. Guest fixed-point conversion remains under
`experimental/fixed_point.ts` until the canonical Blot boundary consumes it
instead of maintaining a separate numeric codec.
