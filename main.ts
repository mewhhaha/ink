const publicDirectory = new URL("./public/", import.meta.url);

type EditorClient =
  | { readonly type: "bundled" }
  | { readonly type: "vite"; readonly origin: string };

const bundled_editor_client: EditorClient = { type: "bundled" };

const assetContentTypes: Record<string, string> = {
  "/editor.js": "text/javascript; charset=utf-8",
  "/editor.css": "text/css; charset=utf-8",
  "/scene_explorer.wasm": "application/wasm",
  "/scene_explorer.wasm.json": "application/json; charset=utf-8",
  "/beacon.obj": "text/plain; charset=utf-8",
};

export async function handler(
  req: Request,
  editor_client: EditorClient = bundled_editor_client,
): Promise<Response> {
  const url = new URL(req.url);

  if (req.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "GET" },
    });
  }

  if (url.pathname === "/") {
    const editor_assets = editor_client.type === "vite"
      ? `<script type="module" src="${editor_client.origin}/@vite/client"></script>
    <script type="module">
      import RefreshRuntime from "${editor_client.origin}/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import("${editor_client.origin}/editor/main.tsx");
    </script>`
      : `<link rel="stylesheet" href="/editor.css" />
    <script type="module" src="/editor.js"></script>`;
    return new Response(
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#080b12" />
    <title>Ink Engine</title>
    ${editor_assets}
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`,
      {
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    );
  }

  const contentType = assetContentTypes[url.pathname];
  if (!contentType) {
    return new Response("Not found", { status: 404 });
  }

  const assetPath = new URL(url.pathname.slice(1), publicDirectory);
  let asset: Uint8Array;
  try {
    asset = await Deno.readFile(assetPath);
  } catch (cause) {
    throw new Error(`editor asset ${url.pathname} could not be read`, {
      cause,
    });
  }

  return new Response(new Uint8Array(asset).buffer, {
    headers: { "content-type": contentType },
  });
}

if (import.meta.main) {
  const vite_origin = Deno.args
    .find((argument) => argument.startsWith("--editor-vite-origin="))
    ?.slice("--editor-vite-origin=".length);
  const editor_client: EditorClient = vite_origin
    ? { type: "vite", origin: new URL(vite_origin).origin }
    : bundled_editor_client;
  Deno.serve((request) => handler(request, editor_client));
}
