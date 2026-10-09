import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  AssetWriteError,
  AssetWrites,
  MAX_ASSET_BODY,
  readBody,
} from "./asset_write.ts";
import { decodeSegments, encodeSegments } from "./segments.ts";

async function withAssets(
  run: (dir: string, writes: AssetWrites) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  const assets = join(dir, "assets");
  await Deno.mkdir(assets);
  try {
    await run(dir, new AssetWrites(assets));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const q = (s = "") => new URLSearchParams(s);
const bytes = (...n: number[]) => new Uint8Array(n);

async function status(work: Promise<unknown>): Promise<number> {
  try {
    await work;
    return 200;
  } catch (error) {
    if (error instanceof AssetWriteError) return error.status;
    throw error;
  }
}

Deno.test("segments round-trip and refuse truncated bodies", () => {
  const list = [
    { offset: 4, bytes: bytes(1, 2, 3) },
    { offset: 0, bytes: bytes() },
    { offset: 4_000_000_000, bytes: bytes(9) },
  ];
  const body = encodeSegments(list);
  assertEquals(body.length, 8 * 3 + 4);
  assertEquals(decodeSegments(body), list);
  assertEquals(decodeSegments(new Uint8Array()), []);
  for (const cut of [1, 7, 9, body.length - 1]) {
    let failed = false;
    try {
      decodeSegments(body.subarray(0, cut));
    } catch {
      failed = true;
    }
    assert(failed, `cut at ${cut}`);
  }
});

Deno.test("only terrain and scatter files inside assets can be written", async () => {
  await withAssets(async (dir, writes) => {
    const good = ["a.terrain", "terrain/b.scatter", "x/y/Z.TERRAIN"];
    for (const path of good) writes.resolve(path);
    const bad = [
      "../x.terrain",
      "a/../../x.terrain",
      "%2e%2e/x.terrain",
      "..%2fx.terrain",
      "/etc/passwd",
      "/abs/x.terrain",
      "a//b.terrain",
      "a\\b.terrain",
      "x.terrain%00.png",
      ".hidden.terrain",
      "dir/.secret/a.terrain",
      "scene.scene.json",
      "model.glb",
      "noextension",
      "a.terrain.png",
      "",
    ];
    for (const path of bad) {
      assertEquals(
        await status(writes.handle("PUT", path, q("create=1&size=4"), bytes())),
        400,
        path,
      );
    }
    // Nothing was created anywhere, including outside the assets directory.
    assertEquals(
      [...Deno.readDirSync(join(dir, "assets"))].map((e) => e.name),
      [],
    );
    assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), ["assets"]);
  });
});

Deno.test("a symbolic link cannot lead a write out of assets", async () => {
  await withAssets(async (dir, writes) => {
    const outside = join(dir, "outside");
    await Deno.mkdir(outside);
    await Deno.writeFile(join(outside, "secret.terrain"), bytes(1, 2, 3, 4));
    await Deno.symlink(outside, join(dir, "assets", "link"));
    await Deno.symlink(
      join(outside, "secret.terrain"),
      join(dir, "assets", "file.terrain"),
    );
    const patch = encodeSegments([{ offset: 0, bytes: bytes(9) }]);
    assertEquals(
      await status(writes.handle("PATCH", "link/secret.terrain", q(), patch)),
      400,
    );
    assertEquals(
      await status(writes.handle("PATCH", "file.terrain", q(), patch)),
      400,
    );
    assertEquals(
      await status(
        writes.handle("PUT", "link/new.terrain", q("create=1&size=8"), bytes()),
      ),
      400,
    );
    assertEquals(
      await Deno.readFile(join(outside, "secret.terrain")),
      bytes(1, 2, 3, 4),
    );
  });
});

Deno.test("create makes a zero-filled file once, in new folders", async () => {
  await withAssets(async (dir, writes) => {
    const file = join(dir, "assets/terrain/world.terrain");
    assertEquals(
      await writes.handle(
        "PUT",
        "terrain/world.terrain",
        q("create=1&size=100"),
        bytes(),
      ),
      { size: 100 },
    );
    assertEquals(await Deno.readFile(file), new Uint8Array(100));
    assertEquals(
      await status(
        writes.handle(
          "PUT",
          "terrain/world.terrain",
          q("create=1&size=100"),
          bytes(),
        ),
      ),
      409,
    );
    // A body with a size, a size without create, and silly sizes are refused.
    for (
      const [query, body] of [
        ["create=1&size=3", bytes(1)],
        ["size=3", bytes()],
        ["create=1&size=-1", bytes()],
        ["create=1&size=1e3", bytes()],
        ["create=1&size=999999999999", bytes()],
        ["create=1&size=", bytes()],
      ] as [string, Uint8Array][]
    ) {
      assertEquals(
        await status(writes.handle("PUT", "other.terrain", q(query), body)),
        400,
        query,
      );
    }
    // A whole new file with a body.
    await writes.handle("PUT", "new.scatter", q("create=1"), bytes(5, 6));
    assertEquals(
      await Deno.readFile(join(dir, "assets/new.scatter")),
      bytes(5, 6),
    );
    assertEquals(
      await status(writes.handle("PUT", "new.scatter", q("create=1"), bytes())),
      409,
    );
  });
});

Deno.test("put replaces an existing file whole, with no temporary left", async () => {
  await withAssets(async (dir, writes) => {
    assertEquals(
      await status(writes.handle("PUT", "a.scatter", q(), bytes(1))),
      404,
    );
    await Deno.writeFile(join(dir, "assets/a.scatter"), bytes(1, 2, 3, 4, 5));
    await writes.handle("PUT", "a.scatter", q(), bytes(7, 8));
    assertEquals(
      await Deno.readFile(join(dir, "assets/a.scatter")),
      bytes(7, 8),
    );
    assertEquals(
      [...Deno.readDirSync(join(dir, "assets"))].map((e) => e.name),
      ["a.scatter"],
    );
  });
});

Deno.test("patch writes byte ranges in place and changes nothing on a bad one", async () => {
  await withAssets(async (dir, writes) => {
    const file = join(dir, "assets/t.terrain");
    await writes.handle("PUT", "t.terrain", q("create=1&size=16"), bytes());
    const result = await writes.handle(
      "PATCH",
      "t.terrain",
      q(),
      encodeSegments([
        { offset: 0, bytes: bytes(1, 2, 3, 4) },
        { offset: 12, bytes: bytes(9, 9, 9, 9) },
        { offset: 2, bytes: bytes(7) },
      ]),
    );
    assertEquals(result, { size: 16 });
    assertEquals(
      await Deno.readFile(file),
      bytes(1, 2, 7, 4, 0, 0, 0, 0, 0, 0, 0, 0, 9, 9, 9, 9),
    );
    // One range past the end fails the whole request: the first is not applied.
    const before = await Deno.readFile(file);
    assertEquals(
      await status(
        writes.handle(
          "PATCH",
          "t.terrain",
          q(),
          encodeSegments([
            { offset: 0, bytes: bytes(5, 5) },
            { offset: 15, bytes: bytes(1, 1) },
          ]),
        ),
      ),
      400,
    );
    assertEquals(await Deno.readFile(file), before);
    assertEquals(
      await status(writes.handle("PATCH", "t.terrain", q(), bytes(1, 2, 3))),
      400,
    );
    assertEquals(
      await status(
        writes.handle("PATCH", "missing.terrain", q(), encodeSegments([])),
      ),
      404,
    );
    assertEquals(
      await status(writes.handle("POST", "t.terrain", q(), bytes())),
      405,
    );
  });
});

Deno.test("writes to one file happen in the order they arrived", async () => {
  await withAssets(async (dir, writes) => {
    await writes.handle("PUT", "t.terrain", q("create=1&size=4"), bytes());
    const requests = Array.from(
      { length: 20 },
      (_, i) =>
        writes.handle(
          "PATCH",
          "t.terrain",
          q(),
          encodeSegments([{ offset: 0, bytes: bytes(i, i, i, i) }]),
        ),
    );
    await Promise.all(requests);
    assertEquals(
      await Deno.readFile(join(dir, "assets/t.terrain")),
      bytes(19, 19, 19, 19),
    );
  });
});

Deno.test("the watcher's echo of our own write is ignored, however late, until the file changes", async () => {
  await withAssets(async (dir, writes) => {
    const file = join(dir, "assets/t.terrain");
    assertEquals(await writes.isOwnChange(file), false);
    await writes.handle("PUT", "t.terrain", q("create=1&size=8"), bytes());
    await writes.handle(
      "PATCH",
      "t.terrain",
      q(),
      encodeSegments([{ offset: 0, bytes: bytes(1) }]),
    );
    // The watcher reports a write once per write call, and for seconds
    // afterwards: every one of them is ours while the file is as we left it.
    for (let i = 0; i < 5; i++) {
      assertEquals(await writes.isOwnChange(file), true);
      await new Promise((r) => setTimeout(r, 5));
    }
    // Another program writes the file (later, or restoring an older copy):
    // a real change, and so are the events that follow it.
    for (const when of [Date.now() + 5000, Date.now() - 86_400_000]) {
      await Deno.writeFile(file, bytes(1, 2, 3, 4, 5, 6, 7, 8));
      await Deno.utime(file, new Date(when), new Date(when));
      assertEquals(await writes.isOwnChange(file), false);
      assertEquals(await writes.isOwnChange(file), false);
    }
    // After our next write, the file is ours again.
    await writes.handle(
      "PATCH",
      "t.terrain",
      q(),
      encodeSegments([{ offset: 1, bytes: bytes(5) }]),
    );
    assertEquals(await writes.isOwnChange(file), true);
    // A file we have not written is never ours.
    await Deno.writeFile(join(dir, "assets/other.terrain"), bytes(1));
    assertEquals(
      await writes.isOwnChange(join(dir, "assets/other.terrain")),
      false,
    );
    // And a deleted one is a change.
    await Deno.remove(file);
    assertEquals(await writes.isOwnChange(file), false);
  });
});

Deno.test("a different file or a changed size is a real change", async () => {
  await withAssets(async (dir, writes) => {
    await writes.handle("PUT", "a.terrain", q("create=1&size=8"), bytes());
    assertEquals(
      await writes.isOwnChange(join(dir, "assets/b.terrain")),
      false,
    );
    await Deno.writeFile(join(dir, "assets/a.terrain"), bytes(1, 2));
    assertEquals(
      await writes.isOwnChange(join(dir, "assets/a.terrain")),
      false,
    );
  });
});

Deno.test("request bodies are read up to a limit", async () => {
  async function* chunks(...sizes: number[]) {
    for (const n of sizes) yield new Uint8Array(n).fill(n);
  }
  assertEquals(await readBody(chunks(2, 3)), bytes(2, 2, 3, 3, 3));
  await assertRejects(
    () => readBody(chunks(5, 5), 9),
    AssetWriteError,
    "too large",
  );
  assert(MAX_ASSET_BODY >= 64 * 1024 * 1024);
});
