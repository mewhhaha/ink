import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { pathToFileURL } from "node:url";
import { application_updated_event } from "./client.ts";
import { ink_application, type InkApplicationBuildRequest } from "./plugin.ts";

Deno.test("a Blot update compiles before notifying the game client", async () => {
  const package_directory = new URL("./", import.meta.url);
  const source_directory = new URL(
    "../../../apps/adventure-dev/src/blot/",
    import.meta.url,
  );
  const plugin = ink_application({
    source_directories: [source_directory],
    resource_directories: [],
    public_directory: new URL(
      "../../../apps/adventure-dev/generated/",
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
    event: application_updated_event,
    value: { type: "game" },
  }]);
});

Deno.test("a new included source file compiles before notifying the game client", async () => {
  const package_directory = new URL("./", import.meta.url);
  const source_directory = new URL(
    "../../../apps/adventure-dev/src/blot/",
    import.meta.url,
  );
  const plugin = ink_application({
    source_directories: [source_directory],
    resource_directories: [],
    public_directory: new URL(
      "../../../apps/adventure-dev/generated/",
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
    event: application_updated_event,
    value: { type: "game" },
  }]);
});

Deno.test("compiler output does not trigger another game build", async () => {
  const package_directory = new URL("./", import.meta.url);
  const source_directory = new URL(
    "../../../apps/adventure-dev/src/blot/",
    import.meta.url,
  );
  const plugin = ink_application({
    source_directories: [source_directory],
    resource_directories: [],
    public_directory: new URL(
      "../../../apps/adventure-dev/generated/",
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
    const plugin = ink_application({
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
      event: application_updated_event,
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
    const plugin = ink_application({
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
      event: application_updated_event,
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
    "../../../apps/adventure-dev/src/blot/",
    import.meta.url,
  );
  const plugin = ink_application({
    source_directories: [source_directory],
    resource_directories: [],
    public_directory: new URL(
      "../../../apps/adventure-dev/generated/",
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
    event: application_updated_event,
    value: {
      type: "compilation_error",
      message: "game compiler exited with code 9",
    },
  }]);
});

Deno.test("game development rejects malformed build arguments at its boundary", () => {
  assertThrows(
    () =>
      ink_application({
        source_directories: [],
        resource_directories: [],
        public_directory: new URL("file:///game/public/"),
        build: {
          command: Deno.execPath(),
          arguments: ["eval", 42] as never,
          working_directory: new URL("file:///game/"),
        },
      }),
    Error,
    "build arguments must be text",
  );
});

Deno.test("development builds retain one compiler between initial and hot builds", async () => {
  const requests: InkApplicationBuildRequest[] = [];
  const source_directory = new URL("file:///game/source/");
  const plugin = ink_application({
    source_directories: [source_directory],
    resource_directories: [],
    public_directory: new URL("file:///game/public/"),
    build: {
      run(request) {
        requests.push(request);
        return Promise.resolve();
      },
      close() {},
    },
  });
  if (typeof plugin.buildStart !== "function") {
    throw new Error("Ink did not install its initial build hook");
  }
  if (typeof plugin.hotUpdate !== "function") {
    throw new Error("Ink did not install its HMR hook");
  }

  await plugin.buildStart.call({} as never, {} as never);
  await plugin.hotUpdate.call(
    {
      environment: {
        name: "client",
        hot: { send() {} },
      },
    } as never,
    {
      file: new URL("main.blot", source_directory).pathname,
      type: "update",
    } as never,
  );

  assertEquals(requests, [
    { type: "initial" },
    {
      type: "sources",
      changes: [{
        path: new URL("main.blot", source_directory).pathname,
        type: "update",
      }],
    },
  ]);
});

Deno.test("concurrent source changes are retained for a following build", async () => {
  const requests: InkApplicationBuildRequest[] = [];
  const source_directory = new URL("file:///game/source/");
  let release_build: (() => void) | undefined;
  const plugin = ink_application({
    source_directories: [source_directory],
    resource_directories: [],
    public_directory: new URL("file:///game/public/"),
    build: {
      async run(request) {
        requests.push(request);
        if (requests.length !== 2) return;
        await new Promise<void>((resolve) => {
          release_build = resolve;
        });
      },
      close() {},
    },
  });
  if (typeof plugin.buildStart !== "function") {
    throw new Error("Ink did not install its initial build hook");
  }
  if (typeof plugin.hotUpdate !== "function") {
    throw new Error("Ink did not install its HMR hook");
  }
  await plugin.buildStart.call({} as never, {} as never);
  const context = {
    environment: {
      name: "client",
      hot: { send() {} },
    },
  } as never;
  const first_update = plugin.hotUpdate.call(context, {
    file: new URL("provider.blot", source_directory).pathname,
    type: "update",
  } as never);
  await Promise.resolve();
  const second_update = plugin.hotUpdate.call(context, {
    file: new URL("entry.blot", source_directory).pathname,
    type: "delete",
  } as never);
  release_build?.();
  await Promise.all([first_update, second_update]);

  assertEquals(requests, [
    { type: "initial" },
    {
      type: "sources",
      changes: [{
        path: new URL("provider.blot", source_directory).pathname,
        type: "update",
      }],
    },
    {
      type: "sources",
      changes: [{
        path: new URL("entry.blot", source_directory).pathname,
        type: "delete",
      }],
    },
  ]);
});

Deno.test("a change queued during a failed build runs before later changes", async () => {
  const requests: InkApplicationBuildRequest[] = [];
  const emitted_events: { readonly event: string; readonly value: unknown }[] =
    [];
  const source_directory = new URL("file:///game/source/");
  const first_build_started = Promise.withResolvers<void>();
  const recovery_build_started = Promise.withResolvers<void>();
  let fail_first_build: (() => void) | undefined;
  let release_recovery_build: (() => void) | undefined;
  const plugin = ink_application({
    source_directories: [source_directory],
    resource_directories: [],
    public_directory: new URL("file:///game/public/"),
    build: {
      async run(request) {
        requests.push(request);
        if (requests.length === 2) {
          first_build_started.resolve();
          await new Promise<void>((_resolve, reject) => {
            fail_first_build = () =>
              reject(
                new Error("first source build failed"),
              );
          });
        }
        if (requests.length === 3) {
          recovery_build_started.resolve();
          await new Promise<void>((resolve) => {
            release_recovery_build = resolve;
          });
        }
      },
      close() {},
    },
  });
  if (typeof plugin.buildStart !== "function") {
    throw new Error("Ink did not install its initial build hook");
  }
  if (typeof plugin.hotUpdate !== "function") {
    throw new Error("Ink did not install its HMR hook");
  }
  const context = {
    environment: {
      name: "client",
      hot: {
        send(event: string, value: unknown) {
          emitted_events.push({ event, value });
        },
      },
    },
  } as never;

  await plugin.buildStart.call({} as never, {} as never);
  const failed_update = plugin.hotUpdate.call(context, {
    file: new URL("failed.blot", source_directory).pathname,
    type: "update",
  } as never);
  await first_build_started.promise;
  const recovery_update = plugin.hotUpdate.call(context, {
    file: new URL("recovery.blot", source_directory).pathname,
    type: "update",
  } as never);
  fail_first_build?.();
  await recovery_build_started.promise;
  const later_update = plugin.hotUpdate.call(context, {
    file: new URL("later.blot", source_directory).pathname,
    type: "create",
  } as never);
  release_recovery_build?.();
  await Promise.all([failed_update, recovery_update, later_update]);

  assertEquals(requests, [
    { type: "initial" },
    {
      type: "sources",
      changes: [{
        path: new URL("failed.blot", source_directory).pathname,
        type: "update",
      }],
    },
    {
      type: "sources",
      changes: [{
        path: new URL("recovery.blot", source_directory).pathname,
        type: "update",
      }],
    },
    {
      type: "sources",
      changes: [{
        path: new URL("later.blot", source_directory).pathname,
        type: "create",
      }],
    },
  ]);
  assertEquals(emitted_events, [
    {
      event: application_updated_event,
      value: {
        type: "compilation_error",
        message: "first source build failed",
      },
    },
    { event: application_updated_event, value: { type: "game" } },
    { event: application_updated_event, value: { type: "game" } },
  ]);
});
