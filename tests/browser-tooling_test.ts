import { assertEquals, assertRejects } from "@std/assert";
import { browser, cdp } from "./browser-support.ts";
import { sourceServer } from "../tools/source-server.ts";

Deno.test("source server shares serving, caches by dependency and removes bundles", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ink serving test " });
  const root = new URL(`file://${directory}/`);
  await Deno.writeTextFile(
    new URL("dependency.ts", root),
    'export const value = "first";',
  );
  await Deno.writeTextFile(
    new URL("entry.ts", root),
    'import { value } from "./dependency.ts"; console.log(value);',
  );
  await Deno.writeTextFile(
    new URL("other.ts", root),
    'console.log("unrelated");',
  );
  await Deno.writeTextFile(
    new URL("index.html", root),
    "<title>Example</title>",
  );
  await Deno.writeTextFile(new URL("style.css", root), "body{}");
  const sources = await sourceServer({
    root,
    redirect: "/index.html",
    watch: [directory],
  });
  const origin = `http://127.0.0.1:${sources.server.addr.port}`;
  const get = async (path: string) => {
    const response = await fetch(`${origin}${path}`);
    assertEquals(response.status, 200);
    return await response.text();
  };
  try {
    const redirect = await fetch(origin, { redirect: "manual" });
    assertEquals(redirect.status, 307);
    assertEquals(redirect.headers.get("location"), `${origin}/index.html`);
    await redirect.body?.cancel();
    const stylesheet = await fetch(`${origin}/style.css`);
    assertEquals(stylesheet.headers.get("content-type"), "text/css");
    await stylesheet.body?.cancel();
    const forbidden = await fetch(`${origin}/%2e%2e%2foutside`);
    assertEquals(forbidden.status, 403);
    await forbidden.body?.cancel();
    const malformed = await fetch(`${origin}/%ZZ`);
    assertEquals(malformed.status, 400);
    await malformed.body?.cancel();
    assertEquals((await get("/entry.ts")).includes('"first"'), true);
    const unrelated = await get("/other.ts");
    assertEquals(sources.bundleCount, 2);
    await get("/entry.ts");
    assertEquals(sources.bundleCount, 2);
    await Deno.writeTextFile(
      new URL("dependency.ts", root),
      'export const value = "fresh";',
    );
    let fresh = false;
    const until = Date.now() + 2000;
    while (!fresh && Date.now() < until) {
      fresh = (await get("/entry.ts")).includes('"fresh"');
      if (!fresh) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assertEquals(fresh, true);
    assertEquals(await get("/other.ts"), unrelated);
    assertEquals(sources.bundleCount, 3);
    assertEquals(await Array.fromAsync(Deno.readDir(sources.temporary)), []);
  } finally {
    await sources.dispose();
    await sources.dispose();
    await Deno.remove(directory, { recursive: true });
  }
  await assertRejects(() => Deno.stat(sources.temporary), Deno.errors.NotFound);
});

Deno.test("source server releases its port and directory across 100 lifetimes", async () => {
  for (let cycle = 0; cycle < 100; cycle++) {
    const sources = await sourceServer();
    const port = sources.server.addr.port;
    await sources.dispose();
    await assertRejects(
      () => Deno.stat(sources.temporary),
      Deno.errors.NotFound,
    );
    const replacement = Deno.listen({ hostname: "127.0.0.1", port });
    replacement.close();
  }
});

Deno.test("CDP missing responses time out within 10 seconds and close rejects pending work", async () => {
  let peer: WebSocket | undefined;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const upgraded = Deno.upgradeWebSocket(request);
      peer = upgraded.socket;
      return upgraded.response;
    },
  );
  const connection = await cdp(
    new WebSocket(`ws://127.0.0.1:${server.addr.port}`),
  );
  try {
    const started = performance.now();
    await assertRejects(
      () => connection.command("Deliberately.stalled"),
      Error,
      "timed out",
    );
    assertEquals(performance.now() - started < 10000, true);
    const pending = connection.command("Deliberately.missing");
    const rejected = assertRejects(() => pending, Error, "CDP closed");
    connection.close();
    await rejected;
  } finally {
    connection.close();
    peer?.close();
    await server.shutdown();
  }
});

Deno.test("stalled Chromium startup fails within 10 seconds with diagnostics", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ink-startup-test-" });
  const executable = `${directory}/stalled`;
  await Deno.writeTextFile(
    executable,
    '#!/bin/sh\necho "deliberate startup stall" >&2\nexec sleep 30\n',
  );
  await Deno.chmod(executable, 0o755);
  const previous = Deno.env.get("INK_CHROME");
  Deno.env.set("INK_CHROME", executable);
  try {
    const started = performance.now();
    await assertRejects(
      () => browser("/tests/browser-adapters.html"),
      Error,
      "deliberate startup stall",
    );
    assertEquals(performance.now() - started < 10000, true);
  } finally {
    if (previous === undefined) Deno.env.delete("INK_CHROME");
    else Deno.env.set("INK_CHROME", previous);
    await Deno.remove(directory, { recursive: true });
  }
});
