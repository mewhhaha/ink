import { assertEquals } from "@std/assert";

const decoder = new TextDecoder();
const blot_cli = new URL("../../../blot/src/cli.ts", import.meta.url);

async function evaluate_fixture(name: string): Promise<string> {
  const fixture = new URL(`./testdata/${name}.blot`, import.meta.url);
  const evaluation = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", blot_cli.pathname, "eval", fixture.pathname],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!evaluation.success) {
    throw new Error(
      `Blot fixture ${
        JSON.stringify(name)
      } exited with code ${evaluation.code}: ${
        decoder.decode(evaluation.stderr).trim()
      }`,
    );
  }
  return decoder.decode(evaluation.stdout).trim();
}

Deno.test("fixed-point math exposes bounded arithmetic", async () => {
  assertEquals(
    await evaluate_fixture("math_values"),
    "(10, 7, 9, 4, -1, -3, 2, -3, -2, 2, -1, 125000, 2000000, 1500000)",
  );
});

Deno.test("two-dimensional vectors compose fixed-point positions", async () => {
  assertEquals(
    await evaluate_fixture("vec2_values"),
    "({ .x = 0; .y = 0; }, { .x = 4000000; .y = 6000000; }, { .x = 2000000; .y = 2000000; }, { .x = 500000; .y = 1000000; }, { .x = 1500000; .y = 2500000; })",
  );
});

Deno.test("fixed-point vectors compose spatial values", async () => {
  assertEquals(
    await evaluate_fixture("vector_values"),
    "({ .x = 0; .y = 0; .z = 0; }, { .x = 1000000; .y = 1000000; .z = 1000000; }, { .x = 4000000; .y = 6000000; .z = 8000000; }, { .x = 2000000; .y = 2000000; .z = 2000000; }, { .x = 500000; .y = 1000000; .z = 1500000; }, 26000000, 14000000, { .x = 1500000; .y = 2500000; .z = 3500000; })",
  );
});

Deno.test("scene constructors preserve transform and material values", async () => {
  assertEquals(
    await evaluate_fixture("scene_values"),
    "({ .position = { .x = 1; .y = 2; .z = 3; }; .rotation = { .x = 4; .y = 5; .z = 6; }; .scale = { .x = 7; .y = 7; .z = 7; }; }, { .blend_edges = 0; .color = { .blue = 10; .green = 9; .red = 8; }; .emissive = 11; .path_connections = 0; .secondary_texture = -1; .surface_mode = 0; .texture = -1; .texture_offset = { .x = 0; .y = 0; .z = 0; }; .texture_scale = { .x = 1000000; .y = 1000000; .z = 0; }; .variation_seed = 0; })",
  );
});

Deno.test("scene exposes mesh-local tiled surfaces", async () => {
  assertEquals(await evaluate_fixture("surface_values"), "3");
});

Deno.test("HTML-in-Canvas constructors preserve size, attachment, and style", async () => {
  assertEquals(
    await evaluate_fixture("html_canvas_values"),
    '({ .height = 56; .width = 144; }, { .object = 2; .offset = { .x = 3; .y = 4; .z = 5; }; .size = { .height = 500000; .width = 1200000; }; }, { .object = -2; .offset = { .x = 16; .y = 24; .z = 0; }; .size = { .height = 0; .width = 0; }; }, { .background_color = "black"; .border_color = "amber"; .border_radius = 10; .border_width = 2; .color = "white"; .font_size = 14; .font_weight = 600; })',
  );
});

Deno.test("tilemaps check bounds and convert orthogonal and isometric coordinates", async () => {
  assertEquals(
    await evaluate_fixture("tilemap_values"),
    "(#True, #True, #False, #False, #Some 11, #None, #Some { .x = 3; .y = 2; }, #None, { .x = -128; .y = 96; }, { .x = -1; .y = 1; }, { .x = 64; .y = 96; }, { .x = 2; .y = 1; }, { .x = -192; .y = -32; }, { .x = -2; .y = 1; }, { .x = -32; .y = -16; })",
  );
});
