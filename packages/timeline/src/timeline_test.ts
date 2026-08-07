import { assertEquals, assertThrows } from "@std/assert";
import { asset_id, asset_ref } from "@ink/assets/identity.ts";
import { vec3 } from "@ink/math/vector.ts";
import {
  create_timeline,
  evaluate_timeline,
  timeline_clip_id,
  timeline_id,
  timeline_track_id,
  traverse_timeline_events,
} from "./timeline.ts";

Deno.test("timeline evaluation coordinates values and referenced clips on one playhead", () => {
  const timeline = fixture("once");
  const frame = evaluate_timeline(timeline, 2.5);

  assertEquals(frame.playhead, 2.5);
  assertEquals(frame.values.map(({ value }) => value), [0.5, vec3(2.5, 5, 0)]);
  assertEquals(frame.clips.map(({ clip, local_time }) => [clip, local_time]), [
    [timeline_clip_id("walk"), 3],
  ]);
});

Deno.test("looping timelines traverse events in both directions across loop boundaries", () => {
  const timeline = fixture("loop");

  assertEquals(
    traverse_timeline_events(timeline, 3.5, 5.5).map((event) => [
      event.name,
      event.occurrence_time,
    ]),
    [["land", 4], ["land", 5]],
  );
  assertEquals(
    traverse_timeline_events(timeline, 5.5, 3.5).map((event) => [
      event.name,
      event.occurrence_time,
    ]),
    [["land", 5], ["land", 4]],
  );
});

Deno.test("timeline creation rejects duplicate key times with the track identity", () => {
  assertThrows(
    () =>
      create_timeline({
        id: timeline_id("invalid"),
        duration: 1,
        playback: "once",
        tracks: [{
          type: "scalar",
          id: timeline_track_id("camera.zoom"),
          binding: { subsystem: "camera", target: "main", property: "zoom" },
          interpolation: "linear",
          keys: [{ time: 0, value: 1 }, { time: 0, value: 2 }],
        }],
      }),
    Error,
    "timeline track camera.zoom repeats key time 0",
  );
});

Deno.test("timeline creation snapshots bindings and interpolates extreme finite scalars", () => {
  const binding = { subsystem: " camera ", target: "main", property: "zoom" };
  const timeline = create_timeline({
    id: timeline_id("extreme"),
    duration: 1,
    playback: "once",
    tracks: [{
      type: "scalar",
      id: timeline_track_id("zoom"),
      binding,
      interpolation: "linear",
      keys: [{ time: 0, value: -Number.MAX_VALUE }, {
        time: 1,
        value: Number.MAX_VALUE,
      }],
    }],
  });
  binding.target = "changed";
  const frame = evaluate_timeline(timeline, 0.5);
  assertEquals(frame.values[0].binding.target, "main");
  assertEquals(frame.values[0].value, 0);

  assertThrows(
    () =>
      create_timeline({
        id: timeline_id("invalid"),
        duration: 1,
        playback: "once",
        tracks: [{
          type: "scalar",
          id: timeline_track_id("zoom"),
          binding,
          interpolation: "cubic" as never,
          keys: [{ time: 0, value: 0 }],
        }],
      }),
    Error,
    'interpolation "cubic" is unsupported',
  );
});

function fixture(playback: "once" | "loop") {
  return create_timeline({
    id: timeline_id("intro"),
    duration: 4,
    playback,
    tracks: [{
      type: "scalar",
      id: timeline_track_id("audio.volume"),
      binding: { subsystem: "audio", target: "music", property: "volume" },
      interpolation: "linear",
      keys: [{ time: 0, value: 0 }, { time: 4, value: 0.8 }],
    }, {
      type: "vector",
      id: timeline_track_id("camera.position"),
      binding: { subsystem: "camera", target: "main", property: "position" },
      interpolation: "linear",
      keys: [{ time: 0, value: vec3(0, 0, 0) }, {
        time: 4,
        value: vec3(4, 8, 0),
      }],
    }, {
      type: "clips",
      id: timeline_track_id("animation.body"),
      binding: { subsystem: "animation", target: "player", property: "clip" },
      clips: [{
        id: timeline_clip_id("walk"),
        start: 1,
        duration: 3,
        content: asset_ref(asset_id("animations/walk"), "animation"),
        offset: 1.5,
      }],
    }, {
      type: "events",
      id: timeline_track_id("gameplay.events"),
      events: [{ time: 0, name: "land" }, { time: 1, name: "land" }],
    }],
  });
}
