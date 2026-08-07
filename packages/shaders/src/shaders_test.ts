import {
  brdf_wgsl,
  pbr_wgsl,
  reusable_wgsl_modules,
  terrain_wgsl,
} from "./builtins.ts";
import { compose_wgsl_modules, shader_program_contract } from "./compose.ts";
import { map_shader_diagnostics } from "./diagnostics.ts";
import { shader_module_id } from "./identity.ts";
import { create_wgsl_module } from "./module.ts";
import { noise_shader_module, noise_shader_modules } from "./noise.ts";
import { decide_shader_replacement } from "./reload.ts";
import { resolve_shader_variant } from "./variant.ts";
import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";

function base_module(revision = 0) {
  return create_wgsl_module({
    id: shader_module_id("fixture/base"),
    revision,
    symbols: [{ name: "fixture_curve", kind: "function", exported: true }],
    source: `fn fixture_curve(value: f32) -> f32 { return value * ${
      revision + 1
    }.0; }`,
  });
}

function fragment_module(revision = 0) {
  return create_wgsl_module({
    id: shader_module_id("fixture/fragment"),
    revision,
    dependencies: [{
      module: shader_module_id("fixture/base"),
      symbols: ["fixture_curve"],
    }],
    bindings: [{
      group: 1,
      binding: 0,
      name: "fixture_color",
      kind: "uniform",
      stages: ["fragment"],
      value_type: "vec4f",
    }],
    entry_points: [{ stage: "fragment", name: "fragment_main" }],
    source: `
@group(1) @binding(0) var<uniform> fixture_color: vec4f;
@fragment fn fragment_main() -> @location(0) vec4f {
  return fixture_color * fixture_curve(1.0);
}`,
  });
}

Deno.test("WGSL declarations require matching symbols, bindings, overrides, and entries", () => {
  const module = create_wgsl_module({
    id: shader_module_id("fixture/validated"),
    revision: 2,
    symbols: [{ name: "shade", kind: "function", exported: true }],
    overrides: [{ name: "SAMPLES", type: "u32", default_value: 4 }],
    bindings: [{
      group: 0,
      binding: 2,
      name: "frame",
      kind: "uniform",
      stages: ["vertex", "fragment"],
      value_type: "Frame",
    }],
    entry_points: [{ stage: "vertex", name: "vertex_main" }],
    source: `
struct Frame { projection: mat4x4f }
override SAMPLES: u32 = 4u;
@group(0) @binding(2) var<uniform> frame: Frame;
fn shade(value: f32) -> f32 { return value; }
@vertex fn vertex_main() -> @builtin(position) vec4f {
  return frame.projection * vec4f(shade(0.0));
}`,
  });
  assertEquals(module.revision, 2);
  assertEquals(module.bindings[0].stages, ["fragment", "vertex"]);
  const compute = create_wgsl_module({
    id: shader_module_id("fixture/compute"),
    revision: 0,
    entry_points: [{ stage: "compute", name: "compute_main" }],
    source: "@compute @workgroup_size(8, 4, 1) fn compute_main() {}",
  });
  assertEquals(compute.entry_points, [{
    stage: "compute",
    name: "compute_main",
  }]);
  assertThrows(
    () =>
      create_wgsl_module({
        id: shader_module_id("fixture/broken"),
        revision: 0,
        symbols: [{ name: "missing", kind: "function", exported: true }],
        source: "fn present() {}",
      }),
    Error,
    "declares absent function missing",
  );
  assertThrows(
    () =>
      create_wgsl_module({
        id: shader_module_id("fixture/wrong-binding-kind"),
        revision: 0,
        bindings: [{
          group: 0,
          binding: 0,
          name: "surface",
          kind: "texture",
          stages: ["fragment"],
          value_type: "f32",
        }],
        source: "@group(0) @binding(0) var surface: f32;",
      }),
    Error,
    "kind texture does not match value type",
  );
  assertThrows(
    () =>
      create_wgsl_module({
        id: shader_module_id("fixture/wrong-override-default"),
        revision: 0,
        overrides: [{ name: "COUNT", type: "u32", default_value: 4 }],
        source: "override COUNT: u32 = 8u;",
      }),
    Error,
    'source default "8u" does not match declared default 4',
  );
});

Deno.test("module creation canonicalizes identities and rejects unknown declaration kinds", () => {
  const module = create_wgsl_module({
    id: shader_module_id(" fixture/canonical "),
    revision: 0,
    symbols: [{ name: " shade ", kind: "function", exported: true }],
    source: "fn shade() {}",
  });
  assertEquals(module.id, "fixture/canonical");
  assertEquals(module.symbols[0].name, "shade");

  assertThrows(
    () =>
      create_wgsl_module({
        id: shader_module_id("fixture/unknown-stage"),
        revision: 0,
        entry_points: [{ stage: "geometry", name: "main" }],
        source: "@geometry fn main() {}",
      } as never),
    Error,
    'stage "geometry" is unsupported',
  );
});

Deno.test("dependency composition is deterministic and maps generated diagnostics to modules", () => {
  const base = base_module();
  const fragment = fragment_module();
  const first = compose_wgsl_modules([fragment.id], [fragment, base]);
  const second = compose_wgsl_modules([fragment.id], [base, fragment]);
  assertEquals(first.source, second.source);
  assertEquals(first.modules.map(({ id }) => id), [base.id, fragment.id]);
  const fragment_segment = first.source_map.find(({ module }) =>
    module === fragment.id
  )!;
  assertEquals(
    map_shader_diagnostics(first, [{
      severity: "error",
      line: fragment_segment.generated_start_line + 1,
      column: 3,
      message: "unknown identifier",
    }]),
    [{
      severity: "error",
      line: 2,
      column: 3,
      message: "unknown identifier",
      generated_line: fragment_segment.generated_start_line + 1,
      module: fragment.id,
    }],
  );
  assertEquals(shader_program_contract(first).fragment_entry, "fragment_main");
});

Deno.test("composition rejects dependency cycles and exported symbol collisions with module evidence", () => {
  const first_id = shader_module_id("cycle/first");
  const second_id = shader_module_id("cycle/second");
  const first = create_wgsl_module({
    id: first_id,
    revision: 0,
    dependencies: [{ module: second_id }],
    source: "fn first() {}",
  });
  const second = create_wgsl_module({
    id: second_id,
    revision: 0,
    dependencies: [{ module: first_id }],
    source: "fn second() {}",
  });
  assertThrows(
    () => compose_wgsl_modules([first.id], [first, second]),
    Error,
    "cycle/first -> cycle/second -> cycle/first",
  );
  const duplicate = create_wgsl_module({
    id: shader_module_id("fixture/duplicate"),
    revision: 0,
    symbols: [{ name: "fixture_curve", kind: "function", exported: true }],
    source: "fn fixture_curve(value: f32) -> f32 { return value; }",
  });
  assertThrows(
    () =>
      compose_wgsl_modules([base_module().id, duplicate.id], [
        base_module(),
        duplicate,
      ]),
    Error,
    "export symbol fixture_curve",
  );
  const vertex = create_wgsl_module({
    id: shader_module_id("fixture/vertex-main"),
    revision: 0,
    entry_points: [{ stage: "vertex", name: "shared_main" }],
    source:
      "@vertex fn shared_main() -> @builtin(position) vec4f { return vec4f(0.0); }",
  });
  const fragment = create_wgsl_module({
    id: shader_module_id("fixture/fragment-main"),
    revision: 0,
    entry_points: [{ stage: "fragment", name: "shared_main" }],
    source:
      "@fragment fn shared_main() -> @location(0) vec4f { return vec4f(1.0); }",
  });
  assertThrows(
    () => compose_wgsl_modules([vertex.id, fragment.id], [vertex, fragment]),
    Error,
    "declare WGSL name shared_main",
  );
  const missing_requirement = create_wgsl_module({
    id: shader_module_id("fixture/missing-requirement"),
    revision: 0,
    dependencies: [{
      module: base_module().id,
      symbols: ["not_exported"],
    }],
    source: "fn local() {}",
  });
  assertThrows(
    () =>
      compose_wgsl_modules(
        [missing_requirement.id],
        [base_module(), missing_requirement],
      ),
    Error,
    "does not export required symbol not_exported",
  );
});

Deno.test("typed variants have canonical keys and reject unknown or out-of-range values", () => {
  const schema = {
    id: "surface",
    fields: [
      { name: "alpha", type: "boolean" as const, default_value: false },
      {
        name: "lights",
        type: "integer" as const,
        minimum: 0,
        maximum: 8,
        default_value: 4,
      },
      {
        name: "path",
        type: "enum" as const,
        values: ["forward", "deferred"],
        default_value: "forward",
      },
    ],
  };
  assertEquals(
    resolve_shader_variant(schema, { path: "deferred", lights: 2 }).key,
    "surface?alpha=false&lights=2&path=deferred",
  );
  assertThrows(
    () => resolve_shader_variant(schema, { lights: 9 }),
    Error,
    "must be integer within 0..8",
  );
  assertThrows(
    () => resolve_shader_variant(schema, { missing: true }),
    Error,
    "unknown fields missing",
  );
  assertThrows(
    () => resolve_shader_variant(schema, { lights: null } as never),
    Error,
    "field lights value null must be integer",
  );
  assertEquals(
    resolve_shader_variant({
      id: "canonical",
      fields: [{
        name: " path ",
        type: "enum",
        values: ["forward"],
        default_value: "forward",
      }],
    }).key,
    "canonical?path=forward",
  );
  assertThrows(
    () =>
      resolve_shader_variant({
        id: "broken",
        fields: [{
          name: "path",
          type: "enum",
          values: [42],
          default_value: "forward",
        }],
      } as never),
    Error,
    "enum path values must be strings",
  );
});

Deno.test("replacement decisions distinguish source recomposition from interface rebuilds", () => {
  const current = base_module(0);
  const dependent = fragment_module();
  const source_replacement = base_module(1);
  assertEquals(
    decide_shader_replacement(current, source_replacement, [
      current,
      dependent,
    ]),
    {
      type: "recompose",
      module: current.id,
      affected_modules: [current.id, dependent.id],
    },
  );
  const interface_replacement = create_wgsl_module({
    id: current.id,
    revision: 2,
    symbols: [{ name: "replacement_curve", kind: "function", exported: true }],
    source: "fn replacement_curve(value: f32) -> f32 { return value; }",
  });
  assertEquals(
    decide_shader_replacement(current, interface_replacement, [
      current,
      dependent,
    ]).type,
    "rebuild_consumers",
  );
  const revision_only = create_wgsl_module({ ...current, revision: 3 });
  assertEquals(
    decide_shader_replacement(current, revision_only, [current, dependent])
      .type,
    "unchanged",
  );
});

Deno.test("reusable modules compose without hidden renderer or GPU state", () => {
  const composed = compose_wgsl_modules(
    [pbr_wgsl.id, terrain_wgsl.id],
    reusable_wgsl_modules,
  );
  assertEquals(composed.modules.map(({ id }) => id), [
    brdf_wgsl.id,
    pbr_wgsl.id,
    terrain_wgsl.id,
  ]);
  assertStrictEquals(composed.modules[0], brdf_wgsl);
  assertEquals(composed.bindings, []);
});

Deno.test("noise WGSL adapts downstream into declared shader dependencies", () => {
  const fractal = noise_shader_module("fractal");
  const composed = compose_wgsl_modules([fractal.id], noise_shader_modules);
  assertEquals(composed.modules.map(({ id }) => id), [
    "ink/noise/hash",
    "ink/noise/gradient",
    "ink/noise/fractal",
  ]);
  assertEquals(
    composed.symbols.some(({ name }) => name === "ink_fbm_gradient_3d"),
    true,
  );
});
