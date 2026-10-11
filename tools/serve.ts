import { sourceServer } from "./source-server.ts";

const sources = await sourceServer({
  port: 8000,
  redirect: "/examples/graphics.html",
  watch: [
    new URL("../adapters", import.meta.url).pathname,
    new URL("../examples", import.meta.url).pathname,
  ],
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, async () => {
    await sources.dispose();
    Deno.exit();
  });
}
console.log(
  "Rendering: http://localhost:8000 · Controls: http://localhost:8000/examples/browser-ui.html",
);
