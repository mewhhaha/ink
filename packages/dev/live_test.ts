import { assertEquals, assertRejects } from "@std/assert";
import { EventEmitter } from "node:events";
import type { ViteDevServer, WebSocketClient } from "vite";
import { LiveHost } from "./live_host.ts";
import type { LiveCommand } from "./live.ts";

function fixture(timeout = 1000) {
  const events = new EventEmitter();
  const server = {
    ws: { on: events.on.bind(events) },
  } as unknown as ViteDevServer;
  const host = new LiveHost(server, "/tmp", timeout);
  const client = (id: string) => {
    const commands: LiveCommand[] = [];
    const socket = {
      socket: new EventEmitter(),
      send: (m: { data: LiveCommand }) => commands.push(m.data),
    } as unknown as WebSocketClient;
    events.emit(
      "ink:register",
      { id, title: id, url: "http://localhost" },
      socket,
    );
    return { socket, commands };
  };
  return { host, events, client };
}

Deno.test("live requests target one editor, reject ambiguity and ignore another client's responses", async () => {
  const { host, events, client } = fixture();
  const a = client("a"), b = client("b");
  await assertRejects(
    () => host.call("play", { action: "stop" }),
    Error,
    "several editors",
  );
  const pending = host.call("world", { session: "a" });
  assertEquals(a.commands.length, 1);
  assertEquals(b.commands.length, 0);
  const id = a.commands[0].id;
  events.emit("ink:result", { id, result: "wrong editor" }, b.socket);
  events.emit("ink:result", { id, result: "correct editor" }, a.socket);
  assertEquals(await pending, "correct editor");
  const disconnected = host.call("world", { session: "a" });
  const rejection = assertRejects(() => disconnected, Error, "disconnected");
  a.socket.socket.emit("close");
  await rejection;
  assertEquals(host.list().map((s) => s.id), ["b"]);
  host.dispose();
});

Deno.test("live calls time out and MCP returns tool failures without losing the protocol", async () => {
  const { host, client } = fixture(5);
  client("only");
  await assertRejects(() => host.call("world"), Error, "timed out");
  const response = await host.mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "ink_world", arguments: {} },
  });
  assertEquals(
    (response as { result: { isError: boolean } }).result.isError,
    true,
  );
  assertEquals(
    await host.mcp({ jsonrpc: "2.0", method: "notifications/initialized" }),
    null,
  );
  host.dispose();
});

Deno.test("source edits reject stale hashes, hidden paths and symlink escapes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ink-source-" });
  const outside = await Deno.makeTempFile({ suffix: ".ts" });
  const events = new EventEmitter();
  const host = new LiveHost(
    { ws: { on: events.on.bind(events) } } as unknown as ViteDevServer,
    dir,
  );
  try {
    await Deno.writeTextFile(`${dir}/main.ts`, "original");
    await Deno.mkdir(`${dir}/.hidden`);
    await Deno.writeTextFile(`${dir}/.hidden/file.ts`, "hidden");
    await Deno.symlink(outside, `${dir}/escape.ts`);
    const read = await host.call("source", { path: "main.ts" }) as {
      hash: string;
    };
    await host.call("source", {
      path: "main.ts",
      expectedHash: read.hash,
      text: "edited",
    });
    await assertRejects(
      () =>
        host.call("source", {
          path: "main.ts",
          expectedHash: read.hash,
          text: "stale",
        }),
      Error,
      "source changed",
    );
    assertEquals(await Deno.readTextFile(`${dir}/main.ts`), "edited");
    await assertRejects(
      () => host.call("source", { path: "%2ehidden/file.ts" }),
      Error,
      "hidden",
    );
    await assertRejects(
      () => host.call("source", { path: "escape.ts" }),
      Error,
      "escapes",
    );
  } finally {
    host.dispose();
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside);
  }
});
