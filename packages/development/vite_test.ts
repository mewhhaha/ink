import { assert, assertEquals, assertRejects } from "@std/assert";
import { pathToFileURL } from "node:url";
import { game_updated_event } from "./hot_reload.ts";
import { ink } from "./vite.ts";

Deno.test("a Blot update compiles before notifying the game client", async () => {
  const package_directory = new URL("./", import.meta.url);
  const source_directory = new URL(
    "../../apps/game-dev/src/blot/",
    import.meta.url,
  );
  const plugin = ink({
    source_directories: [source_directory],
    resource_directories: [],
    public_directory: new URL(
      "../../apps/game-dev/generated/",
      import.meta.url,
    ),
    build: {
      command: Deno.execPath(),
      arguments: ["eval", ""],
      working_directory: package_directory,
    },
  });
  const hot_update = plugin.hotUpdate;
  assert(typeof hot_update === "function", "Ink did not install its HMR hook");
  const emitted_events: { readonly event: string; readonly value: unknown }[] =
    [];

  const modules = await hot_update.call(
    {
      environment: {
        name: "client",
        hot: {
          send(event: string, value: unknown) {
            emitted_events.push({ event, value });
          },
        },
      },
    } as never,
    {
      file: new URL("game/main.blot", source_directory).pathname,
      type: "update",
    } as never,
  );

  assertEquals(modules, []);
  assertEquals(emitted_events, [{
    event: game_updated_event,
    value: { type: "game" },
  }]);
});

Deno.test("a new included source file compiles before notifying the game client", async () => {
  const package_directory = new URL("./", import.meta.url);
  const source_directory = new URL(
    "../../apps/game-dev/src/blot/",
    import.meta.url,
  );
  const plugin = ink({
    source_directories: [source_directory],
    resource_directories: [],
    public_directory: new URL(
      "../../apps/game-dev/generated/",
      import.meta.url,
    ),
    build: {
      command: Deno.execPath(),
      arguments: ["eval", ""],
      working_directory: package_directory,
    },
  });
  const hot_update = plugin.hotUpdate;
  assert(typeof hot_update === "function", "Ink did not install its HMR hook");
  const emitted_events: { readonly event: string; readonly value: unknown }[] =
    [];

  const modules = await hot_update.call(
    {
      environment: {
        name: "client",
        hot: {
          send(event: string, value: unknown) {
            emitted_events.push({ event, value });
          },
        },
      },
    } as never,
    {
      file: new URL("game/terrain.tiles", source_directory).pathname,
      type: "create",
    } as never,
  );

  assertEquals(modules, []);
  assertEquals(emitted_events, [{
    event: game_updated_event,
    value: { type: "game" },
  }]);
});

Deno.test("compiler output does not trigger another game build", async () => {
  const package_directory = new URL("./", import.meta.url);
  const source_directory = new URL(
    "../../apps/game-dev/src/blot/",
    import.meta.url,
  );
  const plugin = ink({
    source_directories: [source_directory],
    resource_directories: [],
    public_directory: new URL(
      "../../apps/game-dev/generated/",
      import.meta.url,
    ),
    build: {
      command: Deno.execPath(),
      arguments: ["eval", "Deno.exit(9)"],
      working_directory: package_directory,
    },
  });
  const hot_update = plugin.hotUpdate;
  assert(typeof hot_update === "function", "Ink did not install its HMR hook");
  const emitted_events: { readonly event: string; readonly value: unknown }[] =
    [];

  const modules = await hot_update.call(
    {
      environment: {
        name: "client",
        hot: {
          send(event: string, value: unknown) {
            emitted_events.push({ event, value });
          },
        },
      },
    } as never,
    {
      file: new URL("game/main.wasm", source_directory).pathname,
      type: "create",
    } as never,
  );

  assertEquals(modules, undefined);
  assertEquals(emitted_events, []);
});

Deno.test("a resource update copies the asset without compiling", async () => {
  const package_directory = new URL("./", import.meta.url);
  const temporary_directory = pathToFileURL(`${await Deno.makeTempDir()}/`);
  try {
    const resource_directory = new URL("source/", temporary_directory);
    const public_resource_directory = new URL(
      "public/assets/",
      temporary_directory,
    );
    const resource = new URL("terrain.webp", resource_directory);
    await Deno.mkdir(resource_directory, { recursive: true });
    await Deno.writeTextFile(resource, "terrain texture");
    const plugin = ink({
      source_directories: [],
      resource_directories: [{
        source_directory: resource_directory,
        public_directory: public_resource_directory,
      }],
      public_directory: new URL("public/", temporary_directory),
      build: {
        command: Deno.execPath(),
        arguments: ["eval", "Deno.exit(9)"],
        working_directory: package_directory,
      },
    });
    const hot_update = plugin.hotUpdate;
    assert(
      typeof hot_update === "function",
      "Ink did not install its HMR hook",
    );
    const emitted_events: {
      readonly event: string;
      readonly value: unknown;
    }[] = [];

    const modules = await hot_update.call(
      {
        environment: {
          name: "client",
          hot: {
            send(event: string, value: unknown) {
              emitted_events.push({ event, value });
            },
          },
        },
      } as never,
      { file: resource.pathname, type: "update" } as never,
    );

    assertEquals(modules, []);
    assertEquals(emitted_events, [{
      event: game_updated_event,
      value: { type: "resources" },
    }]);
    assertEquals(
      await Deno.readTextFile(
        new URL("terrain.webp", public_resource_directory),
      ),
      "terrain texture",
    );
  } finally {
    await Deno.remove(temporary_directory, { recursive: true });
  }
});

Deno.test("a deleted resource is removed before notifying the game client", async () => {
  const package_directory = new URL("./", import.meta.url);
  const temporary_directory = pathToFileURL(`${await Deno.makeTempDir()}/`);
  try {
    const resource_directory = new URL("source/", temporary_directory);
    const public_resource_directory = new URL(
      "public/assets/",
      temporary_directory,
    );
    const resource = new URL("terrain.webp", resource_directory);
    const public_resource = new URL(
      "terrain.webp",
      public_resource_directory,
    );
    await Deno.mkdir(resource_directory, { recursive: true });
    await Deno.mkdir(public_resource_directory, { recursive: true });
    await Deno.writeTextFile(public_resource, "terrain texture");
    const plugin = ink({
      source_directories: [],
      resource_directories: [{
        source_directory: resource_directory,
        public_directory: public_resource_directory,
      }],
      public_directory: new URL("public/", temporary_directory),
      build: {
        command: Deno.execPath(),
        arguments: ["eval", "Deno.exit(9)"],
        working_directory: package_directory,
      },
    });
    const hot_update = plugin.hotUpdate;
    assert(
      typeof hot_update === "function",
      "Ink did not install its HMR hook",
    );
    const emitted_events: {
      readonly event: string;
      readonly value: unknown;
    }[] = [];

    const modules = await hot_update.call(
      {
        environment: {
          name: "client",
          hot: {
            send(event: string, value: unknown) {
              emitted_events.push({ event, value });
            },
          },
        },
      } as never,
      { file: resource.pathname, type: "delete" } as never,
    );

    assertEquals(modules, []);
    assertEquals(emitted_events, [{
      event: game_updated_event,
      value: { type: "resources" },
    }]);
    await assertRejects(() => Deno.stat(public_resource), Deno.errors.NotFound);
  } finally {
    await Deno.remove(temporary_directory, { recursive: true });
  }
});

Deno.test("a failed Blot update reports the error without reloading", async () => {
  const package_directory = new URL("./", import.meta.url);
  const source_directory = new URL(
    "../../apps/game-dev/src/blot/",
    import.meta.url,
  );
  const plugin = ink({
    source_directories: [source_directory],
    resource_directories: [],
    public_directory: new URL(
      "../../apps/game-dev/generated/",
      import.meta.url,
    ),
    build: {
      command: Deno.execPath(),
      arguments: ["eval", "Deno.exit(9)"],
      working_directory: package_directory,
    },
  });
  const hot_update = plugin.hotUpdate;
  assert(typeof hot_update === "function", "Ink did not install its HMR hook");
  const emitted_events: { readonly event: string; readonly value: unknown }[] =
    [];

  const modules = await hot_update.call(
    {
      environment: {
        name: "client",
        hot: {
          send(event: string, value: unknown) {
            emitted_events.push({ event, value });
          },
        },
      },
    } as never,
    {
      file: new URL("game/main.blot", source_directory).pathname,
      type: "update",
    } as never,
  );

  assertEquals(modules, []);
  assertEquals(emitted_events, [{
    event: game_updated_event,
    value: {
      type: "compilation_error",
      message: "game compiler exited with code 9",
    },
  }]);
});
