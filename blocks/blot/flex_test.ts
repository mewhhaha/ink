import { assertEquals } from "@std/assert";

const decoder = new TextDecoder();
const blotCli = new URL("../../../blot/src/cli.ts", import.meta.url);

async function evaluateFixture(name: string): Promise<string> {
  const fixture = new URL(`./testdata/${name}.blot`, import.meta.url);
  const checked = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", blotCli.pathname, "check", fixture.pathname],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!checked.success) {
    throw new Error(
      `Blot fixture ${JSON.stringify(name)} did not type check: ${
        decoder.decode(checked.stderr).trim()
      }`,
    );
  }
  const evaluation = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", blotCli.pathname, "eval", fixture.pathname],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!evaluation.success) {
    throw new Error(
      `Blot fixture ${
        JSON.stringify(name)
      } exited with code ${evaluation.code}: ${
        decoder.decode(evaluation.stderr).trim()
      }`,
    );
  }
  return decoder.decode(evaluation.stdout).trim();
}

Deno.test("flex growth distributes free space by grow weight", async () => {
  assertEquals(
    await evaluateFixture("flex_grow"),
    "[{ .left = 10; .top = 20; .width = 35; .height = 10; }, { .left = 55; .top = 20; .width = 65; .height = 10; }]",
  );
});

Deno.test("flex shrink uses basis-scaled shrink weight", async () => {
  assertEquals(
    await evaluateFixture("flex_shrink"),
    "[{ .left = 15; .top = 0; .width = 48; .height = 10; }, { .left = 68; .top = 0; .width = 22; .height = 10; }]",
  );
});

Deno.test("row reverse starts at the right padding edge", async () => {
  assertEquals(
    await evaluateFixture("flex_reverse"),
    "[{ .left = 75; .top = 7; .width = 10; .height = 10; }, { .left = 15; .top = 7; .width = 10; .height = 10; }]",
  );
});

Deno.test("cross-axis alignment respects margins and align-self", async () => {
  assertEquals(
    await evaluateFixture("flex_cross_axis"),
    "[{ .left = 10; .top = 47; .width = 20; .height = 10; }, { .left = 30; .top = 32; .width = 20; .height = 40; }, { .left = 50; .top = 62; .width = 20; .height = 10; }]",
  );
});

Deno.test("column reverse applies main and cross alignment", async () => {
  assertEquals(
    await evaluateFixture("flex_column_reverse"),
    "[{ .left = 50; .top = 68; .width = 10; .height = 20; }, { .left = 50; .top = 43; .width = 10; .height = 20; }]",
  );
});

Deno.test("column layout prefers flex basis over height", async () => {
  assertEquals(
    await evaluateFixture("flex_column_basis"),
    "[{ .left = 5; .top = 50; .width = 10; .height = 30; }, { .left = 5; .top = 90; .width = 10; .height = 20; }]",
  );
});

Deno.test("space-around leaves half-size spaces at the edges", async () => {
  assertEquals(
    await evaluateFixture("flex_space_around"),
    "[{ .left = 20; .top = 0; .width = 10; .height = 10; }, { .left = 70; .top = 0; .width = 10; .height = 10; }]",
  );
});

Deno.test("space-evenly gives edges and interior equal integer shares", async () => {
  assertEquals(
    await evaluateFixture("flex_space_evenly"),
    "[{ .left = 26; .top = 0; .width = 10; .height = 10; }, { .left = 62; .top = 0; .width = 10; .height = 10; }]",
  );
});

Deno.test("empty flex containers produce no frames", async () => {
  assertEquals(await evaluateFixture("flex_empty"), "[]");
});
