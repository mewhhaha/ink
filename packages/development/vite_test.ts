import { assert, assertEquals, assertRejects } from "@std/assert";
import { game_updated_event } from "./hot_reload.ts";
import { ink } from "./vite.ts";

Deno.test("a Blot update compiles before notifying the game client", async () => {
  const package_directory = new URL("./", import.meta.url);
  const source_directory = new URL(
    "../../apps/game-dev/blot/",
    import.meta.url,
  );
  const plugin = ink({
    source_directories: [source_directory],
    public_directory: new URL(
      "../../apps/game-dev/generated/",
      import.meta.url,
    ),
    build: {
      command: Deno.execPath(),
      arguments: ["eval", ""],
      working_directory: package_directory,
    },
    compiler_service: {
      command: Deno.execPath(),
      arguments: [
        "eval",
        'console.log("Blot compiler service listening at http://127.0.0.1:4765"); setInterval(() => {}, 1_000)',
      ],
      working_directory: package_directory,
      url_environment: "TEST_BLOT_COMPILER_URL",
    },
  });
  const hot_update = plugin.hotUpdate;
  assert(typeof hot_update === "function", "Ink did not install its HMR hook");
  const emitted_events: string[] = [];

  const modules = await hot_update.call(
    {
      environment: {
        name: "client",
        hot: {
          send(event: string) {
            emitted_events.push(event);
          },
        },
      },
    } as never,
    {
      file: new URL("game/main.blot", source_directory).pathname,
    } as never,
  );

  assertEquals(modules, []);
  assertEquals(emitted_events, [game_updated_event]);
});

Deno.test("a failed Blot update leaves the running game untouched", async () => {
  const package_directory = new URL("./", import.meta.url);
  const source_directory = new URL(
    "../../apps/game-dev/blot/",
    import.meta.url,
  );
  const plugin = ink({
    source_directories: [source_directory],
    public_directory: new URL(
      "../../apps/game-dev/generated/",
      import.meta.url,
    ),
    build: {
      command: Deno.execPath(),
      arguments: ["eval", "Deno.exit(9)"],
      working_directory: package_directory,
    },
    compiler_service: {
      command: Deno.execPath(),
      arguments: [
        "eval",
        'console.log("Blot compiler service listening at http://127.0.0.1:4765"); setInterval(() => {}, 1_000)',
      ],
      working_directory: package_directory,
      url_environment: "TEST_BLOT_COMPILER_URL",
    },
  });
  const hot_update = plugin.hotUpdate;
  assert(typeof hot_update === "function", "Ink did not install its HMR hook");
  const emitted_events: string[] = [];

  await assertRejects(
    async () =>
      await hot_update.call(
        {
          environment: {
            name: "client",
            hot: {
              send(event: string) {
                emitted_events.push(event);
              },
            },
          },
        } as never,
        {
          file: new URL("game/main.blot", source_directory).pathname,
        } as never,
      ),
    Error,
    "game compiler exited with code 9",
  );
  assertEquals(emitted_events, []);
});

Deno.test("development builds reuse one resident Blot compiler service", async () => {
  const package_directory = new URL("./", import.meta.url);
  const source_directory = new URL(
    "../../apps/game-dev/blot/",
    import.meta.url,
  );
  const expected_url = "http://127.0.0.1:41873/";
  const plugin = ink({
    source_directories: [source_directory],
    public_directory: new URL(
      "../../apps/game-dev/generated/",
      import.meta.url,
    ),
    build: {
      command: Deno.execPath(),
      arguments: [
        "eval",
        `if (Deno.env.get("TEST_BLOT_COMPILER_URL") !== ${
          JSON.stringify(expected_url)
        }) Deno.exit(7)`,
      ],
      working_directory: package_directory,
    },
    compiler_service: {
      command: Deno.execPath(),
      arguments: [
        "eval",
        `console.log("Blot compiler service listening at ${expected_url}"); setInterval(() => {}, 1_000)`,
      ],
      working_directory: package_directory,
      url_environment: "TEST_BLOT_COMPILER_URL",
    },
  });
  const config_resolved = plugin.configResolved;
  assert(
    typeof config_resolved === "function",
    "Ink did not install its configuration hook",
  );
  const build_start = plugin.buildStart;
  assert(
    typeof build_start === "function",
    "Ink did not install its build hook",
  );
  const close_bundle = plugin.closeBundle;
  assert(
    typeof close_bundle === "function",
    "Ink did not install its shutdown hook",
  );

  await config_resolved.call({} as never, { command: "serve" } as never);
  try {
    await build_start.call({} as never, {} as never);
    await build_start.call({} as never, {} as never);
  } finally {
    await close_bundle.call({} as never);
  }
});
