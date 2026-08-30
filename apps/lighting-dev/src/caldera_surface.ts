import type { Simple3dTexture } from "@ink/rendering/simple3d.ts";
import { caldera_surface_texture_id } from "./scene.ts";

export async function create_caldera_surface_texture(): Promise<
  Simple3dTexture
> {
  const size = 256;
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const row = Math.floor(y / 32);
    for (let x = 0; x < size; x += 1) {
      const shifted_x = x + (row % 2) * 32;
      const mortar = shifted_x % 64 < 2 || y % 32 < 2;
      const grain = ((x * 37 + y * 73 + x * y * 3) % 29) - 14;
      const weathering = Math.sin(x * 0.11) * 7 + Math.cos(y * 0.07) * 5;
      const offset = (y * size + x) * 4;
      if (mortar) {
        pixels.set([70, 66, 59, 255], offset);
        continue;
      }
      pixels[offset] = clamp_channel(174 + grain + weathering);
      pixels[offset + 1] = clamp_channel(157 + grain + weathering);
      pixels[offset + 2] = clamp_channel(128 + grain * 0.7 + weathering);
      pixels[offset + 3] = 255;
    }
  }
  return {
    color_space: "srgb",
    id: caldera_surface_texture_id,
    source: await createImageBitmap(new ImageData(pixels, size, size)),
  };
}

function clamp_channel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
