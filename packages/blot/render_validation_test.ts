import { assertThrows } from "@std/assert";
import { create_blot_guest } from "./src/guest.ts";
import { parse_blot_manifest } from "./src/manifest.ts";

const decoder = new TextDecoder();
const blot_cli = new URL("../../../blot/src/cli.ts", import.meta.url);
const fixture = new URL(
  "./testdata/render_validation_contract.blot",
  import.meta.url,
);
const wasm_artifact = new URL(
  "./testdata/render_validation_contract.wasm",
  import.meta.url,
);
const manifest_artifact = new URL(
  "./testdata/render_validation_contract.wasm.json",
  import.meta.url,
);

const invalid_render_scenarios: readonly {
  readonly name: string;
  readonly viewport_width: number;
  readonly expected_error: string;
}[] = [
  {
    name: "a render without a camera is rejected",
    viewport_width: 101,
    expected_error: "Blot render did not emit a camera",
  },
  {
    name: "a second camera is rejected",
    viewport_width: 102,
    expected_error: "Blot rendered more than one camera",
  },
  {
    name: "a zero perspective field of view is rejected",
    viewport_width: 103,
    expected_error:
      "Blot perspective camera vertical field of view 0 must be between 0 and pi radians",
  },
  {
    name: "a zero orthographic size is rejected",
    viewport_width: 104,
    expected_error: "Blot orthographic camera vertical size 0 must be positive",
  },
  {
    name: "a camera fixed-point value outside the safe range is rejected",
    viewport_width: 105,
    expected_error:
      "Blot perspective camera position x 9007199254740992 exceeds the safe fixed-point range",
  },
  {
    name: "an equal perspective camera position and target are rejected",
    viewport_width: 106,
    expected_error:
      "Blot perspective camera position [0,0,5] must differ from target [0,0,5]",
  },
  {
    name: "a render without an environment is rejected",
    viewport_width: 107,
    expected_error: "Blot render did not emit an environment",
  },
  {
    name: "a second environment is rejected",
    viewport_width: 108,
    expected_error: "Blot rendered more than one environment",
  },
  {
    name: "a negative fog density is rejected",
    viewport_width: 109,
    expected_error:
      "Blot environment fog density -0.000001 must not be negative",
  },
  {
    name: "a negative bloom intensity is rejected",
    viewport_width: 110,
    expected_error:
      "Blot environment bloom intensity -0.000001 must not be negative",
  },
  {
    name: "a negative directional-light color is rejected",
    viewport_width: 111,
    expected_error:
      "Blot directional light color red -0.000001 must be between 0 and 1",
  },
  {
    name: "a directional-light color above one is rejected",
    viewport_width: 112,
    expected_error:
      "Blot directional light color red 1.000001 must be between 0 and 1",
  },
  {
    name: "a zero directional-light direction is rejected",
    viewport_width: 113,
    expected_error: "Blot directional light direction [0,0,0] must not be zero",
  },
  {
    name: "a zero directional-light intensity is rejected",
    viewport_width: 114,
    expected_error: "Blot directional light intensity 0 must be positive",
  },
  {
    name: "a negative directional-light intensity is rejected",
    viewport_width: 115,
    expected_error:
      "Blot directional light intensity -0.000001 must be positive",
  },
  {
    name: "a directional-light fixed-point overflow is rejected",
    viewport_width: 116,
    expected_error:
      "Blot directional light intensity 9007199254740992 exceeds the safe fixed-point range",
  },
  {
    name: "a render without a directional light is rejected",
    viewport_width: 117,
    expected_error: "Blot render did not emit a directional light",
  },
  {
    name: "a second directional light is rejected",
    viewport_width: 118,
    expected_error: "Blot rendered more than one directional light",
  },
  {
    name: "an equal orthographic camera position and target are rejected",
    viewport_width: 119,
    expected_error:
      "Blot orthographic camera position [0,0,5] must differ from target [0,0,5]",
  },
  {
    name: "a perspective field of view above pi is rejected",
    viewport_width: 120,
    expected_error:
      "Blot perspective camera vertical field of view 3.141593 must be between 0 and pi radians",
  },
  {
    name: "a negative orthographic size is rejected",
    viewport_width: 121,
    expected_error:
      "Blot orthographic camera vertical size -0.000001 must be positive",
  },
];

Deno.test("Blot rejects malformed render presentation at the Wasm boundary", async (test) => {
  const build = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      blot_cli.pathname,
      "build",
      fixture.pathname,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!build.success) {
    throw new Error(
      `Blot render-validation fixture exited with code ${build.code}: ${
        decoder.decode(build.stderr).trim()
      }`,
    );
  }

  const [wasm_bytes, manifest_source] = await Promise.all([
    Deno.readFile(wasm_artifact),
    Deno.readTextFile(manifest_artifact),
  ]);
  await Promise.all([
    Deno.remove(wasm_artifact),
    Deno.remove(manifest_artifact),
  ]);
  const manifest = parse_blot_manifest(manifest_source);
  for (const scenario of invalid_render_scenarios) {
    await test.step(scenario.name, async () => {
      const guest = await create_blot_guest(
        wasm_bytes,
        manifest,
      );
      assertThrows(
        () =>
          guest.render(
            { scalar: 0n, cells: [] },
            { width: scenario.viewport_width, height: 720 },
          ),
        Error,
        scenario.expected_error,
      );
    });
  }
});
