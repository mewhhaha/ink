import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { vec3 } from "@ink/math/vector.ts";
import { emitter_id, listener_id } from "./model.ts";
import {
  cone_attenuation,
  distance_attenuation,
  rebase_audio_position,
  spatial_mix,
} from "./spatial.ts";

const listener = {
  id: listener_id("camera"),
  position: vec3(0, 0, 0),
  forward: vec3(0, 0, -1),
  up: vec3(0, 1, 0),
  velocity: vec3(0, 0, 0),
};

Deno.test("linear distance attenuation reaches zero at maximum distance", () => {
  assertEquals(
    distance_attenuation(11, {
      type: "linear",
      reference_distance: 1,
      maximum_distance: 11,
      rolloff: 1,
    }),
    0,
  );
});

Deno.test("inverse distance attenuation preserves reference gain", () => {
  assertEquals(
    distance_attenuation(1, {
      type: "inverse",
      reference_distance: 1,
      maximum_distance: 20,
      rolloff: 1,
    }),
    1,
  );
});

Deno.test("cone attenuation interpolates between authored angles", () => {
  assertAlmostEquals(
    cone_attenuation(vec3(0, 0, -1), vec3(1, 0, -1), {
      inner_angle_radians: 0,
      outer_angle_radians: Math.PI,
      outer_gain: 0,
    }),
    0.5,
  );
});

Deno.test("spatial mix uses shared right-handed Y-up coordinates", () => {
  const mix = spatial_mix(
    {
      id: emitter_id("speaker"),
      position: vec3(1, 0, -1),
      forward: vec3(0, 0, -1),
      velocity: vec3(0, 0, 0),
    },
    listener,
    { type: "none" },
    undefined,
    1,
  );
  assertAlmostEquals(mix.pan, 1 / Math.sqrt(2));
  assertEquals(mix.web_audio_position, vec3(1, 0, -1));
});

Deno.test("origin rebasing subtracts the world shift", () => {
  assertEquals(
    rebase_audio_position(vec3(1_001, 2, 3), vec3(1_000, 0, 0)),
    vec3(1, 2, 3),
  );
  assertThrows(
    () => distance_attenuation(-1, { type: "none" }),
    Error,
    "nonnegative",
  );
});
