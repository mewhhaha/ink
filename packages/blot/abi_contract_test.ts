import { assertEquals } from "@std/assert";
import { create_blot_guest } from "./src/guest.ts";
import { type BlotManifest, parse_blot_manifest } from "./src/manifest.ts";

const decoder = new TextDecoder();
const blot_cli = new URL("../../../blot/src/cli.ts", import.meta.url);
const fixture = new URL("./testdata/abi_contract.blot", import.meta.url);
const wasm_artifact = new URL("./testdata/abi_contract.wasm", import.meta.url);
const manifest_artifact = new URL(
  "./testdata/abi_contract.wasm.json",
  import.meta.url,
);

Deno.test("Blot scene components preserve their complete host ABI", async () => {
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
      `Blot ABI fixture exited with code ${build.code}: ${
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

  const manifest: BlotManifest = parse_blot_manifest(manifest_source);
  const guest = await create_blot_guest(wasm_bytes, manifest);
  const viewport = { width: 1280, height: 720 };

  assertEquals(guest.start(), 17n);
  assertEquals(guest.step(17n, 1, 2, 3, 4), 27n);
  assertEquals(guest.describe(17n, viewport), {
    actions: [{
      id: "contract-action",
      label: "Contract action",
      action: { type: "custom", kind: 41, target: 42, value: 43 },
    }],
    regions: [
      {
        id: "contract-text",
        label: "Contract text",
        description: "Text description",
        element_size: { width: 16, height: 15 },
        placement: {
          type: "scene_object",
          object: 8,
          offset: [606, 707, 808],
          size: [1010, 909],
        },
        style: {
          background_color: "text-background",
          border_color: "text-border",
          border_radius: 17,
          border_width: 18,
          color: "text-color",
          font_size: 19,
          font_weight: 20,
        },
        order: 10,
        role: "text",
        actions: [],
      },
      {
        id: "contract-progress",
        label: "Contract progress",
        description: "Progress description",
        element_size: { width: 22, height: 21 },
        placement: {
          type: "scene_object",
          object: 9,
          offset: [1111, 1212, 1313],
          size: [1515, 1414],
        },
        style: {
          background_color: "progress-background",
          border_color: "progress-border",
          border_radius: 23,
          border_width: 24,
          color: "progress-color",
          font_size: 25,
          font_weight: 26,
        },
        order: 20,
        role: "progress",
        maximum: 99,
        value: 37,
        actions: [],
      },
      {
        id: "contract-button",
        label: "Contract button",
        description: "Button description",
        element_size: { width: 1280, height: 720 },
        placement: {
          type: "scene_object",
          object: 7,
          offset: [101, 202, 303],
          size: [505, 404],
        },
        style: {
          background_color: "button-background",
          border_color: "button-border",
          border_radius: 11,
          border_width: 12,
          color: "button-color",
          font_size: 13,
          font_weight: 14,
        },
        order: 30,
        role: "button",
        target: 909,
        pressed: true,
        selected: false,
        actions: [
          {
            id: "focus:contract-button",
            label: "Focus contract-button",
            action: { type: "focus", target: 909 },
          },
          {
            id: "activate:contract-button",
            label: "Activate contract-button",
            action: { type: "activate", target: 909 },
          },
        ],
      },
    ],
    status: {
      done: true,
      label: "Contract status",
      value: "Complete",
    },
  });
  assertEquals(guest.render(17n, viewport), {
    projection: "orthographic",
    objects: [{
      type: "scene_object",
      id: 7,
      mesh: 6,
      parent: 73,
      color: [0.25, 0.5, 0.75],
      emissive: 0.125,
      rotation_radians: [-0.25, 0.5, -0.75],
      position: [1280, 720, -3000000],
      scale: [1000000, 2000000, 3000000],
      visible: false,
    }],
  });
});
