export interface ShrubberyVoxel {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scale: number;
  readonly color: readonly [number, number, number];
}

export interface ShrubberyOption {
  readonly key: number;
  readonly name: string;
}

export interface ShrubberyResult {
  readonly frames: number;
  readonly options: readonly ShrubberyOption[];
  readonly selected: ShrubberyOption;
  readonly voxels: readonly ShrubberyVoxel[];
}

export async function run_shrubbery_guest(
  wasm_bytes: BufferSource,
  selection: number,
  seed: number,
): Promise<ShrubberyResult> {
  if (!Number.isSafeInteger(selection) || selection < 1 || selection > 5) {
    throw new Error(
      `shrubbery selection ${selection} must be an integer in 1..5`,
    );
  }
  if (!Number.isSafeInteger(seed)) {
    throw new Error(`shrubbery seed ${seed} must be a safe integer`);
  }
  let instance: WebAssembly.Instance | undefined;
  const options: ShrubberyOption[] = [];
  const voxels: ShrubberyVoxel[] = [];
  let selected: ShrubberyOption | undefined;
  const read_text = (pointer: bigint, length: bigint): string => {
    const memory = instance?.exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) {
      throw new Error("shrubbery guest memory is unavailable");
    }
    return new TextDecoder().decode(
      new Uint8Array(memory.buffer, Number(pointer), Number(length)),
    );
  };
  const imports = {
    "blot:host/Host": {
      option(key: bigint, pointer: bigint, length: bigint) {
        options.push({ key: Number(key), name: read_text(pointer, length) });
      },
      seed: () => BigInt(seed),
      selected(key: bigint, pointer: bigint, length: bigint) {
        selected = { key: Number(key), name: read_text(pointer, length) };
      },
      selection: () => BigInt(selection),
      frame: () => 0n,
    },
    "blot:host/VoxelCanvas": {
      clear() {
        voxels.length = 0;
      },
      voxel(
        blue: bigint,
        green: bigint,
        red: bigint,
        scale: bigint,
        x: bigint,
        y: bigint,
        z: bigint,
      ) {
        voxels.push({
          x: Number(x) / 1_000,
          y: Number(y) / 1_000,
          z: Number(z) / 1_000,
          scale: Number(scale) / 1_000,
          color: [Number(red) / 255, Number(green) / 255, Number(blue) / 255],
        });
      },
      present() {},
      redraw() {},
    },
  };
  const module = await WebAssembly.compile(wasm_bytes);
  instance = await WebAssembly.instantiate(module, imports);
  const run = instance.exports["blot:default"];
  if (!(run instanceof Function)) {
    throw new Error("shrubbery guest omitted blot:default");
  }
  const frames = run();
  if (typeof frames !== "bigint") {
    throw new Error(
      `shrubbery guest returned ${typeof frames}; expected bigint`,
    );
  }
  if (selected === undefined) {
    throw new Error("shrubbery guest omitted its selected recipe");
  }
  return { frames: Number(frames), options, selected, voxels };
}
