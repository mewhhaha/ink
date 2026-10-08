/**
 * Tonemap-weighted resolve. The MSAA scene target stores c / (1 + max(c))
 * instead of c, so the hardware's plain average of samples weights bright
 * samples less (Karis): a very bright edge no longer blows past its
 * neighbours and aliases after tonemapping. Post decodes it again. Radiance
 * is clamped to HDR_MAX; precision of the stored value (float16) limits very
 * bright values to a few percent, which tonemapping and bloom hide.
 */
export const HDR_MAX = 512;

export const hdrWgsl = /* wgsl */ `
const HDR_MAX: f32 = ${HDR_MAX}.0;

fn packHdr(c: vec3f) -> vec3f {
  let k = clamp(c, vec3f(0.0), vec3f(HDR_MAX));
  return k / (1.0 + max(k.r, max(k.g, k.b)));
}

fn unpackHdr(p: vec3f) -> vec3f {
  let m = min(max(p.r, max(p.g, p.b)), 0.9995);
  return p / (1.0 - m);
}

// Output of every main-pass fragment shader: opaque scene radiance.
fn hdrOut(c: vec3f) -> vec4f {
  return vec4f(packHdr(c), 1.0);
}
`;

/** Turns the resolved tonemap-weighted target back into linear HDR. */
export const decodeShader = /* wgsl */ `
${hdrWgsl}
@group(0) @binding(0) var src: texture_2d<f32>;

@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let t = textureLoad(src, vec2i(frag.xy), 0);
  return vec4f(unpackHdr(t.rgb), t.a);
}
`;
