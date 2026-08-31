# Vehicle editor

`@ink/vehicle-editor` owns the immutable, schema-versioned document for
vehicles, courses, ordered checkpoints, hazards, and objectives. Commands return
frozen projects and serialization rejects unknown fields at the file boundary.

`@ink/vehicle-dev` compiles that document into the Storm Pass Blot game. The
guest owns checkpoint order, early-finish rejection, course state, scene and
presentation intent, and the winning outcome.
