import { asset_id, asset_ref } from "@ink/assets/identity.ts";
import { assertThrows } from "@std/assert";
import { create_font_family, type TextStyle } from "../font.ts";
import { world_text } from "./world.ts";

const style = {
  font: create_font_family({
    family: "Ink Sans",
    faces: [{
      asset: asset_ref(asset_id("fonts/ink-sans"), "font"),
      weight: 400,
      style: "normal",
    }],
    fallbacks: ["sans-serif"],
  }),
  size: 10,
  weight: 400,
  style: "normal",
} satisfies TextStyle;

Deno.test("experimental world text rejects an unusable physical scale", () => {
  assertThrows(
    () =>
      world_text({
        layout: { text: "label", style },
        pixels_per_metre: 0,
        facing: "billboard",
        depth: "test",
      }),
    Error,
    "world text pixels per metre 0 must be finite and positive",
  );
  assertThrows(
    () =>
      world_text({
        layout: { text: "label", style },
        pixels_per_metre: 10,
        facing: "screen" as never,
        depth: "test",
      }),
    Error,
    'world text facing "screen" is unsupported',
  );
});
