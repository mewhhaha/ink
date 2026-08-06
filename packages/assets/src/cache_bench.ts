import { AssetCache } from "./cache.ts";
import { artifact_revision, asset_id } from "./identity.ts";
import { parse_obj } from "./obj.ts";
import { decode_image } from "./media.ts";

Deno.bench("asset cache lease acquisition and release", () => {
  const id = asset_id("benchmark/asset");
  const cache = new AssetCache(16);
  cache.publish({
    type: "ready",
    id,
    revision: artifact_revision("revision-1"),
    bytes: new Uint8Array(16),
  });

  const lease = cache.acquire(id)!;
  lease.release();
});

const obj_source = [
  "v 0 0 0",
  "v 1 0 0",
  "v 0 1 0",
  ...Array.from({ length: 1_000 }, () => "f 1 2 3"),
].join("\n");

Deno.bench("parse a 1,000-triangle OBJ fixture", () => {
  const result = parse_obj(obj_source, "benchmark.obj");
  if (result.type !== "ready" || result.document.triangles.length !== 1_000) {
    throw new Error("OBJ benchmark did not produce 1,000 triangles");
  }
});

Deno.bench("publish 1,000 streamed assets through a bounded cache", () => {
  const cache = new AssetCache(128);
  for (let index = 0; index < 1_000; index += 1) {
    const result = cache.publish({
      type: "ready",
      id: asset_id(`world/${index}`),
      revision: artifact_revision("revision-1"),
      bytes: new Uint8Array(16),
    });
    if (result.type !== "published") throw new Error(result.reason);
  }
});

Deno.bench("atomically replace a 100-asset shared revision set", () => {
  const cache = new AssetCache(3_200);
  const replacements = Array.from({ length: 100 }, (_, index) => {
    const id = asset_id(`shared/${index}`);
    cache.publish({
      type: "ready",
      id,
      revision: artifact_revision("revision-1"),
      bytes: new Uint8Array(16),
    });
    return {
      artifact: {
        type: "ready" as const,
        id,
        revision: artifact_revision("revision-2"),
        bytes: new Uint8Array(16),
      },
      dependencies: [],
    };
  });
  const result = cache.replace(replacements);
  if (result.type !== "replaced") throw new Error(result.reason);
});

Deno.bench("decode a small image through an injected codec", async () => {
  const result = await decode_image({
    decode() {
      return Promise.resolve({
        width: 16,
        height: 16,
        rgba8: new Uint8Array(16 * 16 * 4),
        color_space: "srgb",
        mip_level_count: 1,
      });
    },
  }, {
    bytes: new Uint8Array(32),
    mime_type: "image/png",
    color_space: "srgb",
    mip_policy: "source-only",
  });
  if (result.type !== "ready") throw new Error(result.type);
});
