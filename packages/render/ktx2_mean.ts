/** Mean colour (linear light) of sRGB RGBA8 pixels. */
export function srgbMean(rgba: Uint8Array): [number, number, number] {
  const sum: [number, number, number] = [0, 0, 0];
  const count = rgba.length / 4;
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) {
      const c = rgba[i * 4 + k] / 255;
      sum[k] += c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }
  }
  return sum.map((v) => v / Math.max(1, count)) as [number, number, number];
}
