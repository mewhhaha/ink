import { assertEquals } from "@std/assert";
import { handler } from "./main.ts";

Deno.test("serves the editor shell on /", async () => {
  const res = await handler(new Request("http://localhost/"));
  assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
  const body = await res.text();
  assertEquals(body.includes("Ink Engine"), true);
  assertEquals(body.includes("/editor.js"), true);
});

Deno.test("development shell loads the Vite hot-reload client", async () => {
  const res = await handler(
    new Request("http://localhost/"),
    { type: "vite", origin: "http://127.0.0.1:5173" },
  );
  const body = await res.text();

  assertEquals(body.includes("http://127.0.0.1:5173/@vite/client"), true);
  assertEquals(body.includes("http://127.0.0.1:5173/@react-refresh"), true);
  assertEquals(
    body.includes("http://127.0.0.1:5173/editor/main.tsx"),
    true,
  );
  assertEquals(body.includes("/editor.js"), false);
});

Deno.test("serves the bundled editor client", async () => {
  const res = await handler(new Request("http://localhost/editor.js"));
  assertEquals(
    res.headers.get("content-type"),
    "text/javascript; charset=utf-8",
  );
  assertEquals((await res.bytes()).byteLength > 0, true);
});

Deno.test("bundled editor does not require Node globals", async () => {
  const res = await handler(new Request("http://localhost/editor.js"));
  const source = await res.text();

  assertEquals(source.includes("process.env.NODE_ENV"), false);
});

Deno.test("serves the compiled Blot game as WebAssembly", async () => {
  const res = await handler(
    new Request("http://localhost/scene_explorer.wasm"),
  );
  assertEquals(res.headers.get("content-type"), "application/wasm");
  assertEquals(
    (await res.bytes()).slice(0, 4),
    new Uint8Array([0, 97, 115, 109]),
  );
});

Deno.test("serves the bundled beacon model", async () => {
  const res = await handler(new Request("http://localhost/beacon.obj"));
  assertEquals(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assertEquals((await res.text()).includes("o Beacon"), true);
});

Deno.test("rejects unsupported methods", async () => {
  const res = await handler(
    new Request("http://localhost/", { method: "POST" }),
  );
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("allow"), "GET");
});
