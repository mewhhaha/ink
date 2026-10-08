import { assertEquals } from "@std/assert";
import {
  defineSchema,
  enumOf,
  list,
  standard,
  struct,
  u32,
  vec3,
} from "./mod.ts";
import { generateTypeScript } from "./typescript.ts";

Deno.test("generated TS checks fields, enum values, vectors, events and typed hooks", async () => {
  const schema = defineSchema({
    components: {
      transform: standard.transform,
      walker: {
        mood: enumOf(["calm", "eager"]),
        path: list(vec3()),
        stats: struct({ hp: u32() }),
      },
    },
    resources: { score: { value: u32() } },
    events: { hit: { amount: u32() } },
  });
  const dir = await Deno.makeTempDir({ prefix: "ink-types-" });
  try {
    await Deno.writeTextFile(
      `${dir}/schema.gen.ts`,
      generateTypeScript(schema),
    );
    await Deno.writeTextFile(
      `${dir}/check.ts`,
      `
import type { World, Walker, Event } from "./schema.gen.ts";
import { createSchemaHooks } from ${
        JSON.stringify(new URL("../react/typed.ts", import.meta.url).href)
      };
declare const walker: Walker;
walker.mood = "eager";
walker.path.push([1, 2, 3]);
walker.stats.hp = 3;
// @ts-expect-error invalid enum variant
walker.mood = "tired";
// @ts-expect-error wrong vector size
walker.path.push([1, 2]);
// @ts-expect-error unknown nested field
walker.stats.health = 1;
const hooks = createSchemaHooks<World>();
const score: number = hooks.useResource("score").value;
// @ts-expect-error unknown resource
hooks.useResource("missing");
// @ts-expect-error unknown component
hooks.useComponent(1, "missing");
declare const event: Event;
const amount: number = event.value.amount;
// @ts-expect-error unknown event payload
event.value.damage;
export { score, amount };
`,
    );
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "check",
        "--config",
        new URL("../../deno.json", import.meta.url).pathname,
        `${dir}/check.ts`,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
