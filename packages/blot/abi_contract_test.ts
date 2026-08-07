import { assert, assertEquals } from "@std/assert";
import { create_blot_artifact_loader } from "./src/adapter.ts";

const decoder = new TextDecoder();
const blot_cli = new URL("../../../blot/src/cli.ts", import.meta.url);
const fixture = new URL("./testdata/abi_contract.blot", import.meta.url);
const wasm_artifact = new URL("./testdata/abi_contract.wasm", import.meta.url);
const manifest_artifact = new URL(
  "./testdata/abi_contract.wasm.json",
  import.meta.url,
);

Deno.test("Blot adapter loads scene components across the complete host ABI", async () => {
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

  const load_artifact = create_blot_artifact_loader({
    game_id: "abi_contract",
  });
  const { context, guest } = await load_artifact(wasm_bytes, manifest_source);
  assertEquals(context.game_id, "abi_contract");
  assert(context.artifact_digest.length > 0);
  assert(context.schema_digest.length > 0);
  const viewport = { width: 1280, height: 720 };

  const state = { scalar: 17n, cells: [] };
  assertEquals(guest.start(), state);
  assertEquals(guest.step(state, 1, 2, 3, 4), {
    scalar: 27n,
    cells: [],
  });
  assertEquals(guest.describe(state, viewport), {
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
          type: "viewport",
          anchor: "top_right",
          inset: [606, 707],
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
  assertEquals(guest.render(state, viewport), {
    projection: "orthographic",
    camera_zoom: 1.25,
    directional_light: {
      type: "directional_light",
      color: [0.8, 0.7, 0.6],
      direction: [-0.1, -0.2, -0.3],
      intensity: 0.9,
    },
    nodes: [],
    resources: [
      { type: "mesh", id: 18, url: "/contract.obj" },
      { type: "texture", id: 19, url: "/contract.png" },
      { type: "texture", id: 20, url: "/contract-secondary.png" },
    ],
    objects: [{
      type: "scene_object",
      id: 7,
      mesh: 6,
      parent: 73,
      color: [0.25, 0.5, 0.75],
      emissive: 0.125,
      texture: 19,
      texture_offset: [0.15, 0.16],
      secondary_texture: 20,
      texture_scale: [0.17, 0.18],
      blend_edges: 5,
      variation_seed: 123,
      surface_mode: 2,
      path_connections: 9,
      rotation_radians: [-0.25, 0.5, -0.75],
      position: [1280, 720, -3000000],
      scale: [1000000, 2000000, 3000000],
      visible: false,
    }],
  });
});
