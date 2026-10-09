/**
 * The dev server's asset write route and the watcher's reaction to it, with
 * a fake Vite server around a real `InkHost`.
 */
import { assert, assertEquals } from "@std/assert";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ViteDevServer } from "vite";
import { join } from "@std/path";
import { InkHost } from "./plugin.ts";
import { resolveProject } from "./node.ts";
import { encodeSegments } from "./segments.ts";

interface Sent {
  event: string;
  data: { kind?: string; path?: string };
}

async function withHost(
  run: (h: {
    host: InkHost;
    dir: string;
    sent: Sent[];
    watcher: EventEmitter;
    request(
      method: string,
      path: string,
      body?: Uint8Array,
      headers?: Record<string, string>,
    ): Promise<{ status: number; body: Record<string, unknown> }>;
  }) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "assets"));
  const sent: Sent[] = [];
  const watcher = Object.assign(new EventEmitter(), { add() {} });
  const server = {
    ws: {
      on() {},
      off() {},
      send: (m: { type: string; event: string; data: Sent["data"] }) =>
        sent.push({ event: m.event, data: m.data }),
    },
    watcher,
  } as unknown as ViteDevServer;
  const host = new InkHost(await resolveProject(dir), server);
  await host.start();
  const request = async (
    method: string,
    path: string,
    body = new Uint8Array(),
    headers: Record<string, string> = {},
  ) => {
    const req = Object.assign(
      (async function* () {
        if (body.length) yield body;
      })(),
      { url: path, method, headers: { host: "localhost:5173", ...headers } },
    ) as unknown as IncomingMessage;
    const out = { status: 0, text: "" };
    const res = {
      statusCode: 200,
      setHeader() {},
      end(text?: string) {
        out.status = res.statusCode;
        out.text = text ?? "";
      },
    };
    await host.handle(req, res as unknown as ServerResponse);
    return { status: out.status, body: JSON.parse(out.text || "{}") };
  };
  try {
    await run({ host, dir, sent, watcher, request });
  } finally {
    await host.dispose();
    await Deno.remove(dir, { recursive: true });
  }
}

const settle = () => new Promise((r) => setTimeout(r, 60));
/** The reload events, by what they say about the asset (the server may add
 * tracing details of its own). */
const assetEvents = (sent: Sent[]) =>
  sent.filter((s) => s.event === "ink:asset").map((s) => ({
    kind: s.data.kind,
    path: s.data.path,
  }));

Deno.test("the route writes terrain files and refuses everything else", async () => {
  await withHost(async ({ dir, request }) => {
    const root = "/__ink/assets-write/";
    assertEquals(
      (await request("PUT", `${root}t/a.terrain?create=1&size=32`)).body,
      { size: 32 },
    );
    const patched = await request(
      "PATCH",
      `${root}t/a.terrain`,
      encodeSegments([{ offset: 28, bytes: new Uint8Array([1, 2, 3, 4]) }]),
    );
    assertEquals(patched.status, 200);
    const file = await Deno.readFile(join(dir, "assets/t/a.terrain"));
    assertEquals([...file.subarray(28)], [1, 2, 3, 4]);
    for (
      const [method, path] of [
        ["GET", `${root}t/a.terrain`],
        ["DELETE", `${root}t/a.terrain`],
        ["PUT", `${root}..%2Fescape.terrain?create=1&size=4`],
        ["PUT", `${root}t/a.png?create=1&size=4`],
        ["PUT", `${root}.hidden/a.terrain?create=1&size=4`],
        ["PATCH", `${root}t/missing.terrain`],
      ]
    ) {
      const { status } = await request(method, path);
      assert(status >= 400 && status < 500, `${method} ${path}: ${status}`);
    }
    // A page of another origin may not write.
    const foreign = await request(
      "PUT",
      `${root}t/b.terrain?create=1&size=4`,
      undefined,
      { origin: "http://evil.example" },
    );
    assertEquals(foreign.status, 403);
    assertEquals(
      (await request(
        "PUT",
        `${root}t/b.terrain?create=1&size=4`,
        undefined,
        { origin: "http://localhost:5173" },
      )).status,
      200,
    );
  });
});

Deno.test("the watcher's echo of our writes does not reload, an outside edit does", async () => {
  await withHost(async ({ dir, sent, watcher, request }) => {
    const file = join(dir, "assets/world.terrain");
    await request("PUT", "/__ink/assets-write/world.terrain?create=1&size=64");
    await request(
      "PATCH",
      "/__ink/assets-write/world.terrain",
      encodeSegments([{ offset: 0, bytes: new Uint8Array([7]) }]),
    );
    // The file system reports the writes many times and over seconds.
    for (let i = 0; i < 6; i++) {
      watcher.emit("change", file);
      await settle();
    }
    assertEquals(assetEvents(sent), []);

    // A script rewrites the file: an edit to reload.
    await Deno.writeFile(file, new Uint8Array(64).fill(3));
    const later = new Date(Date.now() + 5000);
    await Deno.utime(file, later, later);
    watcher.emit("change", file);
    await settle();
    assertEquals(assetEvents(sent), [{
      kind: "terrain",
      path: "world.terrain",
    }]);

    // A different file the server never wrote is an edit too.
    const other = join(dir, "assets/other.scatter");
    await Deno.writeFile(other, new Uint8Array(16));
    watcher.emit("change", other);
    await settle();
    assertEquals(assetEvents(sent).at(-1), {
      kind: "scatter",
      path: "other.scatter",
    });
  });
});
