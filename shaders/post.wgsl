struct Parameters { inverseProjection: mat4x4f, settings: vec4f, extra: vec4f };
@group(0) @binding(0) var<uniform> params: Parameters;
@group(0) @binding(1) var a: texture_2d<f32>;
@group(0) @binding(2) var b: texture_2d<f32>;
@group(0) @binding(3) var c: texture_2d<f32>;
@group(0) @binding(4) var d: texture_2d<f32>;
@group(0) @binding(5) var e: texture_2d<f32>;
@group(0) @binding(6) var linearSampler: sampler;
@group(1) @binding(0) var output: texture_storage_2d<rgba16float, write>;
fn load(source: texture_2d<f32>, p: vec2i) -> vec4f {
  let size = vec2i(textureDimensions(source));
  return textureLoad(source, clamp(p, vec2i(0), size - 1), 0);
}
@group(1) @binding(1) var scalar: texture_storage_2d<r32float, write>;
fn valid(p: vec2u, size: vec2u) -> bool { return all(p < size); }
fn uv(p: vec2u, size: vec2u) -> vec2f { return (vec2f(p) + 0.5) / vec2f(size); }
fn hdr(value: vec3f) -> vec3f { return clamp(value, vec3f(0.0), vec3f(65504.0)); }
fn viewPosition(screen: vec2f, depth: f32) -> vec3f {
  let ndc = vec2f(screen.x * 2.0 - 1.0, 1.0 - screen.y * 2.0);
  let nearH = params.inverseProjection * vec4f(ndc, 0.0, 1.0);
  let farH = params.inverseProjection * vec4f(ndc, 1.0, 1.0);
  let near = nearH.xyz / nearH.w;
  let far = farH.xyz / farH.w;
  return mix(near, far, (-depth - near.z) / (far.z - near.z));
}
// Integrate visibility between the two sampled horizons in each view slice.
// The normal projection weights each slice; background samples are open sky.
@compute @workgroup_size(8, 8) fn occlusion(@builtin(global_invocation_id) id: vec3u) {
  if !valid(id.xy, textureDimensions(scalar)) { return; }
  let p = vec2i(id.xy);
  let nd = load(a, p);
  if nd.w <= 0.0 { textureStore(scalar, p, vec4f(1.0)); return; }
  let screen = uv(id.xy, textureDimensions(scalar));
  let centre = viewPosition(screen, nd.w);
  var v = vec3f(0.0, 0.0, 1.0);
  let perspective = abs(params.inverseProjection[2][3]) > 0.00001;
  if perspective { v = normalize(-centre); }
  let n = normalize(nd.xyz);
  let radius = max(params.settings.x, 0.001);
  let size = vec2f(textureDimensions(a));
  let projectionScale = 1.0 / max(abs(params.inverseProjection[1][1]), 0.001);
  var pixelRadius = radius * projectionScale * size.y * 0.5;
  if perspective { pixelRadius /= nd.w; }
  pixelRadius = clamp(pixelRadius, 2.0, 96.0);
  let noise = fract(dot(vec2f(p), vec2f(0.06711056, 0.00583715)) * 52.9829189 + params.settings.z * 0.61803399);
  var visibility = 0.0;
  for (var slice = 0u; slice < 4u; slice++) {
    let angle = (f32(slice) + noise) * 3.141592654 / 4.0;
    let axis = vec2f(cos(angle), sin(angle));
    let slicePlane = normalize(cross(vec3f(axis.x, -axis.y, 0.0), v));
    let tangent = normalize(cross(v, slicePlane));
    let projectedN = n - slicePlane * dot(n, slicePlane);
    let lengthN = max(length(projectedN), 0.0001);
    let normalAngle = atan2(dot(projectedN, tangent), dot(projectedN, v));
    var horizons = vec2f(cos(normalAngle + 1.570796327), cos(normalAngle - 1.570796327));
    for (var step = 1u; step <= 6u; step++) {
      let distance = max(1.0, pow((f32(step) - noise * 0.5) / 6.0, 2.0) * pixelRadius);
      for (var side = 0u; side < 2u; side++) {
        var sign = 1.0;
        if side == 1u { sign = -1.0; }
        let sampleP = p + vec2i(round(axis * distance * sign));
        if any(sampleP < vec2i(0)) || any(sampleP >= vec2i(size)) { continue; }
        let sampleND = load(a, sampleP);
        if sampleND.w <= 0.0 { continue; }
        let sampleScreen = (vec2f(sampleP) + 0.5) / size;
        let delta = viewPosition(sampleScreen, sampleND.w) - centre;
        let distance3 = length(delta);
        let fade = clamp(1.0 - distance3 * distance3 / (radius * radius), 0.0, 1.0);
        let horizon = dot(delta / max(distance3, 0.0001), v);
        horizons[side] = max(horizons[side], mix(horizons[side], horizon, fade));
      }
    }
    let h0 = normalAngle + clamp(-acos(clamp(horizons.y, -1.0, 1.0)) - normalAngle, -1.570796327, 1.570796327);
    let h1 = normalAngle + clamp(acos(clamp(horizons.x, -1.0, 1.0)) - normalAngle, -1.570796327, 1.570796327);
    let integral = (2.0 * cos(normalAngle) + 2.0 * (h0 + h1) * sin(normalAngle) - cos(2.0 * h0 - normalAngle) - cos(2.0 * h1 - normalAngle)) * 0.25;
    visibility += lengthN * integral;
  }
  textureStore(scalar, p, vec4f(pow(clamp(visibility * 0.25, 0.0, 1.0), max(params.settings.y, 0.001)), 0.0, 0.0, 1.0));
}
@compute @workgroup_size(8, 8) fn denoise(@builtin(global_invocation_id) id: vec3u) {
  if !valid(id.xy, textureDimensions(scalar)) { return; }
  let p = vec2i(id.xy);
  let centre = load(b, p);
  var sum = 0.0;
  var weights = 0.0;
  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      let neighbour = load(b, p + vec2i(x, y));
      let delta = abs(neighbour.w - centre.w) / max(0.01, centre.w * 0.02);
      let normal = max(dot(neighbour.xyz, centre.xyz), 0.0);
      let weight = exp(-f32(x * x + y * y) * 0.25 - delta * delta) * pow(normal, 8.0);
      sum += load(a, p + vec2i(x, y)).r * weight;
      weights += weight;
    }
  }
  var value = load(a, p).r;
  if weights > 0.0001 { value = sum / weights; }
  textureStore(scalar, p, vec4f(value, 0.0, 0.0, 1.0));
}
@compute @workgroup_size(8, 8) fn combine(@builtin(global_invocation_id) id: vec3u) {
  if !valid(id.xy, textureDimensions(output)) { return; }
  let p = vec2i(id.xy);
  let visibility = mix(1.0, load(c, p).r, clamp(params.settings.x, 0.0, 1.0));
  textureStore(output, p, vec4f(hdr(load(a, p).rgb + load(b, p).rgb * visibility), 1.0));
}
fn tent(source: texture_2d<f32>, screen: vec2f, radius: f32) -> vec3f {
  let pixel = radius / vec2f(textureDimensions(source));
  var value = textureSampleLevel(source, linearSampler, screen, 0.0).rgb * 4.0;
  value += textureSampleLevel(source, linearSampler, screen + vec2f(pixel.x, 0.0), 0.0).rgb * 2.0;
  value += textureSampleLevel(source, linearSampler, screen - vec2f(pixel.x, 0.0), 0.0).rgb * 2.0;
  value += textureSampleLevel(source, linearSampler, screen + vec2f(0.0, pixel.y), 0.0).rgb * 2.0;
  value += textureSampleLevel(source, linearSampler, screen - vec2f(0.0, pixel.y), 0.0).rgb * 2.0;
  value += textureSampleLevel(source, linearSampler, screen + pixel, 0.0).rgb;
  value += textureSampleLevel(source, linearSampler, screen - pixel, 0.0).rgb;
  value += textureSampleLevel(source, linearSampler, screen + vec2f(pixel.x, -pixel.y), 0.0).rgb;
  value += textureSampleLevel(source, linearSampler, screen + vec2f(-pixel.x, pixel.y), 0.0).rgb;
  return value / 16.0;
}
@compute @workgroup_size(8, 8) fn threshold(@builtin(global_invocation_id) id: vec3u) {
  if !valid(id.xy, textureDimensions(output)) { return; }
  let value = hdr(tent(a, uv(id.xy, textureDimensions(output)), 1.0));
  let brightness = max(max(value.r, value.g), value.b) * exp2(clamp(params.settings.z, -24.0, 24.0));
  let knee = max(params.settings.y, 0.00001);
  let soft = clamp(brightness - params.settings.x + knee, 0.0, 2.0 * knee);
  let contribution = max(brightness - params.settings.x, soft * soft / (4.0 * knee)) / max(brightness, 0.00001);
  textureStore(output, vec2i(id.xy), vec4f(hdr(value * max(contribution, 0.0)), 1.0));
}
@compute @workgroup_size(8, 8) fn downsample(@builtin(global_invocation_id) id: vec3u) {
  if !valid(id.xy, textureDimensions(output)) { return; }
  textureStore(output, vec2i(id.xy), vec4f(hdr(tent(a, uv(id.xy, textureDimensions(output)), 1.0)), 1.0));
}
@compute @workgroup_size(8, 8) fn upsample(@builtin(global_invocation_id) id: vec3u) {
  if !valid(id.xy, textureDimensions(output)) { return; }
  let screen = uv(id.xy, textureDimensions(output));
  textureStore(output, vec2i(id.xy), vec4f(hdr((textureSampleLevel(a, linearSampler, screen, 0.0).rgb + tent(b, screen, 1.0)) * 0.5), 1.0));
}
@compute @workgroup_size(8, 8) fn temporal(@builtin(global_invocation_id) id: vec3u) {
  if !valid(id.xy, textureDimensions(output)) { return; }
  let p = vec2i(id.xy);
  let current = load(a, p);
  let previousUV = uv(id.xy, textureDimensions(output)) - load(b, p).xy;
  var blend = clamp(params.settings.x, 0.0, 0.98);
  if params.settings.y > 0.5 || any(previousUV <= vec2f(0.0)) || any(previousUV >= vec2f(1.0)) { blend = 0.0; }
  var depth = load(b, p).z;
  if depth <= 0.0 { depth = load(d, p).w; }
  let oldDepth = load(e, vec2i(previousUV * vec2f(textureDimensions(e)))).r;
  if abs(depth - oldDepth) > max(0.01, depth * params.settings.z) { blend = 0.0; }
  var low = current.rgb;
  var high = current.rgb;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let neighbour = load(a, p + vec2i(x, y)).rgb;
      low = min(low, neighbour);
      high = max(high, neighbour);
    }
  }
  let history = clamp(textureSampleLevel(c, linearSampler, previousUV, 0.0).rgb, low, high);
  textureStore(output, p, vec4f(hdr(mix(current.rgb, history, blend)), 1.0));
}

@compute @workgroup_size(8, 8) fn depth(@builtin(global_invocation_id) id: vec3u) {
  if !valid(id.xy, textureDimensions(scalar)) { return; }
  textureStore(scalar, vec2i(id.xy), vec4f(load(a, vec2i(id.xy)).w, 0.0, 0.0, 1.0));
}
