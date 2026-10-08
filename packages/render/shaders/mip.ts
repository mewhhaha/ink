/** Box-filtered mip generation: each level samples the previous one. */
export const mipShader = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o: VOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

@fragment fn fs(v: VOut) -> @location(0) vec4f {
  return textureSample(src, smp, v.uv);
}
`;
