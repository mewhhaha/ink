/** Final pass (linear light to sRGB, selection outline) and frame readback. */
import type { Core } from "./core.ts";
import { BufferUsage, MAP_READ, texture2d, TextureUsage } from "./gpu.ts";
import type { PixelData } from "./types.ts";

/** Encode the final pass into `target`. */
export function encodeFinal(
  encoder: GPUCommandEncoder,
  core: Core,
  group: GPUBindGroup,
  target: GPUTextureView,
) {
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: target,
      loadOp: "clear",
      storeOp: "store",
      clearValue: [0, 0, 0, 1],
    }],
  });
  pass.setPipeline(core.pipelines.final);
  pass.setBindGroup(0, group);
  pass.draw(3);
  pass.end();
}

/** Run the final pass into a scratch texture and read it back as RGBA8. */
export async function readFrame(
  core: Core,
  group: GPUBindGroup,
  width: number,
  height: number,
): Promise<PixelData> {
  const { device, format } = core;
  const texture = texture2d(
    device,
    "capture",
    width,
    height,
    format,
    TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC,
  );
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const staging = device.createBuffer({
    label: "capture-readback",
    size: bytesPerRow * height,
    usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
  });
  const encoder = device.createCommandEncoder({ label: "capture" });
  encodeFinal(encoder, core, group, texture.createView());
  encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow }, [
    width,
    height,
  ]);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(MAP_READ);
  const mapped = new Uint8Array(staging.getMappedRange());
  const data = new Uint8Array(width * height * 4);
  const swap = format.startsWith("bgra");
  for (let y = 0; y < height; y++) {
    const row = mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4);
    data.set(row, y * width * 4);
  }
  if (swap) {
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      data[i] = data[i + 2];
      data[i + 2] = r;
    }
  }
  staging.unmap();
  staging.destroy();
  texture.destroy();
  return { width, height, data };
}
