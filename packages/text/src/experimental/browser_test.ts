import { asset_id, asset_ref } from "@ink/assets/identity.ts";
import { assertEquals } from "@std/assert";
import { create_font_family } from "../font.ts";
import { css_font } from "./browser.ts";

Deno.test("experimental CSS font descriptions quote authored families and retain generic fallbacks", () => {
  const font = create_font_family({
    family: "Ink Sans",
    faces: [{
      asset: asset_ref(asset_id("fonts/ink-sans"), "font"),
      weight: 400,
      style: "normal",
    }],
    fallbacks: ["sans-serif"],
  });

  assertEquals(
    css_font({ font, size: 10, weight: 400, style: "normal" }),
    'normal 400 10px "Ink Sans", sans-serif',
  );
});
