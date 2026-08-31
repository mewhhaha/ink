import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

const viewport = { width: 960, height: 720 };
const target_object_id = "raster-quality-target";

test(
  "canonical raster submission uses texture mips, anisotropy, and distance LOD",
  { timeout: 120_000 },
  async (context) => {
    let server;
    let browser;
    try {
      const { default: configure } = await import(
        `../../ink.ts?raster=${crypto.randomUUID()}`
      );
      const configuration = await configure({
        command: "serve",
        mode: "browser-test",
        isSsrBuild: false,
        isPreview: false,
      });
      server = await createServer({
        ...configuration,
        configFile: false,
        logLevel: "silent",
        server: {
          ...configuration.server,
          host: "127.0.0.1",
          port: 0,
        },
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (
        typeof address !== "object" || address === null ||
        !Number.isSafeInteger(address.port) || address.port <= 0
      ) {
        throw new Error(
          `lighting browser server returned invalid address ${
            JSON.stringify(address)
          }`,
        );
      }

      browser = await chromium.launch({
        headless: true,
        args: [
          "--enable-unsafe-webgpu",
          "--enable-features=Vulkan",
          "--use-angle=vulkan",
        ],
      });
      const page = await browser.newPage({ viewport });
      await install_gpu_capture(page);
      const browser_errors = [];
      page.on("crash", () => browser_errors.push("page crashed"));
      page.on("pageerror", (error) => browser_errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") browser_errors.push(message.text());
      });
      await page.goto(
        `http://127.0.0.1:${address.port}/raster-quality.html`,
        { waitUntil: "domcontentloaded" },
      );
      const startup = await wait_for_raster_quality(page);
      if (startup.type === "gpu_unavailable") {
        context.skip(startup.reason);
        return;
      }

      await page.waitForTimeout(100);
      const near_pixels = await read_canvas_pixels(page);
      const near = await read_raster_snapshot(page);
      assert_renderer_snapshot(near, "detailed");
      assert_texture_pixels(near_pixels, "near");

      const far = await page.evaluate(() =>
        globalThis.__ink_raster_quality.show_distance("far")
      );
      await page.waitForTimeout(100);
      const far_pixels = await read_canvas_pixels(page);
      const settled_far = await read_raster_snapshot(page);
      assert.deepEqual(settled_far, far);
      assert_renderer_snapshot(settled_far, "distant");
      assert_texture_pixels(far_pixels, "far");
      assert.ok(
        near_pixels.non_clear_fraction > far_pixels.non_clear_fraction * 2,
        `camera distance did not materially reduce target coverage: ${
          JSON.stringify({ near_pixels, far_pixels })
        }`,
      );

      const gpu_calls = await page.evaluate(() =>
        globalThis.__ink_raster_gpu_calls
      );
      assert_gpu_texture_quality(gpu_calls);
      assert.deepEqual(browser_errors, []);
    } finally {
      await browser?.close();
      await server?.close();
    }
  },
);

async function install_gpu_capture(page) {
  await page.addInitScript(() => {
    const calls = {
      installed: false,
      bind_groups: [],
      external_copies: [],
      render_passes: [],
      samplers: [],
      textures: [],
    };
    Object.assign(globalThis, { __ink_raster_gpu_calls: calls });
    if (
      globalThis.GPUDevice === undefined ||
      globalThis.GPUTexture === undefined ||
      globalThis.GPUQueue === undefined ||
      globalThis.GPUCommandEncoder === undefined ||
      globalThis.GPURenderPassEncoder === undefined
    ) return;

    const texture_records = new WeakMap();
    const view_records = new WeakMap();
    const sampler_records = new WeakMap();
    const bind_group_records = new WeakMap();
    const render_pass_records = new WeakMap();
    calls.installed = true;

    const original_create_texture = GPUDevice.prototype.createTexture;
    GPUDevice.prototype.createTexture = function (descriptor) {
      const texture = original_create_texture.call(this, descriptor);
      const size = Array.isArray(descriptor.size)
        ? {
          width: descriptor.size[0],
          height: descriptor.size[1] ?? 1,
          depth: descriptor.size[2] ?? 1,
        }
        : {
          width: descriptor.size.width,
          height: descriptor.size.height ?? 1,
          depth: descriptor.size.depthOrArrayLayers ?? 1,
        };
      const record = {
        ...size,
        format: descriptor.format,
        mip_level_count: descriptor.mipLevelCount ?? 1,
        views: [],
      };
      texture_records.set(texture, calls.textures.length);
      calls.textures.push(record);
      return texture;
    };

    const original_create_view = GPUTexture.prototype.createView;
    GPUTexture.prototype.createView = function (descriptor = {}) {
      const view = original_create_view.call(this, descriptor);
      const texture = texture_records.get(this);
      if (texture === undefined) return view;
      const record = {
        base_mip_level: descriptor.baseMipLevel ?? 0,
        mip_level_count: descriptor.mipLevelCount ?? null,
        texture,
      };
      calls.textures[texture].views.push(record);
      view_records.set(view, record);
      return view;
    };

    const original_create_sampler = GPUDevice.prototype.createSampler;
    GPUDevice.prototype.createSampler = function (descriptor = {}) {
      const sampler = original_create_sampler.call(this, descriptor);
      sampler_records.set(sampler, calls.samplers.length);
      calls.samplers.push({
        address_mode_u: descriptor.addressModeU ?? "clamp-to-edge",
        address_mode_v: descriptor.addressModeV ?? "clamp-to-edge",
        magnification_filter: descriptor.magFilter ?? "nearest",
        max_anisotropy: descriptor.maxAnisotropy ?? 1,
        minification_filter: descriptor.minFilter ?? "nearest",
        mipmap_filter: descriptor.mipmapFilter ?? "nearest",
      });
      return sampler;
    };

    const original_create_bind_group = GPUDevice.prototype.createBindGroup;
    GPUDevice.prototype.createBindGroup = function (descriptor) {
      const bind_group = original_create_bind_group.call(this, descriptor);
      const sampler_indices = [];
      const texture_indices = [];
      for (const entry of descriptor.entries) {
        const sampler = sampler_records.get(entry.resource);
        if (sampler !== undefined) sampler_indices.push(sampler);
        const view = view_records.get(entry.resource);
        if (view !== undefined) texture_indices.push(view.texture);
      }
      bind_group_records.set(bind_group, calls.bind_groups.length);
      calls.bind_groups.push({ sampler_indices, texture_indices });
      return bind_group;
    };

    const original_copy_external =
      GPUQueue.prototype.copyExternalImageToTexture;
    GPUQueue.prototype.copyExternalImageToTexture = function (
      source,
      destination,
      copy_size,
    ) {
      const texture = texture_records.get(destination.texture);
      if (texture !== undefined) {
        calls.external_copies.push({
          height: Array.isArray(copy_size) ? copy_size[1] : copy_size.height,
          texture,
          width: Array.isArray(copy_size) ? copy_size[0] : copy_size.width,
        });
      }
      return original_copy_external.call(
        this,
        source,
        destination,
        copy_size,
      );
    };

    const original_begin_render_pass =
      GPUCommandEncoder.prototype.beginRenderPass;
    GPUCommandEncoder.prototype.beginRenderPass = function (descriptor) {
      const color_attachments = [];
      for (const attachment of descriptor.colorAttachments) {
        if (attachment === null) continue;
        const view = view_records.get(attachment.view);
        if (view !== undefined) color_attachments.push(view);
      }
      const pass = original_begin_render_pass.call(this, descriptor);
      const record = {
        bind_group_indices: [],
        color_attachments,
        draw_count: 0,
      };
      render_pass_records.set(pass, calls.render_passes.length);
      calls.render_passes.push(record);
      return pass;
    };

    const original_set_bind_group = GPURenderPassEncoder.prototype.setBindGroup;
    GPURenderPassEncoder.prototype.setBindGroup = function (...parameters) {
      const pass = render_pass_records.get(this);
      const bind_group = bind_group_records.get(parameters[1]);
      if (pass !== undefined && bind_group !== undefined) {
        calls.render_passes[pass].bind_group_indices.push(bind_group);
      }
      return original_set_bind_group.apply(this, parameters);
    };

    for (const method of ["draw", "drawIndexed"]) {
      const original_draw = GPURenderPassEncoder.prototype[method];
      GPURenderPassEncoder.prototype[method] = function (...parameters) {
        const pass = render_pass_records.get(this);
        if (pass !== undefined) calls.render_passes[pass].draw_count += 1;
        return original_draw.apply(this, parameters);
      };
    }
  });
}

async function wait_for_raster_quality(page) {
  await page.waitForFunction(() => {
    const state = document.querySelector("main")?.dataset.runtimeState;
    return state === "ready" || state === "failed";
  });
  const root = page.locator("main");
  if (await root.getAttribute("data-runtime-state") === "ready") {
    return { type: "ready" };
  }
  const reason = (await page.locator("output").textContent()) ??
    "raster quality runtime failed without evidence";
  if (
    /WebGPU is unavailable|no WebGPU adapter|software fallback|adapter is a software fallback/i
      .test(reason)
  ) {
    return { type: "gpu_unavailable", reason };
  }
  throw new Error(`raster quality browser runtime failed: ${reason}`);
}

async function read_raster_snapshot(page) {
  return await page.evaluate(() => globalThis.__ink_raster_quality.snapshot());
}

function assert_renderer_snapshot(snapshot, expected_lod) {
  assert.equal(snapshot.status.type, "ready", JSON.stringify(snapshot));
  assert.equal(snapshot.validation_error_count, 0, JSON.stringify(snapshot));
  assert.doesNotMatch(
    snapshot.adapter,
    /fallback|swiftshader|software/i,
    JSON.stringify(snapshot),
  );
  assert.equal(snapshot.frame.type, "raster", JSON.stringify(snapshot));
  assert.deepEqual(
    snapshot.frame.visibility.submitted,
    [{ object_id: target_object_id, lod: expected_lod }],
    JSON.stringify(snapshot.frame.visibility),
  );
  assert.equal(snapshot.pick.type, "hit", JSON.stringify(snapshot.pick));
  assert.equal(
    snapshot.pick.object_id,
    target_object_id,
    JSON.stringify(snapshot.pick),
  );
}

function assert_gpu_texture_quality(calls) {
  assert.equal(calls.installed, true, JSON.stringify(calls));
  const texture_index = calls.textures.findIndex((texture) =>
    texture.width === 256 && texture.height === 256 &&
    texture.mip_level_count === 9
  );
  assert.notEqual(
    texture_index,
    -1,
    `renderer did not create the nine-level proof texture: ${
      JSON.stringify(calls.textures)
    }`,
  );
  assert.ok(
    calls.external_copies.some((copy) =>
      copy.texture === texture_index && copy.width === 256 &&
      copy.height === 256
    ),
    `renderer did not upload the proof texture: ${
      JSON.stringify(calls.external_copies)
    }`,
  );
  const rendered_mip_levels = [
    ...new Set(
      calls.render_passes.flatMap(({ color_attachments, draw_count }) =>
        draw_count === 0
          ? []
          : color_attachments.filter(({ texture }) => texture === texture_index)
            .map(({ base_mip_level }) => base_mip_level)
      ),
    ),
  ].sort((left, right) => left - right);
  assert.deepEqual(
    rendered_mip_levels,
    [1, 2, 3, 4, 5, 6, 7, 8],
    `renderer did not encode every generated mip level: ${
      JSON.stringify(calls.render_passes)
    }`,
  );
  const anisotropic_sampler_indices = calls.samplers.flatMap((sampler, index) =>
    sampler.address_mode_u === "repeat" &&
      sampler.address_mode_v === "repeat" &&
      sampler.magnification_filter === "linear" &&
      sampler.minification_filter === "linear" &&
      sampler.mipmap_filter === "linear" &&
      sampler.max_anisotropy === 8
      ? [index]
      : []
  );
  assert.ok(
    anisotropic_sampler_indices.length > 0,
    `renderer did not create the canonical anisotropic sampler: ${
      JSON.stringify(calls.samplers)
    }`,
  );
  const anisotropic_bind_group_indices = calls.bind_groups.flatMap((
    { sampler_indices, texture_indices },
    index,
  ) =>
    texture_indices.includes(texture_index) &&
      sampler_indices.some((sampler) =>
        anisotropic_sampler_indices.includes(sampler)
      )
      ? [index]
      : []
  );
  assert.ok(
    calls.render_passes.some(({ bind_group_indices, draw_count }) =>
      draw_count > 0 &&
      bind_group_indices.some((bind_group) =>
        anisotropic_bind_group_indices.includes(bind_group)
      )
    ),
    `renderer did not bind the anisotropic sampler with the proof texture: ${
      JSON.stringify({
        bind_groups: calls.bind_groups,
        render_passes: calls.render_passes,
      })
    }`,
  );
}

async function read_canvas_pixels(page) {
  const screenshot = await page.locator("canvas").screenshot({ type: "png" });
  return await page.evaluate(async (encoded_png) => {
    const rendered = new Image();
    rendered.src = `data:image/png;base64,${encoded_png}`;
    await rendered.decode();
    const copy = document.createElement("canvas");
    copy.width = rendered.naturalWidth;
    copy.height = rendered.naturalHeight;
    const context = copy.getContext("2d", { willReadFrequently: true });
    if (context === null) {
      throw new Error("raster quality proof could not read its canvas");
    }
    context.drawImage(rendered, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height);
    const minimum_x = Math.floor(copy.width * 0.2);
    const maximum_x = Math.ceil(copy.width * 0.8);
    const minimum_y = Math.floor(copy.height * 0.12);
    const maximum_y = Math.ceil(copy.height * 0.88);
    let blue = 0;
    let non_clear = 0;
    let yellow = 0;
    let count = 0;
    for (let y = minimum_y; y < maximum_y; y += 1) {
      for (let x = minimum_x; x < maximum_x; x += 1) {
        const offset = (y * copy.width + x) * 4;
        const red = pixels.data[offset];
        const green = pixels.data[offset + 1];
        const blue_channel = pixels.data[offset + 2];
        if (Math.max(red, green, blue_channel) > 18) non_clear += 1;
        if (blue_channel > red * 1.35 && blue_channel > green * 1.15) {
          blue += 1;
        }
        if (red > blue_channel * 1.5 && green > blue_channel * 1.2) {
          yellow += 1;
        }
        count += 1;
      }
    }
    return {
      blue_fraction: blue / count,
      non_clear_fraction: non_clear / count,
      yellow_fraction: yellow / count,
    };
  }, screenshot.toString("base64"));
}

function assert_texture_pixels(pixels, distance) {
  const minimum_non_clear = distance === "near" ? 0.03 : 0.0005;
  const minimum_color = distance === "near" ? 0.002 : 0.00005;
  assert.ok(
    pixels.non_clear_fraction > minimum_non_clear,
    `${distance} raster frame lacks non-clear target pixels: ${
      JSON.stringify(pixels)
    }`,
  );
  assert.ok(
    pixels.blue_fraction > minimum_color &&
      pixels.yellow_fraction > minimum_color,
    `${distance} raster frame did not sample both checker colors: ${
      JSON.stringify(pixels)
    }`,
  );
}
