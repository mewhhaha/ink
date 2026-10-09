/** `deno task test:terrain [--hardware] [--headed]`: the renderer checks and
 * the gate, both given the same flags. */
import { ensureTerrainData } from "./terrain-data.ts";

await ensureTerrainData();
for (const script of ["terrain-smoke.ts", "terrain-gate.ts"]) {
  const { code } = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      new URL(script, import.meta.url).pathname,
      ...Deno.args,
    ],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (code) Deno.exit(code);
}
