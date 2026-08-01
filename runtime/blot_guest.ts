import type { BlotManifest } from "./blot_manifest.ts";
import type {
  GameStatus,
  GameViewport,
  Projection,
  RenderSnapshot,
  SemanticRegion,
} from "./protocol.ts";

interface GuestExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly "blot:init": (previous: bigint) => bigint;
  readonly "blot:step": (
    state: bigint,
    action_kind: bigint,
    target: bigint,
    value: bigint,
    delta_us: bigint,
  ) => bigint;
  readonly "blot:observe": (
    state: bigint,
    width: bigint,
    height: bigint,
  ) => bigint;
  readonly "blot:prepare_render": () => void;
  readonly "blot:render": (
    state: bigint,
    width: bigint,
    height: bigint,
  ) => void;
}

interface ObservationCapture {
  readonly count: number;
  readonly regions: readonly SemanticRegion[];
  readonly status: GameStatus;
}

export interface BlotGuest {
  init(previous: bigint): bigint;
  step(
    state: bigint,
    action_kind: number,
    target: number,
    value: number,
    delta_us: number,
  ): bigint;
  observe(state: bigint, viewport: GameViewport): ObservationCapture;
  render(state: bigint, viewport: GameViewport): RenderSnapshot;
}

export async function create_blot_guest(
  wasm_bytes: Uint8Array,
  _manifest: BlotManifest,
): Promise<BlotGuest> {
  const memory_reference: { current?: WebAssembly.Memory } = {};
  let regions: SemanticRegion[] = [];
  let status: GameStatus | undefined;
  let projection: Projection = "perspective";
  let beacons: RenderSnapshot["beacons"] = [];

  const read_text = (pointer: number, length: number): string => {
    if (!memory_reference.current) {
      throw new Error("Blot guest memory is unavailable");
    }
    return new TextDecoder().decode(
      new Uint8Array(memory_reference.current.buffer, pointer, length),
    );
  };

  const imports = {
    "blot:host/Semantic": {
      region: (
        description_pointer: number,
        description_length: number,
        height: bigint,
        id_pointer: number,
        id_length: number,
        label_pointer: number,
        label_length: number,
        left: bigint,
        order: bigint,
        pressed: number,
        selected: number,
        top: bigint,
        width: bigint,
      ) => {
        const id = read_text(id_pointer, id_length);
        const target = Number(id.slice("beacon-".length));
        regions.push({
          id,
          role: "button",
          label: read_text(label_pointer, label_length),
          description: read_text(description_pointer, description_length),
          bounds: {
            left: Number(left),
            top: Number(top),
            width: Number(width),
            height: Number(height),
          },
          order: Number(order),
          pressed: pressed !== 0,
          selected: selected !== 0,
          actions: [
            {
              id: `focus:${id}`,
              label: `Focus ${id}`,
              action: { type: "focus", target },
            },
            {
              id: `activate:${id}`,
              label: `Activate ${id}`,
              action: { type: "activate", target },
            },
          ],
        });
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
      beacon: (
        id: bigint,
        lit: number,
        selected: number,
        x: bigint,
        y: bigint,
        z: bigint,
      ) => {
        beacons = [...beacons, {
          type: "beacon" as const,
          id: Number(id),
          lit: lit !== 0,
          selected: selected !== 0,
          position: [Number(x), Number(y), Number(z)] as const,
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

  return {
    init(previous) {
      return guest["blot:init"](previous);
    },
    step(state, action_kind, target, value, delta_us) {
      return guest["blot:step"](
        state,
        BigInt(action_kind),
        BigInt(target),
        BigInt(value),
        BigInt(delta_us),
      );
    },
    observe(state, viewport) {
      regions = [];
      status = undefined;
      const count = Number(guest["blot:observe"](
        state,
        BigInt(viewport.width),
        BigInt(viewport.height),
      ));
      if (!status) throw new Error("Blot observe did not emit a game status");
      return {
        count,
        regions: [...regions].sort((left, right) => left.order - right.order),
        status,
      };
    },
    render(state, viewport) {
      beacons = [];
      guest["blot:prepare_render"]();
      guest["blot:render"](
        state,
        BigInt(viewport.width),
        BigInt(viewport.height),
      );
      return { projection, beacons };
    },
  };
}
