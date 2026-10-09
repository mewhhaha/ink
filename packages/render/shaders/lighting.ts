/**
 * Physically based lighting: GGX / Smith / Schlick BRDF, the light loop and
 * ambient. The loop calls the hooks in shadows.ts, ao.ts and environment.ts;
 * everything else a surface needs is in `Surface`.
 */
import { clusterLookupWgsl } from "./clusters.ts";
import { CLUSTER_CAPACITY } from "./frame_layout.ts";

export const lightingWgsl = /* wgsl */ `
${clusterLookupWgsl}
struct Surface {
  world: vec3f,
  normal: vec3f,     // shading normal, facing the viewer
  ng: vec3f,         // interpolated geometric normal, facing the viewer
  view: vec3f,       // towards the eye
  nv: f32,
  albedo: vec3f,
  metallic: f32,
  roughness: f32,
  occlusion: f32,    // material (baked) occlusion
  emissive: vec3f,
  indirect: vec3f,
  frag: vec2f,       // device-pixel position
}

fn distGGX(nh: f32, a: f32) -> f32 {
  let a2 = a * a;
  let d = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

fn visSmith(nl: f32, nv: f32, a: f32) -> f32 {
  // Hammon's approximation of the height-correlated Smith visibility term.
  return 0.5 / mix(2.0 * nl * nv, nl + nv, a);
}

fn fresnel(vh: f32, f0: vec3f) -> vec3f {
  return f0 + (1.0 - f0) * pow(1.0 - vh, 5.0);
}

// Radiance reflected towards the eye from light i (shadowed).
fn evaluateLight(i: i32, s: Surface, f0: vec3f) -> vec3f {
  let light = lights[i];
  let kind = light.posType.w;
  var l = -light.dirCone.xyz;
  var atten = 1.0;
  if (kind > 0.5) {
    let delta = light.posType.xyz - s.world;
    let range = light.colorRange.w;
    // Most candidates in a conservative cluster are outside this pixel's
    // range. Reject before normalizing directions and evaluating spot cones.
    if (range > 0.0 && dot(delta, delta) >= range * range) { return vec3f(0.0); }
    let dist = length(delta);
    l = delta / max(dist, 1e-4);
    var window = 1.0;
    if (range > 0.0) {
      let q = dist / range;
      window = clamp(1.0 - q * q * q * q, 0.0, 1.0);
      window = window * window;
    }
    atten = window / max(dist * dist, 0.01);
    if (kind > 1.5) {
      let cd = dot(-l, light.dirCone.xyz);
      atten = atten * smoothstep(light.dirCone.w, light.extra.x, cd);
    }
  }
  let nl = max(dot(s.normal, l), 0.0);
  if (nl <= 0.0 || atten <= 0.0) { return vec3f(0.0); }
  var visibility = 1.0;
  if (kind < 0.5) {
    visibility = sunShadow(i, s.world, s.normal, nl, s.frag);
  } else if (light.extra.z >= 0.0) {
    visibility = localShadow(i, s.world, s.normal, nl, s.frag);
  }
  let alpha = s.roughness * s.roughness;
  let h = normalize(l + s.view);
  let nh = max(dot(s.normal, h), 0.0);
  let vh = max(dot(s.view, h), 0.0);
  let f = fresnel(vh, f0);
  let spec = f * (distGGX(nh, alpha) * visSmith(nl, s.nv, alpha) * PI);
  let kd = (vec3f(1.0) - f) * (1.0 - s.metallic);
  return (kd * s.albedo + spec) * light.colorRange.rgb * (nl * atten * visibility);
}

// Direct light + ambient + emission, in linear HDR.
fn shadeSurface(s: Surface) -> vec3f {
  let f0 = mix(vec3f(0.04), s.albedo, s.metallic);
  var color = vec3f(0.0);
  var count = u32(frame.params.y);
  var offset = 0u;
  var clustered = frame.clusterGrid.w > 0.5;
  if (clustered) {
    offset = clusterOffset(s.world, s.frag);
    let culled = lightClusters[offset];
    // Dense overlap is correct too: never silently drop excess lights.
    if (culled > ${CLUSTER_CAPACITY}u) { clustered = false; }
    else { count = culled; }
  }
  for (var i = 0u; i < count; i++) {
    var index = i;
    if (clustered) { index = lightClusters[offset + 1u + i]; }
    color += evaluateLight(i32(index), s, f0);
  }
  // Screen-space occlusion (strength applied) and the material's own.
  let ssao = pow(max(ambientOcclusion(s.frag, s.world), 1e-3), frame.envInfo.y);
  let aoDiffuse = multiBounceAo(ssao, s.albedo * (1.0 - s.metallic)) * s.occlusion;
  let aoSpecular = specularOcclusion(s.nv, ssao, s.roughness) * s.occlusion;
  let fEnv = environmentBrdf(f0, s.roughness, s.nv);
  let refl = reflect(-s.view, s.normal);
  let diffuse = ambientDiffuse(s.normal) * s.albedo * (1.0 - s.metallic) * (vec3f(1.0) - fEnv);
  let specular = ambientSpecular(refl, s.roughness, s.nv) * fEnv * horizonOcclusion(refl, s.ng);
  color += diffuse * aoDiffuse + specular * aoSpecular;
  color += s.indirect * s.albedo * (1.0 - s.metallic) * (vec3f(1.0) - fEnv) * s.occlusion;
  return debugView(color + s.emissive, ssao * s.occlusion);
}
`;
