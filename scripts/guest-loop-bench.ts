/**
 * Why Ink does not keep the world inside a suspended `for ever` loop.
 *
 * Compares one step of the stateless `step` entry (decode the packet, update,
 * encode) with a program that holds the decoded world across steps in a
 * JSPI-suspended loop (`docs/architecture.md`, "Keeping the world in the
 * guest"). The loop avoids decode and encode, but each fourth backedge traces
 * the whole object graph and allocation after a collection is slower: it wins
 * on average only while few entities change per step, and every fourth step
 * then costs a collection.
 *
 *   deno run -A scripts/guest-loop-bench.ts [--counts 5000,20000] [--movers 0.1,1]
 */
import { join } from "@std/path";
import {
  encodeInput,
  encodeWorld,
  idleInput,
  sceneToWorld,
  stepPacket,
} from "@ink/schema";
import { createGameCompiler, formatDiagnostic } from "@ink/blot/compiler";
import { instantiateGuest } from "@mewhhaha/blot/guest";
import { scanAssets } from "@ink/dev/catalog";
import schema from "./stress/schema.ts";
import { stressScene } from "./stress/world.ts";

const list = (name: string, fallback: string) => {
  const at = Deno.args.indexOf(`--${name}`);
  return (at >= 0 ? Deno.args[at + 1] : fallback).split(",").map(Number);
};
const counts = list("counts", "5000,20000");
const fractions = list("movers", "0.1,0.2,1");

// The persistent program: the host sends an input packet per step and gets the
// tick back. Nothing but the clock crosses the boundary.
const persistent = `
const first_u32 = fn (v: Array F32) => packet.u32 v 0
const advance = fn update => fn (input: Input) => fn (world: World) => do:
  let (seed, (next, events)) = do (@effect.state Random.get Random.set world.seed):
    return collect (@computation (fn () => update input world))
  let finished: World = next
  finished.seed := seed
  return (finished, events)
const serve = fn update => fn (host: Array F32 -> Array F32 ! { Foreign }) => do:
  use first <- host #[0.0]
  let world = decode_world first 0
  for ever:
    use following <- host #[from world.tick]
    if following.length < 2:
      return ()
    let input = decode_input following 1
    let (next, events) = advance update input world
    world := next
`;

const catalog = await scanAssets("scripts/stress/assets");
const source = await Deno.readTextFile("scripts/stress/game/main.blot");

async function build(tail: string, extra = "") {
  const dir = await Deno.makeTempDir({ prefix: "ink-loop-" });
  const entry = join(dir, "main.blot");
  await Deno.writeTextFile(
    entry,
    source.replace(/entry const step[^\n]*\n/, "") + tail,
  );
  const compiler = await createGameCompiler({ entry, schema, catalog });
  const generated = join(dir, "schema.gen.blot");
  await Deno.writeTextFile(
    generated,
    await Deno.readTextFile(generated) + extra,
  );
  const result = await compiler.build();
  await compiler.dispose();
  if (!result.ok) {
    throw new Error(result.diagnostics.map(formatDiagnostic).join("\n"));
  }
  return result.bytes;
}

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[values.length >> 1];

const stateless = await instantiateGuest(
  await build(
    "entry const step = fn (lanes: Array F32) -> Array F32 => s.run update lanes\n",
  ),
);
const bytes = await build(
  "entry const main = fn (host: Array F32 -> Array F32 ! { Foreign }) => s.serve update host\n",
  persistent,
);

for (const count of counts) {
  for (const fraction of fractions) {
    const movers = Math.round(count * fraction);
    const world =
      sceneToWorld(schema, stressScene(count, movers), catalog).world;
    const state = encodeWorld(schema, world);
    const input = encodeInput(schema, idleInput(schema));
    const packet = stepPacket(input, state);

    const flat: number[] = [];
    for (let i = 0; i < 24; i++) {
      const a = performance.now();
      stateless.call("step", packet);
      flat.push(performance.now() - a);
    }

    const guest = await instantiateGuest(bytes, { asynchronous: true });
    let reply = Promise.withResolvers<Float32Array>();
    let next = Promise.withResolvers<Float32Array>();
    const host = guest.capabilityAsync({
      parameter: "Array F32",
      result: "Array F32",
      call(value) {
        reply.resolve(value);
        return next.promise;
      },
    });
    void guest.callAsync("main", host);
    await reply.promise;
    const exchange = async (request: Float32Array) => {
      reply = Promise.withResolvers();
      const waiting = next;
      next = Promise.withResolvers();
      waiting.resolve(request);
      await reply.promise;
    };
    await exchange(state);
    const loop: number[] = [];
    for (let i = 0; i < 24; i++) {
      const a = performance.now();
      await exchange(packet.subarray(0, 1 + input.length));
      loop.push(performance.now() - a);
    }
    console.log(
      JSON.stringify({
        count,
        movers,
        statelessMedianMs: +median(flat.slice(4)).toFixed(2),
        loopMedianMs: +median(loop.slice(4)).toFixed(2),
        loopMeanMs: +(loop.slice(4).reduce((a, b) => a + b, 0) / 20).toFixed(2),
        loopMaxMs: +Math.max(...loop.slice(4)).toFixed(2),
      }),
    );
  }
}
stateless.dispose();
Deno.exit(0);
