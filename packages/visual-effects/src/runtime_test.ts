import { assertEquals, assertThrows } from "@std/assert";
import { asset_id, type AssetId } from "@ink/assets/identity.ts";
import { vec3 } from "@ink/math/vector.ts";
import { effect_fixture } from "./fixture.ts";
import { effect_definition_id, effect_instance_id } from "./identity.ts";
import { EffectRuntime } from "./runtime.ts";

class AssetSet {
  readonly #assets: ReadonlySet<string>;

  constructor(assets: readonly AssetId[]) {
    this.#assets = new Set(assets);
  }

  available(asset: AssetId): boolean {
    return this.#assets.has(asset);
  }
}

function runtime(): EffectRuntime {
  return new EffectRuntime(new AssetSet([asset_id("textures/embers")]));
}

function start(runtime: EffectRuntime, id: string): void {
  runtime.start({
    id: effect_instance_id(id),
    definition: effect_definition_id("campfire"),
    seed: 1,
    quality: 1,
    origin: vec3(0, 0, 0),
    backend: { type: "cpu" },
  });
}

Deno.test("destroyed CPU simulations return to the pool and are reused", () => {
  const effects = runtime();
  effects.publish(effect_fixture());
  start(effects, "first");
  effects.destroy(effect_instance_id("first"));
  assertEquals(effects.pool_statistics(), {
    created: 1,
    reused: 0,
    available: 1,
    pressure: 0,
  });
  start(effects, "second");
  assertEquals(effects.pool_statistics(), {
    created: 1,
    reused: 1,
    available: 0,
    pressure: 1,
  });
});

Deno.test("pause and reduced offscreen policies avoid per-frame simulation", () => {
  const paused = runtime();
  paused.publish(effect_fixture({ offscreen: "pause" }));
  start(paused, "paused");
  paused.set_visibility(effect_instance_id("paused"), "offscreen");
  assertEquals(paused.step(1)[0].elapsed_seconds, 0);

  const reduced = runtime();
  reduced.publish(effect_fixture({ offscreen: "reduced" }));
  start(reduced, "reduced");
  reduced.set_visibility(effect_instance_id("reduced"), "offscreen");
  assertEquals(reduced.step(0.02)[0].elapsed_seconds, 0);
  assertEquals(reduced.step(0.05)[0].elapsed_seconds, 0.07);
});

Deno.test("replacement validates the whole batch before restarting instances", () => {
  const effects = runtime();
  effects.publish(effect_fixture());
  start(effects, "live");
  effects.step(0.5);
  assertEquals(effects.replace([effect_fixture({ revision: 2 })]), {
    type: "replaced",
    definitions: [effect_definition_id("campfire")],
    restarted_instances: [effect_instance_id("live")],
  });
  assertEquals(effects.step(0)[0].elapsed_seconds, 0);
  assertEquals(effects.replace([effect_fixture({ revision: 2 })]), {
    type: "rejected",
    reason:
      "replacement effect campfire revision 2 must exceed current revision 2",
  });
});

Deno.test("unavailable required assets fail publication and startup with evidence", () => {
  const unavailable = new EffectRuntime(new AssetSet([]));
  assertEquals(unavailable.publish(effect_fixture()), {
    type: "rejected",
    reason: "effect campfire requires unavailable asset textures/embers",
  });

  const effects = runtime();
  effects.publish(effect_fixture());
  assertThrows(
    () =>
      effects.start({
        id: effect_instance_id("bad"),
        definition: effect_definition_id("missing"),
        seed: 1,
        quality: 1,
        origin: vec3(0, 0, 0),
        backend: { type: "cpu" },
      }),
    Error,
    "references unpublished definition missing",
  );
});
