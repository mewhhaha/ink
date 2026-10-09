/** The terrain example's heightfield and placements are generated, not
 * checked in. Tests that open it call this first, so a fresh checkout works. */
export async function ensureTerrainData(): Promise<void> {
  const root = new URL("../examples/terrain/", import.meta.url);
  try {
    await Deno.stat(new URL("assets/terrain/world.terrain", root));
    return;
  } catch {
    // Generate below.
  }
  console.log("generating examples/terrain data (deno task gen:terrain)");
  const { code } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", new URL("scripts/generate.ts", root).pathname],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (code) throw new Error("deno task gen:terrain failed");
}
