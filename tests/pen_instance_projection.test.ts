import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { instantiateGuest } from "../../blot2/compiler/guest.ts";
import { createZigProjectCompiler } from "../../blot2/compiler/zig_project_client.ts";

const gameRoot = fileURLToPath(new URL("../../gdev/", import.meta.url));
const config = JSON.parse(await Deno.readTextFile(`${gameRoot}/pen.json`));
const settings = config.compiler.settings;
const stdRoot = fileURLToPath(new URL("../../blot2/std/", import.meta.url));
const expected = (id: number, order: number) =>
  new Float32Array([
    id & 65535,
    id >>> 16,
    order,
    7,
    9,
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
    ...((id & 1) ? [4, -0, 2, -3, 4] : [0, 0, 0, 0, 0]),
  ]);

for (const codegenTier of ["development", "optimized"] as const) {
  Deno.test(`retained instance projection preserves all lanes and bounds (${codegenTier})`, async () => {
    const compiler = await createZigProjectCompiler({
      executable: Deno.args[0] ??
        resolve(gameRoot, config.plugins.blot.run.blotc),
      entry: fileURLToPath(
        new URL("./pen_instance_projection.blot", import.meta.url),
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
          asynchronous
            ? await guest.callAsync(name, value)
            : guest.call(name, value);
        try {
          for (const id of [0, 1, 2, 65536, 0xffffffff]) {
            assert.deepEqual(
              await call("packet", id),
              expected(id, (id & 2) ? 16777215 : 0),
            );
          }
          for (const order of [0, 16777215]) {
            assert.deepEqual(
              await call("checked_order", order),
              expected(0xffffffff, order),
            );
          }
          assert.deepEqual(
            await call("checked_extra", 0),
            expected(0xffffffff, 0),
          );
          await assert.rejects(
            () => call("checked_order", 16777216),
            WebAssembly.RuntimeError,
          );
          assert.deepEqual(await call("packet", 0), expected(0, 0));
          await assert.rejects(
            () => call("checked_extra", 1),
            WebAssembly.RuntimeError,
          );
          assert.deepEqual(await call("packet", 1), expected(1, 0));
        } finally {
          guest.dispose();
        }
      }
    } finally {
      await compiler.dispose();
    }
  });
}
