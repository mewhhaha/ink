# @ink/ray-tracing

Device-neutral ray-domain contracts for Ink's canonical renderer. The package
owns deterministic geometry, material, BLAS, and TLAS packing; the CPU tracing
oracle; path-accumulation decisions; and composed WGSL modules. Each packed
geometry retains a local BLAS block so scene updates reuse unchanged geometry,
rebuild changed BLAS blocks, and rebuild the TLAS only after geometry or
transform revisions change.

`@ink/rendering` remains responsible for WebGPU devices, storage resources,
compute pipelines, submission, post-processing, fallback, and device-loss
recovery. Ray-acceleration packing and accumulation are presentation state and
never enter game snapshots or replay checksums.
