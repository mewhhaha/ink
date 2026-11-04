import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { instantiateGuest } from "../../blot2/host/guest.ts";
import { createZigProjectCompiler } from "../../blot2/host/zig_project_client.ts";

const gameRoot = fileURLToPath(new URL("../../gdev/", import.meta.url));
const config = JSON.parse(await Deno.readTextFile(`${gameRoot}/pen.json`));
const settings = config.compiler.settings;
const stdRoot = fileURLToPath(new URL("../../blot2/std/", import.meta.url));
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const faceLanes = (count: number) =>
  Array.from({ length: count }, (_, i) => [0, 1, 0, i, 7 + i]).flat();

for (const codegenTier of ["development", "optimized"] as const) {
  Deno.test(`generated frame encoding preserves integer and payload lanes (${codegenTier})`, async () => {
    const compiler = await createZigProjectCompiler({
      executable: Deno.args[0] ??
        resolve(gameRoot, config.plugins.blot.run.blotc),
      entry: fileURLToPath(
        new URL("./pen_frame_encoding.blot", import.meta.url),
      ),
      prelude: `${stdRoot}/prelude.blot`,
      stdRoot,
      imports: Object.fromEntries(
        Object.entries(settings.imports).map((
          [prefix, path],
        ) => [prefix, resolve(gameRoot, path as string)]),
      ),
      inferenceBudget: settings.inferenceBudget,
      storage: settings.storage,
      cacheDirectory: false,
      codegenTier,
    });
    try {
      const result = await compiler.build();
      assert(result.success, JSON.stringify(result));
      for (const asynchronous of [false, true]) {
        const guest = await instantiateGuest(result.bytes, { asynchronous });
        const call = async (name: string, value: number) =>
          (asynchronous
            ? await guest.callAsync(name, value)
            : guest.call(name, value)) as Float32Array;
        try {
          for (const count of [0, 1, 3]) {
            assert.deepEqual(
              await call("solid", count),
              new Float32Array([count, ...faceLanes(count)]),
            );
            const packet = await call("packet", count);
            assert.equal(packet[0], 0x474446);
            assert.equal(packet[1], 26);
            assert.equal(packet[2], 0);
            assert.equal(packet[3], count ? 1 : 0);
            assert.equal(packet[4], count ? 1 : 0);
            assert.equal(packet[5], count ? 1 + 5 * count : 0);
            assert.deepEqual(
              packet.slice(9, 12),
              new Float32Array(count ? [1, 1, 14] : [0, 0, 0]),
            );
            assert.deepEqual(
              packet.slice(130, 134),
              new Float32Array(count ? [1, 9, 1, 27] : [0, 0, 0, 0]),
            );
            assert.deepEqual(
              packet.slice(146, 151),
              new Float32Array(count ? [1, 1, 1, 1, 1] : [0, 0, 0, 0, 0]),
            );
            const payload = count
              ? [
                7,
                9,
                ...identity,
                4,
                2,
                3,
                4,
                5,
                1,
                count,
                ...faceLanes(count),
                0,
                0,
                2,
                2,
                ...identity,
                ...identity,
                0,
                0,
                0,
                0,
                -1,
                0,
                0,
                0,
                0,
                1,
                1,
                0,
                11,
                13,
                ...identity,
                0,
                0,
                0,
                0,
                0,
                0,
                1,
                0,
                1,
                0,
                0,
                0,
                0,
                0,
                0,
                1,
                1,
                1,
                0,
                0,
                17,
                2,
                1,
                0,
                0,
                2,
                1,
                123,
                125,
                3,
                0,
                1,
                1,
                2,
                3,
                4,
                1,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                5,
                0,
                10,
                1,
                1,
                3,
                1,
                1,
                65,
                66,
                67,
                65535,
                65535,
                16777215,
                11,
                13,
                ...identity,
                0,
                0,
                0,
                0,
                0,
                0,
                1,
                10,
                -0,
                12,
                13,
                5260632,
                1,
                42,
                2,
                123,
                125,
              ]
              : [];
            assert.deepEqual(packet.slice(151), new Float32Array(payload));
          }
          for (const byte of [0, 255, 16777215]) {
            assert.deepEqual(
              await call("extension", byte),
              new Float32Array([byte]),
            );
          }
        } finally {
          guest.dispose();
        }
      }
    } finally {
      await compiler.dispose();
    }
  });
}
