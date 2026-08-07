import { assertEquals, assertThrows } from "@std/assert";
import { asset_id, asset_ref } from "@ink/assets/identity.ts";
import { create_font_family, css_font } from "./font.ts";
import { layout_text, type TextMeasurer } from "./layout.ts";
import { world_text } from "./world.ts";

const font = create_font_family({
  family: "Ink Sans",
  faces: [{
    asset: asset_ref(asset_id("fonts/ink-sans"), "font"),
    weight: 400,
    style: "normal",
  }],
  fallbacks: ["sans-serif"],
});
const style = { font, size: 10, weight: 400, style: "normal" as const };
const measurer: TextMeasurer = {
  measure(text) {
    return { width: Array.from(text).length * 5, ascent: 8, descent: 2 };
  },
};

Deno.test("CSS font descriptions quote authored families but retain generic fallbacks", () => {
  assertEquals(css_font(style), 'normal 400 10px "Ink Sans", sans-serif');
});

Deno.test("text layout wraps measured words and aligns them within the requested width", () => {
  assertEquals(
    layout_text({
      text: "build better editors",
      style,
      maximum_width: 60,
      align: "center",
    }, measurer),
    {
      width: 60,
      height: 20,
      direction: "ltr",
      overflowed: false,
      lines: [{ text: "build better", width: 60, x: 0, baseline: 8 }, {
        text: "editors",
        width: 35,
        x: 12.5,
        baseline: 18,
      }],
    },
  );
});

Deno.test("text layout reports clipped lines and resolves right-to-left start alignment", () => {
  const layout = layout_text({
    text: "مرحبا بالعالم",
    style,
    maximum_width: 40,
    maximum_lines: 1,
  }, measurer);

  assertEquals(layout.direction, "rtl");
  assertEquals(layout.overflowed, true);
  assertEquals(layout.lines[0].x, 15);
});

Deno.test("word wrapping breaks an unbroken word at character boundaries", () => {
  assertEquals(
    layout_text({
      text: "abcdefgh",
      style,
      maximum_width: 20,
    }, measurer).lines.map((line) => line.text),
    ["abcd", "efgh"],
  );
});

Deno.test("text layout reports horizontal overflow and rejects incomplete measurements", () => {
  assertEquals(
    layout_text({
      text: "wide",
      style,
      maximum_width: 5,
      wrap: "none",
    }, measurer).overflowed,
    true,
  );
  assertThrows(
    () =>
      layout_text({ text: "broken", style }, {
        measure: () => ({ width: 1, descent: 0 } as never),
      }),
    Error,
    "text measurement ascent undefined",
  );
});

Deno.test("world text rejects an unusable physical scale", () => {
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
