import type { BlotManifest } from "./manifest.ts";
import type { GameGuest } from "@ink/engine/guest.ts";
import type {
  ActionDescription,
  GameStatus,
  GameViewport,
  Projection,
  RenderSnapshot,
  SemanticRegion,
} from "@ink/engine/protocol.ts";

interface GuestExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly "blot:step": () => void;
}

type PhaseInvocation =
  | { readonly type: "start"; readonly state: bigint }
  | {
    readonly type: "step";
    readonly state: bigint;
    readonly event_kind: number;
    readonly target: number;
    readonly value: number;
    readonly delta_us: number;
  }
  | {
    readonly type: "describe";
    readonly state: bigint;
    readonly viewport: GameViewport;
  }
  | {
    readonly type: "render";
    readonly state: bigint;
    readonly viewport: GameViewport;
  };

export async function create_blot_guest(
  wasm_bytes: Uint8Array,
  _manifest: BlotManifest,
): Promise<GameGuest> {
  const memory_reference: { current?: WebAssembly.Memory } = {};
  let actions: ActionDescription[] = [];
  let regions: SemanticRegion[] = [];
  let status: GameStatus | undefined;
  let projection: Projection | undefined;
  let objects: RenderSnapshot["objects"] = [];
  let object_meshes = new Map<number, number>();
  let active_invocation: PhaseInvocation | undefined;
  let committed_state: bigint | undefined;

  const read_text = (pointer: number, length: number): string => {
    if (!memory_reference.current) {
      throw new Error("Blot guest memory is unavailable");
    }
    return new TextDecoder().decode(
      new Uint8Array(memory_reference.current.buffer, pointer, length),
    );
  };

  const imports = {
    "blot:host/Phase": {
      current: () => {
        const request = active_invocation;
        if (request === undefined) {
          throw new Error("Blot requested its phase outside a game step");
        }
        switch (request.type) {
          case "start":
            return 0n;
          case "step":
            return 1n;
          case "describe":
            return 2n;
          case "render":
            return 3n;
        }
      },
    },
    "blot:host/State": {
      current: () => {
        const request = active_invocation;
        if (request === undefined) {
          throw new Error("Blot requested state outside a game step");
        }
        return request.state;
      },
      commit: (state: bigint) => {
        if (active_invocation === undefined) {
          throw new Error("Blot committed state outside a game step");
        }
        if (committed_state !== undefined) {
          throw new Error("Blot committed game state more than once");
        }
        committed_state = state;
      },
    },
    "blot:host/Viewport": {
      current: (result_pointer: number) => {
        const request = active_invocation;
        if (request?.type !== "describe" && request?.type !== "render") {
          throw new Error(
            "Blot requested the viewport outside an output phase",
          );
        }
        if (!memory_reference.current) {
          throw new Error("Blot guest memory is unavailable");
        }
        const view = new DataView(memory_reference.current.buffer);
        view.setBigInt64(
          result_pointer,
          BigInt(request.viewport.height),
          true,
        );
        view.setBigInt64(
          result_pointer + 8,
          BigInt(request.viewport.width),
          true,
        );
      },
    },
    "blot:host/Events": {
      next: (result_pointer: number) => {
        const request = active_invocation;
        if (request?.type !== "step") {
          throw new Error("Blot requested an event outside a game step");
        }
        if (!memory_reference.current) {
          throw new Error("Blot guest memory is unavailable");
        }
        const view = new DataView(memory_reference.current.buffer);
        view.setBigInt64(result_pointer, BigInt(request.event_kind), true);
        view.setBigInt64(result_pointer + 8, BigInt(request.target), true);
        view.setBigInt64(result_pointer + 16, BigInt(request.value), true);
      },
    },
    "blot:host/Time": {
      delta_us: () => {
        const request = active_invocation;
        if (request?.type !== "step") {
          throw new Error("Blot requested delta time outside a game step");
        }
        return BigInt(request.delta_us);
      },
    },
    "blot:host/Semantic": {
      action: (
        id_pointer: number,
        id_length: number,
        kind: bigint,
        label_pointer: number,
        label_length: number,
        target: bigint,
        value: bigint,
      ) => {
        const id = read_text(id_pointer, id_length);
        actions.push({
          id,
          label: read_text(label_pointer, label_length),
          action: {
            type: "custom",
            kind: Number(kind),
            target: Number(target),
            value: Number(value),
          },
        });
      },
      element: (element_pointer: number) => {
        // Blot lowers records beyond its flat-parameter limit to one canonical ABI pointer.
        if (!memory_reference.current) {
          throw new Error("Blot guest memory is unavailable");
        }
        const view = new DataView(memory_reference.current.buffer);
        const description_pointer = view.getUint32(element_pointer, true);
        const description_length = view.getUint32(element_pointer + 4, true);
        const element_height = view.getBigInt64(element_pointer + 8, true);
        const element_width = view.getBigInt64(element_pointer + 16, true);
        const id_pointer = view.getUint32(element_pointer + 24, true);
        const id_length = view.getUint32(element_pointer + 28, true);
        const kind = view.getBigInt64(element_pointer + 32, true);
        const label_pointer = view.getUint32(element_pointer + 40, true);
        const label_length = view.getUint32(element_pointer + 44, true);
        const maximum = view.getBigInt64(element_pointer + 48, true);
        const object = view.getBigInt64(element_pointer + 56, true);
        const offset_x = view.getBigInt64(element_pointer + 64, true);
        const offset_y = view.getBigInt64(element_pointer + 72, true);
        const offset_z = view.getBigInt64(element_pointer + 80, true);
        const order = view.getBigInt64(element_pointer + 88, true);
        const plane_height = view.getBigInt64(element_pointer + 96, true);
        const plane_width = view.getBigInt64(element_pointer + 104, true);
        const pressed = view.getUint8(element_pointer + 112);
        const selected = view.getUint8(element_pointer + 113);
        const background_color_pointer = view.getUint32(
          element_pointer + 120,
          true,
        );
        const background_color_length = view.getUint32(
          element_pointer + 124,
          true,
        );
        const border_color_pointer = view.getUint32(
          element_pointer + 128,
          true,
        );
        const border_color_length = view.getUint32(
          element_pointer + 132,
          true,
        );
        const border_radius = view.getBigInt64(element_pointer + 136, true);
        const border_width = view.getBigInt64(element_pointer + 144, true);
        const color_pointer = view.getUint32(element_pointer + 152, true);
        const color_length = view.getUint32(element_pointer + 156, true);
        const font_size = view.getBigInt64(element_pointer + 160, true);
        const font_weight = view.getBigInt64(element_pointer + 168, true);
        const target = view.getBigInt64(element_pointer + 176, true);
        const value = view.getBigInt64(element_pointer + 184, true);
        const id = read_text(id_pointer, id_length);
        const common_region = {
          id,
          label: read_text(label_pointer, label_length),
          description: read_text(description_pointer, description_length),
          element_size: {
            width: Number(element_width),
            height: Number(element_height),
          },
          placement: {
            type: "scene_object",
            object: Number(object),
            offset: [
              Number(offset_x),
              Number(offset_y),
              Number(offset_z),
            ],
            size: [Number(plane_width), Number(plane_height)],
          },
          style: {
            background_color: read_text(
              background_color_pointer,
              background_color_length,
            ),
            border_color: read_text(
              border_color_pointer,
              border_color_length,
            ),
            border_radius: Number(border_radius),
            border_width: Number(border_width),
            color: read_text(color_pointer, color_length),
            font_size: Number(font_size),
            font_weight: Number(font_weight),
          },
          order: Number(order),
        } as const;
        if (kind === 0n) {
          regions.push({
            ...common_region,
            role: "button",
            target: Number(target),
            pressed: pressed !== 0,
            selected: selected !== 0,
            actions: [
              {
                id: `focus:${id}`,
                label: `Focus ${id}`,
                action: { type: "focus", target: Number(target) },
              },
              {
                id: `activate:${id}`,
                label: `Activate ${id}`,
                action: { type: "activate", target: Number(target) },
              },
            ],
          });
          return;
        }
        if (kind === 1n) {
          regions.push({ ...common_region, role: "text", actions: [] });
          return;
        }
        if (kind === 2n) {
          regions.push({
            ...common_region,
            role: "progress",
            maximum: Number(maximum),
            value: Number(value),
            actions: [],
          });
          return;
        }
        throw new Error(
          `semantic element ${JSON.stringify(id)} has unsupported kind ${kind}`,
        );
      },
      status: (
        done: number,
        label_pointer: number,
        label_length: number,
        value_pointer: number,
        value_length: number,
      ) => {
        status = {
          done: done !== 0,
          label: read_text(label_pointer, label_length),
          value: read_text(value_pointer, value_length),
        };
      },
    },
    "blot:host/Render": {
      mesh: (id: bigint, mesh: bigint) => {
        object_meshes.set(Number(id), Number(mesh));
      },
      object: (
        color_blue: bigint,
        color_green: bigint,
        color_red: bigint,
        emissive: bigint,
        id: bigint,
        parent: bigint,
        rotation_x_microradians: bigint,
        rotation_y_microradians: bigint,
        rotation_z_microradians: bigint,
        scale_x: bigint,
        scale_y: bigint,
        scale_z: bigint,
        visible: number,
        x: bigint,
        y: bigint,
        z: bigint,
      ) => {
        const object_id = Number(id);
        const mesh = object_meshes.get(object_id);
        if (mesh === undefined) {
          throw new Error(`scene object ${object_id} did not select a mesh`);
        }
        objects = [...objects, {
          type: "scene_object" as const,
          id: object_id,
          mesh,
          parent: parent < 0n ? null : Number(parent),
          color: [
            Number(color_red) / 1_000_000,
            Number(color_green) / 1_000_000,
            Number(color_blue) / 1_000_000,
          ],
          emissive: Number(emissive) / 1_000_000,
          rotation_radians: [
            Number(rotation_x_microradians) / 1_000_000,
            Number(rotation_y_microradians) / 1_000_000,
            Number(rotation_z_microradians) / 1_000_000,
          ],
          position: [Number(x), Number(y), Number(z)] as const,
          scale: [Number(scale_x), Number(scale_y), Number(scale_z)] as const,
          visible: visible !== 0,
        }];
      },
      projection: (value: bigint) => {
        projection = value === 0n ? "perspective" : "orthographic";
      },
    },
  };

  const module = await WebAssembly.compile(new Uint8Array(wasm_bytes).buffer);
  const instantiated = await WebAssembly.instantiate(module, imports);
  const guest = instantiated.exports as GuestExports;
  memory_reference.current = guest.memory;

  const run_phase = (request: PhaseInvocation): bigint | undefined => {
    if (active_invocation !== undefined) {
      throw new Error("Blot game phases cannot be nested");
    }
    active_invocation = request;
    committed_state = undefined;
    try {
      guest["blot:step"]();
      return committed_state;
    } finally {
      active_invocation = undefined;
    }
  };

  const run_state_phase = (request: PhaseInvocation): bigint => {
    const next_state = run_phase(request);
    if (next_state === undefined) {
      throw new Error(
        `Blot ${request.type} phase did not commit state`,
      );
    }
    return next_state;
  };

  return {
    start() {
      return run_state_phase({
        type: "start",
        state: 0n,
      });
    },
    step(state, event_kind, target, value, delta_us) {
      return run_state_phase({
        type: "step",
        state,
        event_kind,
        target,
        value,
        delta_us,
      });
    },
    describe(state, viewport) {
      actions = [];
      regions = [];
      status = undefined;
      const unexpected_state = run_phase({
        type: "describe",
        state,
        viewport,
      });
      if (unexpected_state !== undefined) {
        throw new Error("Blot description unexpectedly committed game state");
      }
      if (!status) throw new Error("Blot describe did not emit a game status");
      return {
        actions,
        regions: [...regions].sort((left, right) => left.order - right.order),
        status,
      };
    },
    render(state, viewport) {
      objects = [];
      object_meshes = new Map();
      projection = undefined;
      const unexpected_state = run_phase({
        type: "render",
        state,
        viewport,
      });
      if (unexpected_state !== undefined) {
        throw new Error("Blot rendering unexpectedly committed game state");
      }
      if (projection === undefined) {
        throw new Error("Blot render did not emit a projection");
      }
      return { projection, objects };
    },
  };
}
