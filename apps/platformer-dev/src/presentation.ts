import { create_clip, sample_clip } from "@ink/animation/clip.ts";
import { create_skeleton } from "@ink/animation/skeleton.ts";
import { asset_id } from "@ink/assets/identity.ts";
import type { GameViewport } from "@ink/blot/protocol.ts";
import type { BlotPresentation } from "@ink/blot/runtime.ts";
import { select_lod } from "@ink/visibility/pipeline.ts";

const player_skeleton = create_skeleton(
  asset_id<"skeleton">("platformer/player"),
  [],
);
const player_animation = create_clip(
  player_skeleton,
  {
    asset: asset_id<"animation">("platformer/run-stretch"),
    duration: 1,
    looping: true,
    tracks: [],
    properties: [{
      property: "player_stretch",
      interpolation: "linear",
      default_value: 1,
      keys: [
        { time: 0, value: 1 },
        { time: 0.25, value: 0.88 },
        { time: 0.5, value: 1 },
        { time: 0.75, value: 1.12 },
        { time: 1, value: 1 },
      ],
    }],
    morphs: [],
    events: [],
  },
);

const exit_lods = [
  { id: "full", minimum_projected_pixels: 80 },
  { id: "compact", minimum_projected_pixels: 0 },
] as const;

export function present_platformer(
  presentation: BlotPresentation,
  viewport: GameViewport,
): BlotPresentation {
  const animation_time = Number(presentation.observation.sequence) * 0.05;
  const stretch = sample_clip(
    player_skeleton,
    player_animation,
    animation_time,
  ).properties.get("player_stretch");
  if (stretch === undefined) {
    throw new Error("platformer player animation has no stretch property");
  }
  const objects = presentation.snapshot.objects.map((object) => {
    if (object.id === 100) {
      return Object.freeze({
        ...object,
        scale: [
          Math.round(object.scale[0] / stretch),
          Math.round(object.scale[1] * stretch),
          object.scale[2],
        ] as const,
      });
    }
    if (object.id !== 101) return object;
    const projected_pixels = object.scale[0] / 32_000_000 * viewport.width;
    const lod = select_lod(exit_lods, projected_pixels, undefined, 0.1);
    return Object.freeze({
      ...object,
      emissive: lod === "full" ? 0.24 : 0.08,
    });
  });
  return Object.freeze({
    observation: presentation.observation,
    snapshot: Object.freeze({
      ...presentation.snapshot,
      objects: Object.freeze(objects),
    }),
  });
}
