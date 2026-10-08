/** Blue-noise helpers. The 64x64 texture is shared by every shader; bind it
 * wherever it is wanted and declare it with `blueNoiseWgsl(group, binding)`. */
export const BLUE_NOISE_SIZE = 64;

export const blueNoiseWgsl = (group: number, binding: number) => /* wgsl */ `
@group(${group}) @binding(${binding}) var blueNoiseTexture: texture_2d<f32>;

// Blue noise in [0, 1) at a pixel (any integer position; the tile repeats).
fn blueNoise(pixel: vec2f) -> f32 {
  let p = vec2i(floor(pixel)) & vec2i(${BLUE_NOISE_SIZE - 1});
  return textureLoad(blueNoiseTexture, p, 0).r;
}

// The same, changing every frame without losing its spectrum (golden ratio
// increments); use for film grain and temporal sampling.
fn blueNoiseAnimated(pixel: vec2f, frameIndex: f32) -> f32 {
  return fract(blueNoise(pixel) + (frameIndex % 64.0) * 0.6180339887);
}
`;
