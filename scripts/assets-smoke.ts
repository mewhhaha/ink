/**
 * Asset pipeline gate: a generated ~55 MB glTF (about 900,000 triangles and
 * four 2048 px / 1024 px PNG textures) is dropped into a running editor's
 * `assets/` folder and into a build.
 *
 * Measures, with the import pipeline on and off (`import.minBytes` huge):
 *   - editor: file written -> catalog -> first textured frame -> full quality
 *     (compressed textures, simplified levels), and how long the dev server and
 *     the page stayed responsive meanwhile;
 *   - build: size on disk and time to the player's first GPU frame.
 * Writes pictures and `tmp/assets-report-<software|hardware>.json`.
 *
 *   deno task test:assets [--hardware] [--headed] [--skip-build]
 */
import { assert, assertEquals } from "@std/assert";
import { chromium } from "playwright-core";
import { findChromium, startServer } from "@ink/dev/cli";
import { resolveProject } from "@ink/dev/node";
import { callAutomation } from "../packages/dev/browser.ts";
import { buildPlayer } from "../packages/dev/build.ts";
import type { Ink } from "../packages/react/context.tsx";
import type * as Render from "@ink/render";
import { resolveInside } from "../packages/dev/paths.ts";

async function copy(from: string, to: string) {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    if (entry.isDirectory) {
      await copy(`${from}/${entry.name}`, `${to}/${entry.name}`);
    } else await Deno.copyFile(`${from}/${entry.name}`, `${to}/${entry.name}`);
  }
}

const hardware = Deno.args.includes("--hardware");
const headed = Deno.args.includes("--headed");
const skipBuild = Deno.args.includes("--skip-build");
const onlyBuild = Deno.args.includes("--only-build");
const suffix = hardware ? "hardware" : "software";
const root = new URL("../", import.meta.url).pathname;
const MODEL = "models/big-scene.glb";
const BIG = "tmp/big-scene.glb";

try {
  await Deno.stat(BIG);
} catch {
  const generated = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "scripts/gen-big-gltf.ts", BIG],
  }).output();
  assert(generated.success, "could not generate the test model");
}
const bigBytes = (await Deno.stat(BIG)).size;
console.log(`model: ${(bigBytes / 1e6).toFixed(1)} MB`);

async function project(label: string, raw: boolean, scene: boolean) {
  const dir = `tmp/assets-smoke/${label}`;
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  await Deno.mkdir(dir, { recursive: true });
  for (const name of ["game", "scenes", "src", "scenarios"]) {
    await copy(`examples/godot/${name}`, `${dir}/${name}`);
  }
  for (const name of ["index.html", "schema.ts"]) {
    await Deno.copyFile(`examples/godot/${name}`, `${dir}/${name}`);
  }
  await Deno.mkdir(`${dir}/assets`, { recursive: true });
  // Source edits elsewhere in the workspace must not reload the page mid-run.
  const config = (await Deno.readTextFile("examples/godot/ink.config.ts"))
    .replace(
      "defineProject({",
      'defineProject({\n  vite: { server: { watch: { ignored: ["**/packages/**", "**/examples/**"] } } },',
    );
  await Deno.writeTextFile(
    `${dir}/ink.config.ts`,
    raw
      ? config.replace(
        "defineProject({",
        "defineProject({\n  import: { minBytes: 1e12 },",
      )
      : config,
  );
  if (scene) {
    const file = `${dir}/scenes/main.scene.json`;
    const world = JSON.parse(await Deno.readTextFile(file));
    world.entities.push({
      id: 900,
      name: "Big scene",
      components: {
        transform: {
          position: [0, 1.2, -2],
          rotation: [0, 0, 0, 1],
          scale: [0.12, 0.12, 0.12],
        },
        mesh: {
          shape: MODEL,
          color: [1, 1, 1, 1],
          roughness: 0.6,
          metallic: 0,
          emissive: [0, 0, 0, 1],
          cast_shadows: true,
        },
      },
    });
    await Deno.writeTextFile(file, JSON.stringify(world));
    await Deno.mkdir(`${dir}/assets/models`, { recursive: true });
    await Deno.copyFile(BIG, `${dir}/assets/${MODEL}`);
  }
  return dir;
}

const args = [
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  ...(hardware ? ["--use-angle=vulkan", "--disable-vulkan-surface"] : [
    "--use-vulkan=swiftshader",
    "--use-webgpu-adapter=swiftshader",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ]),
];
const browser = await chromium.launch({
  executablePath: await findChromium(),
  headless: !headed,
  args,
});

interface EditorTimes {
  /** ms after the file write finished */
  catalog: number;
  firstDraw: number;
  firstDrawFrame: number;
  full: number;
  fullFrame: number;
  previewSize: number[];
  fullSize: number[];
  lodLevels: number;
  maxTimerGap: number;
  difference: number;
  pictures: { first: string; full: string };
  formats: string[];
  server: unknown;
  maxServerLatency: number;
}

type Global = {
  __ink: unknown;
  assetJob: {
    done?: boolean;
    error?: string;
    result?:
      & Omit<
        EditorTimes,
        | "server"
        | "maxServerLatency"
        | "catalog"
        | "firstDraw"
        | "full"
        | "firstDrawFrame"
        | "fullFrame"
      >
      & {
        at: {
          catalog: number;
          firstDraw: number;
          firstDrawFrame: number;
          full: number;
          fullFrame: number;
        };
      };
  };
  [key: symbol]: Promise<{ ink: Ink }>;
};

async function editor(label: string, raw: boolean): Promise<EditorTimes> {
  const dir = await project(label, raw, false);
  const server = await startServer(await resolveProject(dir), {
    port: 0,
    quiet: !Deno.env.get("INK_VERBOSE"),
  });
  const port = (server.httpServer!.address() as { port: number }).port;
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on(
    "framenavigated",
    (f) => console.log(`  [${label}] navigated ${f.url()}`),
  );
  page.on("response", (r) => {
    if (r.status() >= 400) console.log(`  [${label}] ${r.status()} ${r.url()}`);
  });
  page.on("console", (m) => {
    if (m.text().startsWith("assets:") || m.type() === "error") {
      console.log(`  [${label}] ${m.text()}`);
    }
  });
  try {
    await page.goto(`http://127.0.0.1:${port}/?ink-automation`);
    await page.waitForFunction(() => "__ink" in globalThis);
    await callAutomation(page, "ready", undefined);
    // The page watches for the model to arrive; the file is written below.
    await page.evaluate(({ root, path, hardware, raw }) => {
      const g = globalThis as unknown as Global;
      const job: Global["assetJob"] = g.assetJob = {};
      (async () => {
        const { ink } = await g[Symbol.for("ink.boot")];
        const renderer = ink.renderer!,
          s = ink.session,
          assets = renderer.assets;
        const api = await import(
          `/@fs${root}packages/render/mod.ts`
        ) as typeof Render;
        // Responsiveness probe: the longest gap between 10 ms timers.
        let last = performance.now(), maxGap = 0;
        const probe = setInterval(() => {
          const now = performance.now();
          maxGap = Math.max(maxGap, now - last);
          last = now;
        }, 10);
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        while (!s.catalog.assets.mesh.includes(path)) await wait(10);
        const at = {
          catalog: Date.now(),
          firstDraw: 0,
          firstDrawFrame: 0,
          full: 0,
          fullFrame: 0,
        };
        s.createEntity({
          name: "Big scene",
          components: {
            transform: {
              position: [0, 1.2, -2],
              rotation: [0, 0, 0, 1],
              scale: [0.12, 0.12, 0.12],
            },
            mesh: {
              shape: s.catalog.assets.mesh.indexOf(path) + 1,
              color: [1, 1, 1, 1],
              texture: 0,
              roughness: 0.6,
              metallic: 0,
              emissive: [0, 0, 0, 1],
              cast_shadows: true,
            },
          },
        });
        const camera = api.lookAtCamera([3.2, 3.4, 4.6], [0, 1.2, -2], {
          fov: 40,
        }, 4 / 3);
        const view = renderer.createView({ width: 480, height: 360 });
        const render = async () => {
          view.render(ink.scene(), camera, {
            still: true,
            quality: hardware ? "high" : "low",
          });
          await renderer.device.queue.onSubmittedWorkDone();
        };
        const textured = () => {
          const model = assets.modelData(path);
          if (!model) return null;
          const m = model.materials[0];
          const uris = [m.base?.uri, m.normal?.uri, m.metallicRoughness?.uri];
          const sizes = uris.map((
            u,
          ) => (u ? assets.textureSize(u) : undefined));
          return sizes.every((x) => x) ? { model, size: sizes[0]! } : null;
        };
        const pixels = async () => {
          const p = await view.readPixels();
          return p;
        };
        const png = async () => {
          const blob = await view.capture();
          return await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
        };
        // Asking for a texture starts loading it (drawing would too, but a
        // software rasteriser needs seconds per frame of this model).
        const request = () => {
          const model = assets.modelData(path);
          if (!model) return;
          const m = model.materials[0];
          const store = assets as unknown as {
            getTexture(uri: string | undefined, kind: string): unknown;
          };
          store.getTexture(m.base?.uri, "color");
          store.getTexture(m.normal?.uri, "normal");
          store.getTexture(m.metallicRoughness?.uri, "orm");
        };
        let first: ReturnType<typeof textured> = null;
        while (!first) {
          request();
          await assets.settled();
          first = textured();
          if (!first) await wait(5);
        }
        at.firstDraw = Date.now();
        if (raw) {
          // The unprocessed file only needs to be ready, not rasterised.
          clearInterval(probe);
          view.dispose();
          job.result = {
            at,
            previewSize: first.size,
            fullSize: first.size,
            lodLevels: 0,
            maxTimerGap: maxGap,
            difference: 0,
            pictures: { first: "", full: "" },
            formats: [],
          };
          return;
        }
        const formatOf = (m: NonNullable<typeof first>["model"]) =>
          (assets as unknown as {
            getTexture(
              uri: string | undefined,
              kind: string,
            ): { texture: { format: string } };
          }).getTexture(m.materials[0].base?.uri, "color").texture.format;
        const formats = [formatOf(first.model)];
        const lods = () => {
          const model = assets.modelData(path);
          if (!model) return 0;
          const gpu = assets.meshData(`${path}#mesh=0/0`);
          return gpu?.lods?.length ?? 0;
        };
        // Watch for the full-quality import while the first frame draws.
        let now: ReturnType<typeof textured> = null;
        const fullReady = (async () => {
          for (let i = 0; i < 60000; i++) {
            request();
            await assets.settled();
            now = textured();
            if (
              now && now.model !== first!.model && now.size[0] >= 1024 &&
              lods() > 0
            ) break;
            await wait(5);
          }
          at.full = Date.now();
        })();
        await render();
        const a = await pixels();
        const pictureFirst = await png();
        at.firstDrawFrame = Date.now();
        await fullReady;
        formats.push(formatOf(now!.model));
        await render();
        const b = await pixels();
        const pictureFull = await png();
        at.fullFrame = Date.now();
        let sum = 0;
        for (let i = 0; i < a.data.length; i += 4) {
          sum += Math.abs(a.data[i] - b.data[i]) +
            Math.abs(a.data[i + 1] - b.data[i + 1]) +
            Math.abs(a.data[i + 2] - b.data[i + 2]);
        }
        clearInterval(probe);
        view.dispose();
        job.result = {
          at,
          previewSize: first.size,
          fullSize: now!.size,
          lodLevels: lods(),
          maxTimerGap: maxGap,
          difference: sum / (a.data.length / 4) / 3,
          pictures: { first: pictureFirst, full: pictureFull },
          formats,
        };
      })().then(() => {
        job.done = true;
      }, (e) => {
        job.error = e.stack ?? String(e);
        job.done = true;
      });
    }, { root, path: MODEL, hardware, raw });

    // Probe the dev server while it imports: the longest HTTP round trip.
    let maxServerLatency = 0, probing = true;
    const probe = (async () => {
      while (probing) {
        const t = performance.now();
        await fetch(`http://127.0.0.1:${port}/__ink/project`).then((r) =>
          r.arrayBuffer()
        ).catch(() => {});
        maxServerLatency = Math.max(maxServerLatency, performance.now() - t);
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    await Deno.mkdir(`${dir}/assets/models`, { recursive: true });
    await Deno.copyFile(BIG, `${dir}/assets/${MODEL}`);
    const written = Date.now();
    await page.waitForFunction(
      () => (globalThis as unknown as Global).assetJob.done,
      undefined,
      { timeout: 600_000, polling: 100 },
    );
    probing = false;
    await probe;
    const result = await page.evaluate(() => {
      const job = (globalThis as unknown as Global).assetJob;
      if (job.error) throw new Error(job.error);
      return job.result!;
    });
    assertEquals(errors, []);
    const imports = await fetch(`http://127.0.0.1:${port}/__ink/imports`).then((
      r,
    ) => r.json());
    const at = result.at;
    return {
      catalog: at.catalog - written,
      firstDraw: at.firstDraw - written,
      firstDrawFrame: at.firstDrawFrame - written,
      full: at.full - written,
      fullFrame: at.fullFrame - written,
      previewSize: result.previewSize,
      fullSize: result.fullSize,
      lodLevels: result.lodLevels,
      maxTimerGap: result.maxTimerGap,
      difference: result.difference,
      pictures: result.pictures,
      formats: result.formats,
      server: imports,
      maxServerLatency,
    };
  } finally {
    await page.close();
    await server.close();
  }
}

async function player(label: string, raw: boolean) {
  const dir = await project(label, raw, true);
  const t = performance.now();
  const build = await buildPlayer(await resolveProject(dir));
  const buildMs = performance.now() - t;
  const files = build.files.filter((f) => f.path.startsWith("assets/"));
  const types: Record<string, string> = {
    js: "text/javascript",
    css: "text/css",
    html: "text/html",
    wasm: "application/wasm",
    json: "application/json",
    png: "image/png",
    glb: "model/gltf-binary",
  };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const path = new URL(request.url).pathname;
      try {
        const file = resolveInside(build.out, path.slice(1) || "index.html");
        return new Response(await Deno.readFile(file), {
          headers: {
            "content-type": types[file.split(".").at(-1)!] ??
              "application/octet-stream",
          },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  );
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const errors: string[] = [];
  let transferred = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    transferred += Number(r.headers()["content-length"] ?? 0);
  });
  try {
    const started = performance.now();
    await page.goto(`http://127.0.0.1:${server.addr.port}/?ink-automation`);
    await page.waitForFunction(() => "__inkPlayer" in globalThis);
    const readyMs = await page.evaluate(async () =>
      (await (globalThis as unknown as {
        __inkPlayer: Promise<{ readyMs: number }>;
      }).__inkPlayer).readyMs
    );
    const wall = performance.now() - started;
    await page.evaluate(async () => {
      const app = await (globalThis as unknown as {
        __inkPlayer: Promise<{ renderer: { device: GPUDevice } }>;
      }).__inkPlayer;
      await app.renderer.device.queue.onSubmittedWorkDone();
    });
    await page.screenshot({
      path: `tmp/assets-player-${label}-${suffix}.png`,
      timeout: 300_000,
    }).catch(() => {});
    assertEquals(errors, []);
    return {
      buildMs,
      assetBytes: build.assetBytes,
      playerBytes: build.bytes,
      assetFiles: files.map((f) =>
        `${f.path} ${(f.bytes / 1e6).toFixed(2)} MB`
      ),
      readyMs,
      wallMs: wall,
      transferred,
    };
  } finally {
    await page.close();
    await server.shutdown();
  }
}

const report: Record<string, unknown> = { model: bigBytes, hardware };
try {
  await Deno.mkdir("tmp", { recursive: true });
  if (!onlyBuild) {
    const piped = await editor("editor", false);
    console.log(
      `editor (import): catalog ${piped.catalog} ms, first textured draw ${piped.firstDraw} ms (frame captured ${piped.firstDrawFrame}), full quality ${piped.full} ms; formats ${
        piped.formats.join(" -> ")
      }; textures ${piped.previewSize.join("x")} -> ${
        piped.fullSize.join("x")
      }, ${piped.lodLevels} LOD levels; page timer gap ${
        Math.round(piped.maxTimerGap)
      } ms; server latency ${
        Math.round(piped.maxServerLatency)
      } ms; picture difference ${piped.difference.toFixed(2)}/255`,
    );
    await Deno.writeFile(
      `tmp/assets-editor-preview-${suffix}.png`,
      Uint8Array.from(
        atob(piped.pictures.first.split(",").at(-1)!),
        (c) => c.charCodeAt(0),
      ),
    );
    await Deno.writeFile(
      `tmp/assets-editor-full-${suffix}.png`,
      Uint8Array.from(
        atob(piped.pictures.full.split(",").at(-1)!),
        (c) => c.charCodeAt(0),
      ),
    );
    report.editor = { ...piped, pictures: undefined };
    const raw = await editor("editor-raw", true);
    console.log(
      `editor (raw file): catalog ${raw.catalog} ms, first textured draw ${raw.firstDraw} ms (frame captured ${raw.firstDrawFrame}); page timer gap ${
        Math.round(raw.maxTimerGap)
      } ms`,
    );
    report.editorRaw = { ...raw, pictures: undefined };
    assert(
      piped.firstDraw < 10_000,
      `first textured draw took ${piped.firstDraw} ms`,
    );
    assert(
      piped.fullSize[0] >= 1024 && piped.lodLevels > 0,
      "full quality did not arrive",
    );
  }
  if (!skipBuild) {
    const built = await player("build", false);
    console.log(
      `build (import): assets ${(built.assetBytes / 1e6).toFixed(1)} MB (${
        built.assetFiles.join(", ")
      }), built in ${(built.buildMs / 1000).toFixed(1)} s, first frame ${
        Math.round(built.readyMs)
      } ms, ${(built.transferred / 1e6).toFixed(1)} MB transferred`,
    );
    const rawBuild = await player("build-raw", true);
    console.log(
      `build (raw): assets ${
        (rawBuild.assetBytes / 1e6).toFixed(1)
      } MB, first frame ${Math.round(rawBuild.readyMs)} ms, ${
        (rawBuild.transferred / 1e6).toFixed(1)
      } MB transferred`,
    );
    report.build = built;
    report.buildRaw = rawBuild;
    assert(
      built.assetBytes < rawBuild.assetBytes / 2,
      "the build ships compressed assets",
    );
  }
} finally {
  await Deno.writeTextFile(
    `tmp/assets-report-${suffix}.json`,
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
console.log("✓ asset pipeline gate");
