//! Asset and shader generation for the 1:1 Mini Minecraft Pen WebGPU demo
//! (matching Goose's `30_mini_minecraft.goose` atlas, shaders, and HUD).

use anyhow::Result;
use flate2::{Compression, write::ZlibEncoder};
use std::{io::Write, path::Path};

/// Encodes an RGBA8 image into a valid lossless PNG byte buffer.
pub fn encode_rgba_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>> {
    assert_eq!(rgba.len(), (width as usize) * (height as usize) * 4);
    let mut raw = Vec::with_capacity((height as usize) * (1 + (width as usize) * 4));
    let stride = (width as usize) * 4;
    for y in 0..height as usize {
        raw.push(0); // filter type 0 (None)
        raw.extend_from_slice(&rgba[y * stride..(y + 1) * stride]);
    }
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&raw)?;
    let compressed = encoder.finish()?;

    let mut out = Vec::with_capacity(compressed.len() + 64);
    out.extend_from_slice(b"\x89PNG\r\n\x1a\n");

    let write_chunk = |buf: &mut Vec<u8>, tag: &[u8; 4], data: &[u8]| {
        buf.extend_from_slice(&(data.len() as u32).to_be_bytes());
        buf.extend_from_slice(tag);
        buf.extend_from_slice(data);
        let mut hasher = crc32fast::Hasher::new();
        hasher.update(tag);
        hasher.update(data);
        buf.extend_from_slice(&hasher.finalize().to_be_bytes());
    };

    let mut ihdr = [0u8; 13];
    ihdr[0..4].copy_from_slice(&width.to_be_bytes());
    ihdr[4..8].copy_from_slice(&height.to_be_bytes());
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    ihdr[10] = 0; // deflate
    ihdr[11] = 0; // adaptive filtering
    ihdr[12] = 0; // non-interlaced
    write_chunk(&mut out, b"IHDR", &ihdr);
    write_chunk(&mut out, b"IDAT", &compressed);
    write_chunk(&mut out, b"IEND", &[]);
    Ok(out)
}

const TILE_SIZE: usize = 16;
const TILES: usize = 16;
const WHITE_TILE: usize = 14;

const TILE_COLOR: [[i32; 3]; TILES] = [
    [101, 153, 58],
    [126, 89, 55],
    [126, 89, 55],
    [129, 132, 130],
    [220, 204, 150],
    [106, 76, 43],
    [173, 137, 81],
    [65, 120, 48],
    [177, 135, 79],
    [126, 131, 133],
    [121, 126, 128],
    [52, 126, 176],
    [61, 64, 74],
    [244, 198, 94],
    [255, 255, 255],
    [255, 255, 255],
];

fn hash3(x: i32, y: i32, z: i32, seed: u32) -> u32 {
    let mut h = (x as u32)
        .wrapping_mul(374_761_393)
        .wrapping_add((y as u32).wrapping_mul(668_265_263));
    h = h
        .wrapping_add((z as u32).wrapping_mul(2_246_822_519))
        .wrapping_add(seed.wrapping_mul(3_266_489_917));
    h = (h ^ (h >> 13)).wrapping_mul(1_274_126_177);
    h ^ (h >> 16)
}

fn atlas_pixel(tile: usize, x: i32, y: i32) -> [u8; 4] {
    let mut color = TILE_COLOR[tile];
    let mut grain = (hash3(x, tile as i32, y, 71) % 27) as i32 - 13;
    if tile == 1 && y < 3 + (hash3(x / 2, 0, 0, 8) % 3) as i32 {
        color = TILE_COLOR[0];
    }
    if tile == 3 && (x + y * 3) % 11 == 0 {
        grain -= 20;
    }
    if tile == 5 {
        grain += if (x + (y / 5)) % 4 == 0 { -30 } else { 9 };
    }
    if tile == 6 {
        let ring = (x - 7).abs().max((y - 7).abs());
        grain += if ring % 3 == 0 { -30 } else { 12 };
    }
    if tile == 7 {
        grain += if hash3(x / 2, 0, y / 2, 17).is_multiple_of(3) {
            -28
        } else {
            10
        };
    }
    if tile == 8 {
        if y % 4 == 0 || (x + (y / 4) * 7) % 16 == 0 {
            grain = -42;
        } else if y % 4 == 1 {
            grain += 12;
        }
    }
    if tile == 9 {
        let row = y / 5;
        if y % 5 == 0 || (x + row * 3) % 7 == 0 {
            grain = -45;
        } else if y % 5 == 1 {
            grain = 18;
        }
    }
    if tile == 10 && hash3(x / 2, 0, y / 2, 9).is_multiple_of(5) {
        color = [32, 34, 39];
    }
    if tile == 11 {
        grain = if (x + y * 3) % 13 < 2 { 20 } else { 0 };
    }
    if tile == 12 {
        grain *= 2;
    }
    if tile == 13 {
        if !(2..=13).contains(&x) || !(2..=13).contains(&y) {
            color = [94, 66, 39];
        } else {
            grain = if x == 7 || y == 7 { 25 } else { 0 };
        }
    }
    if tile >= WHITE_TILE {
        grain = 0;
    }
    [
        (color[0] + grain).clamp(0, 255) as u8,
        (color[1] + grain).clamp(0, 255) as u8,
        (color[2] + grain).clamp(0, 255) as u8,
        255,
    ]
}

fn generate_atlas_png() -> Result<Vec<u8>> {
    let width = (TILE_SIZE * TILES) as u32;
    let height = TILE_SIZE as u32;
    let mut pixels = Vec::with_capacity((width as usize) * (height as usize) * 4);
    for y in 0..TILE_SIZE as i32 {
        for tile in 0..TILES {
            for x in 0..TILE_SIZE as i32 {
                pixels.extend_from_slice(&atlas_pixel(tile, x, y));
            }
        }
    }
    encode_rgba_png(width, height, &pixels)
}

fn generate_screen_quad_mesh_json() -> String {
    serde_json::json!({
        "positions": [
            -1.0, -1.0, 0.0,
             1.0, -1.0, 0.0,
             1.0,  1.0, 0.0,
            -1.0,  1.0, 0.0
        ],
        "normals": [
            0.0, 0.0, 1.0,
            0.0, 0.0, 1.0,
            0.0, 0.0, 1.0,
            0.0, 0.0, 1.0
        ],
        "uvs": [
            0.0, 0.0,
            1.0, 0.0,
            1.0, 1.0,
            0.0, 1.0
        ],
        "indices": [0, 1, 2, 0, 2, 3]
    })
    .to_string()
}

fn generate_chip_quad_mesh_json() -> String {
    serde_json::json!({
        "positions": [
            -0.5, -0.5, 0.0,
             0.5, -0.5, 0.0,
             0.5,  0.5, 0.0,
            -0.5,  0.5, 0.0
        ],
        "normals": [
            0.0, 0.0, 1.0,
            0.0, 0.0, 1.0,
            0.0, 0.0, 1.0,
            0.0, 0.0, 1.0
        ],
        "uvs": [
            0.0, 1.0,
            1.0, 1.0,
            1.0, 0.0,
            0.0, 0.0
        ],
        "indices": [0, 1, 2, 0, 2, 3]
    })
    .to_string()
}

const MINECRAFT_WORLD_WGSL: &str = r#"struct Scene {
  view: mat4x4f,
  projection: mat4x4f,
  ambient: vec4f,
  light_direction: vec4f,
  light_color: vec4f,
};
struct Draw {
  model: mat4x4f,
  normal: mat4x4f,
  color: vec4f,
  settings: vec4f,
  parameters: vec4f,
  extra: array<vec4f, 32>,
  surface: array<vec4f, 5>,
};
@group(0) @binding(0) var<uniform> scene: Scene;
@group(1) @binding(0) var<uniform> draw: Draw;
@group(1) @binding(1) var atlas_tex: texture_2d<f32>;
@group(1) @binding(2) var atlas_sampler: sampler;
@group(1) @binding(3) var world_field: texture_2d<f32>;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) ndc: vec2f,
};

struct FsOut {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
};

@vertex fn vertex(@location(0) position: vec3f) -> VsOut {
  var out: VsOut;
  out.pos = vec4f(position.xy, 0.5, 1.0);
  out.ndc = position.xy;
  return out;
}

fn srgb_encode(light: vec3f) -> vec3f {
  let l = max(light, vec3f(0.0));
  return select(1.055 * pow(l, vec3f(1.0 / 2.4)) - 0.055, l * 12.92, l <= vec3f(0.0031308));
}

fn block_at(c: vec3i) -> i32 {
  if (c.x < 0 || c.x >= 80 || c.y < 0 || c.y >= 40 || c.z < 0 || c.z >= 80) {
    return 0;
  }
  if (textureDimensions(world_field, 0).x < 640u) {
    return 0;
  }
  let sx = c.y % 8;
  let sy = c.y / 8;
  let v = textureLoad(world_field, vec2i(sx * 80 + c.x, sy * 80 + c.z), 0).r;
  return i32(v + 0.5);
}

fn is_solid(b: i32) -> bool {
  return b != 0 && b != 10;
}

fn sky_light_at(c: vec3i) -> f32 {
  if (c.x < 0 || c.x >= 80 || c.z < 0 || c.z >= 80) {
    return 1.0;
  }
  if (textureDimensions(world_field, 0).y < 410u) {
    return 1.0;
  }
  let idx = c.z * 80 + c.x;
  let top = i32(textureLoad(world_field, vec2i(idx % 640, 400 + idx / 640), 0).r + 0.5);
  return select(0.32, 1.0, c.y > top);
}

fn tile_for(b: i32, face: i32) -> i32 {
  if (b == 1) {
    if (face == 2) { return 0; }
    if (face == 3) { return 2; }
    return 1;
  }
  if (b == 5) {
    if (face == 2 || face == 3) { return 6; }
    return 5;
  }
  if (b == 2) { return 2; }
  if (b == 3) { return 3; }
  if (b == 4) { return 4; }
  if (b == 6) { return 7; }
  if (b == 7) { return 8; }
  if (b == 8) { return 9; }
  if (b == 9) { return 10; }
  if (b == 10) { return 11; }
  if (b == 11) { return 12; }
  if (b == 12) { return 13; }
  return 14;
}

fn corner_ao(outside: vec3i, u_axis: vec3i, v_axis: vec3i, sx: i32, sy: i32) -> f32 {
  let side_u = outside + u_axis * sx;
  let side_v = outside + v_axis * sy;
  let diag = side_u + v_axis * sy;
  let a = is_solid(block_at(side_u));
  let d = is_solid(block_at(side_v));
  let e = is_solid(block_at(diag));
  var occ = i32(a) + i32(d) + i32(e);
  if (a && d) {
    occ = 3;
  }
  return 1.0 - f32(occ) * 0.16;
}

fn render_sky(ray: vec3f, sun: vec4f, haze: vec4f, elapsed: f32, underwater: f32) -> vec3f {
  if (underwater > 0.5) {
    return vec3f(0.08, 0.28, 0.38);
  }
  let zenith = mix(vec3f(0.008, 0.015, 0.045), vec3f(0.29, 0.57, 0.79), sun.w);
  var color = mix(haze.rgb, zenith, clamp(ray.y * 1.4, 0.0, 1.0));
  let glow = pow(max(dot(ray, sun.xyz), 0.0), 32.0);
  color += vec3f(0.18, 0.14, 0.05) * glow * sun.w;
  if (ray.y > 0.0 && dot(ray, sun.xyz) > 0.9975) {
    color = vec3f(1.0, 0.95, 0.72);
  }
  if (ray.y > 0.0 && dot(ray, -sun.xyz) > 0.9985) {
    color = vec3f(0.72, 0.79, 0.9);
  }
  let star_cell = floor(ray * 220.0);
  let star = fract(sin(dot(star_cell, vec3f(12.9898, 78.233, 37.719))) * 43758.5453);
  if (ray.y > 0.12 && star > 0.9985) {
    color += vec3f(0.65) * (1.0 - sun.w);
  }
  if (ray.y > 0.08) {
    let cp = ray.xz * (30.0 / ray.y) + vec2f(elapsed * 0.22, 0.0);
    let grid = floor(cp / 5.0);
    let n = sin(grid.x * 1.7 + sin(grid.y * 2.3)) + cos(grid.y * 1.2);
    let cloud = mix(vec3f(0.09, 0.12, 0.20), vec3f(0.95, 0.96, 0.92), sun.w);
    if (n > 0.8) {
      color = mix(color, cloud, smoothstep(0.08, 0.3, ray.y));
    }
  }
  return color;
}

@fragment fn fragment(in: VsOut) -> FsOut {
  let eye_v = draw.extra[0];
  let ahead_v = draw.extra[1];
  let right_v = draw.extra[2];
  let up_v = draw.extra[3];
  let aim_target = draw.extra[4];
  let sun = draw.extra[5];
  let haze = draw.extra[6];

  let eye = eye_v.xyz;
  let elapsed = eye_v.w;
  let aspect = ahead_v.w;
  let underwater = right_v.w;

  let ray = normalize(ahead_v.xyz + right_v.xyz * (in.ndc.x * aspect) + up_v.xyz * in.ndc.y);

  // Intersect ray with finite world AABB [0, 0, 0]..[80, 40, 80].
  let inv_dir = vec3f(
    select(1.0 / ray.x, 1e8, abs(ray.x) < 1e-6),
    select(1.0 / ray.y, 1e8, abs(ray.y) < 1e-6),
    select(1.0 / ray.z, 1e8, abs(ray.z) < 1e-6),
  );
  let t0 = (vec3f(0.0, 0.0, 0.0) - eye) * inv_dir;
  let t1 = (vec3f(80.0, 40.0, 80.0) - eye) * inv_dir;
  let tmin_v = min(t0, t1);
  let tmax_v = max(t0, t1);
  let t_enter = max(max(tmin_v.x, tmin_v.y), tmin_v.z);
  let t_exit = min(min(tmax_v.x, tmax_v.y), tmax_v.z);

  var hit_found = false;
  var hit_cell = vec3i(0, 0, 0);
  var hit_block = 0;
  var hit_face = 2;
  var hit_t = 0.0;

  if (t_exit >= max(t_enter, 0.0)) {
    let entered_outside = t_enter > 0.0;
    let start_t = select(0.0, t_enter + 0.0005, entered_outside);
    let start_p = eye + ray * start_t;
    var cell = clamp(vec3i(floor(start_p)), vec3i(0, 0, 0), vec3i(79, 39, 79));
    let step_i = vec3i(
      select(-1, 1, ray.x >= 0.0),
      select(-1, 1, ray.y >= 0.0),
      select(-1, 1, ray.z >= 0.0),
    );
    let delta = abs(inv_dir);
    var t_max = vec3f(
      select((start_p.x - f32(cell.x)) * delta.x, (f32(cell.x + 1) - start_p.x) * delta.x, step_i.x > 0),
      select((start_p.y - f32(cell.y)) * delta.y, (f32(cell.y + 1) - start_p.y) * delta.y, step_i.y > 0),
      select((start_p.z - f32(cell.z)) * delta.z, (f32(cell.z + 1) - start_p.z) * delta.z, step_i.z > 0),
    );
    var face = 2;
    if (entered_outside) {
      if (tmin_v.x >= tmin_v.y && tmin_v.x >= tmin_v.z) {
        face = select(0, 1, ray.x > 0.0);
      } else if (tmin_v.y >= tmin_v.z) {
        face = select(2, 3, ray.y > 0.0);
      } else {
        face = select(4, 5, ray.z > 0.0);
      }
    }
    var t_cur = start_t;
    let skip_water = underwater > 0.5;
    for (var s = 0; s < 220; s++) {
      if (cell.x < 0 || cell.x >= 80 || cell.y < 0 || cell.y >= 40 || cell.z < 0 || cell.z >= 80) {
        break;
      }
      let b = block_at(cell);
      let hit_now = select(b != 0, b != 0 && b != 10, skip_water);
      if (hit_now && (s > 0 || entered_outside)) {
        hit_found = true;
        hit_cell = cell;
        hit_block = b;
        hit_face = face;
        hit_t = t_cur;
        break;
      }
      if (t_max.x <= t_max.y && t_max.x <= t_max.z) {
        t_cur = start_t + t_max.x;
        t_max.x += delta.x;
        cell.x += step_i.x;
        face = select(0, 1, step_i.x > 0);
      } else if (t_max.y <= t_max.z) {
        t_cur = start_t + t_max.y;
        t_max.y += delta.y;
        cell.y += step_i.y;
        face = select(2, 3, step_i.y > 0);
      } else {
        t_cur = start_t + t_max.z;
        t_max.z += delta.z;
        cell.z += step_i.z;
        face = select(4, 5, step_i.z > 0);
      }
    }
  }

  var out: FsOut;
  if (!hit_found) {
    let sky_rgb = render_sky(ray, sun, haze, elapsed, underwater);
    let far_clip = scene.projection * scene.view * vec4f(eye + ray * 149.0, 1.0);
    out.color = vec4f(sky_rgb, 1.0);
    out.depth = clamp(far_clip.z / far_clip.w, 0.0001, 0.9999);
    return out;
  }

  var n_axis = vec3i(0, 1, 0);
  var u_axis = vec3i(1, 0, 0);
  var v_axis = vec3i(0, 0, -1);
  if (hit_face == 0) {
    n_axis = vec3i(1, 0, 0); u_axis = vec3i(0, 0, -1); v_axis = vec3i(0, 1, 0);
  } else if (hit_face == 1) {
    n_axis = vec3i(-1, 0, 0); u_axis = vec3i(0, 0, 1); v_axis = vec3i(0, 1, 0);
  } else if (hit_face == 2) {
    n_axis = vec3i(0, 1, 0); u_axis = vec3i(1, 0, 0); v_axis = vec3i(0, 0, -1);
  } else if (hit_face == 3) {
    n_axis = vec3i(0, -1, 0); u_axis = vec3i(1, 0, 0); v_axis = vec3i(0, 0, 1);
  } else if (hit_face == 4) {
    n_axis = vec3i(0, 0, 1); u_axis = vec3i(1, 0, 0); v_axis = vec3i(0, 1, 0);
  } else {
    n_axis = vec3i(0, 0, -1); u_axis = vec3i(-1, 0, 0); v_axis = vec3i(0, 1, 0);
  }

  let nf = vec3f(n_axis);
  let uf = vec3f(u_axis);
  let vf = vec3f(v_axis);
  let raw_world = eye + ray * hit_t;
  let cell_f = vec3f(hit_cell);
  // Snap the face plane coordinate cleanly onto the exact block boundary.
  let plane_val = cell_f + max(nf, vec3f(0.0));
  let world = select(clamp(raw_world, cell_f, cell_f + vec3f(1.0)), plane_val, abs(nf) > vec3f(0.5));

  let rel = world - (cell_f + vec3f(0.5));
  let cu = clamp(dot(rel, uf), -0.5, 0.5);
  let cv = clamp(dot(rel, vf), -0.5, 0.5);
  let u01 = cu + 0.5;
  let v01 = 0.5 - cv;

  let tile = tile_for(hit_block, hit_face);
  let tx = clamp(i32(floor(u01 * 16.0)), 0, 15);
  let ty = clamp(i32(floor(v01 * 16.0)), 0, 15);
  var base = srgb_encode(textureLoad(atlas_tex, vec2i(tile * 16 + tx, ty), 0).rgb);

  let outside = hit_cell + n_axis;
  let sky = sky_light_at(outside);
  let ao00 = corner_ao(outside, u_axis, v_axis, -1, -1);
  let ao10 = corner_ao(outside, u_axis, v_axis, 1, -1);
  let ao11 = corner_ao(outside, u_axis, v_axis, 1, 1);
  let ao01 = corner_ao(outside, u_axis, v_axis, -1, 1);
  let sv = cv + 0.5;
  let shade = sky * mix(mix(ao00, ao10, u01), mix(ao01, ao11, u01), sv);

  let direct = max(dot(nf, sun.xyz), 0.0) * sun.w;
  var light = mix(vec3f(0.10, 0.14, 0.23), vec3f(0.64, 0.73, 0.82) * 0.48, sun.w);
  light += vec3f(0.66, 0.59, 0.43) * direct;
  light *= shade;

  for (var i = 0; i < 16; i++) {
    let lp = draw.extra[7 + i];
    if (lp.w > 0.0) {
      let d = length(lp.xyz - world);
      let glow = max(0.0, 1.0 - d / 7.0);
      light += vec3f(1.0, 0.63, 0.25) * glow * glow * lp.w;
    }
  }
  if (hit_block == 12) {
    light = max(light, vec3f(1.1, 0.96, 0.7));
  }
  if (hit_block == 10) {
    let wave = sin(world.x * 2.7 + elapsed) * sin(world.z * 3.1 - elapsed);
    base += vec3f(0.04, 0.07, 0.08) * wave;
    light = max(light, vec3f(mix(0.15, 0.72, sun.w)));
  }

  var color = base * light;
  let targeted = all(abs(cell_f - aim_target.xyz) < vec3f(0.1));
  if (aim_target.w >= 0.0 && targeted) {
    let edge_u = min(u01, 1.0 - u01);
    let edge_v = min(v01, 1.0 - v01);
    if (min(edge_u, edge_v) < 0.018) {
      color = vec3f(1.0, 0.91, 0.57);
    }
    let crack = abs(fract(world * 5.0 + sin(world.zxy * 13.0) * 0.2) - 0.5);
    if (aim_target.w > 0.0 && min(crack.x + crack.y, crack.y + crack.z) < aim_target.w * 0.18) {
      color *= 0.28;
    }
  }

  let dist = length(eye - world);
  var fog = smoothstep(34.0, 83.0, dist);
  if (haze.w > 0.5) {
    fog = 1.0 - exp(-dist * 0.17);
  }
  let clip = scene.projection * scene.view * vec4f(world, 1.0);
  out.color = vec4f(mix(color, haze.rgb, fog), 1.0);
  out.depth = clamp(clip.z / clip.w, 0.0001, 0.9999);
  return out;
}
"#;

const MINECRAFT_CHIP_WGSL: &str = r#"struct Scene {
  view: mat4x4f,
  projection: mat4x4f,
  ambient: vec4f,
  light_direction: vec4f,
  light_color: vec4f,
  light_view_projection: mat4x4f,
  shadow: vec4f,
  zenith: vec4f,
  horizon: vec4f,
  ground: vec4f,
  eye: vec4f,
};
struct Draw {
  model: mat4x4f,
  normal: mat4x4f,
  color: vec4f,
  settings: vec4f,
  parameters: vec4f,
  extra: array<vec4f, 32>,
  surface: array<vec4f, 5>,
};
@group(0) @binding(0) var<uniform> scene: Scene;
@group(1) @binding(0) var<uniform> draw: Draw;
@group(1) @binding(1) var atlas_tex: texture_2d<f32>;
@group(1) @binding(2) var atlas_sampler: sampler;

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) uv: vec2f,
  @location(2) params: vec4f,
};

fn build_out(model: mat4x4f, position: vec3f, uv: vec2f, params: vec4f) -> Out {
  let w = model * vec4f(position, 1.0);
  return Out(scene.projection * scene.view * w, w.xyz, uv, params);
}

@vertex fn vertex(@location(0) position: vec3f, @location(2) uv: vec2f) -> Out {
  return build_out(draw.model, position, uv, draw.parameters);
}

@vertex fn vertex_instanced(
  @location(0) position: vec3f,
  @location(2) uv: vec2f,
  @location(3) m0: vec4f,
  @location(4) m1: vec4f,
  @location(5) m2: vec4f,
  @location(6) m3: vec4f,
  @location(7) params: vec4f,
) -> Out {
  let model = mat4x4f(m0, m1, m2, m3);
  return build_out(model, position, uv, params);
}

fn srgb_encode(light: vec3f) -> vec3f {
  let l = max(light, vec3f(0.0));
  return select(1.055 * pow(l, vec3f(1.0 / 2.4)) - 0.055, l * 12.92, l <= vec3f(0.0031308));
}

@fragment fn fragment(in: Out) -> @location(0) vec4f {
  let tile = clamp(i32(in.params.x + 0.5), 0, 15);
  let shade = in.params.y;
  let day = clamp(scene.light_color.x, 0.0, 1.0);
  let u = 0.5 + (in.uv.x - 0.5) * 0.25;
  let v = 0.5 + (in.uv.y - 0.5) * 0.25;
  let tx = clamp(i32(floor(u * 16.0)), 0, 15);
  let ty = clamp(i32(floor(v * 16.0)), 0, 15);
  let base = srgb_encode(textureLoad(atlas_tex, vec2i(tile * 16 + tx, ty), 0).rgb);
  var light = mix(vec3f(0.10, 0.14, 0.23), vec3f(0.64, 0.73, 0.82) * 0.48, day);
  light += vec3f(0.66, 0.59, 0.43) * 0.5 * day;
  light *= shade;
  let color = base * light;
  let dist = length(scene.eye.xyz - in.world);
  let fog = smoothstep(34.0, 83.0, dist);
  return vec4f(mix(color, scene.horizon.rgb, fog), 1.0);
}
"#;

const MINECRAFT_HUD_WGSL: &str = r#"@group(0) @binding(0) var<uniform> screen: vec4f;
struct SpriteData {
  rect: vec4f,
  uv: vec4f,
  color: vec4f,
  parameters: vec4f,
};
@group(0) @binding(1) var<storage, read> sprites: array<SpriteData>;
@group(0) @binding(2) var atlas: texture_2d<f32>;
@group(0) @binding(3) var atlas_sampler: sampler;

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) params: vec4f,
};

@vertex fn vertex(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Out {
  let corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let s = sprites[i];
  let c = corners[v];
  let px = s.rect.xy + c * s.rect.zw;
  let ndc = vec2f(px.x / max(screen.x, 1.0) * 2.0 - 1.0, 1.0 - px.y / max(screen.y, 1.0) * 2.0);
  let uv = mix(s.uv.xy, s.uv.zw, c);
  return Out(vec4f(ndc, 0.0, 1.0), uv, s.color, s.parameters);
}

fn srgb_encode(light: vec3f) -> vec3f {
  let l = max(light, vec3f(0.0));
  return select(1.055 * pow(l, vec3f(1.0 / 2.4)) - 0.055, l * 12.92, l <= vec3f(0.0031308));
}

@fragment fn fragment(in: Out) -> @location(0) vec4f {
  if (in.params.x < 0.5) {
    return in.color;
  }
  let dims = vec2i(textureDimensions(atlas, 0));
  let coord = clamp(vec2i(floor(in.uv * vec2f(dims))), vec2i(0, 0), dims - vec2i(1, 1));
  let texel = textureLoad(atlas, coord, 0);
  return vec4f(srgb_encode(texel.rgb) * in.color.rgb, texel.a * in.color.a);
}
"#;

pub fn write_mini_minecraft_assets(assets_dir: &Path) -> Result<()> {
    std::fs::write(assets_dir.join("atlas.png"), generate_atlas_png()?)?;
    std::fs::write(
        assets_dir.join("screen_quad.mesh.json"),
        generate_screen_quad_mesh_json(),
    )?;
    std::fs::write(
        assets_dir.join("chip_quad.mesh.json"),
        generate_chip_quad_mesh_json(),
    )?;
    std::fs::write(
        assets_dir.join("minecraft_world.wgsl"),
        MINECRAFT_WORLD_WGSL,
    )?;
    std::fs::write(assets_dir.join("minecraft_chip.wgsl"), MINECRAFT_CHIP_WGSL)?;
    std::fs::write(assets_dir.join("minecraft_hud.wgsl"), MINECRAFT_HUD_WGSL)?;

    let world_mat = serde_json::json!({
        "shader": "minecraft_world.wgsl",
        "texture": "atlas.png",
        "color": [1.0, 1.0, 1.0, 1.0],
        "lighting": "unlit",
        "shadow": false
    });
    let chip_mat = serde_json::json!({
        "shader": "minecraft_chip.wgsl",
        "texture": "atlas.png",
        "color": [1.0, 1.0, 1.0, 1.0],
        "lighting": "unlit",
        "shadow": false
    });
    let hud_mat = serde_json::json!({
        "shader": "minecraft_hud.wgsl",
        "texture": "atlas.png",
        "color": [1.0, 1.0, 1.0, 1.0],
        "lighting": "unlit",
        "blend": true
    });
    std::fs::write(
        assets_dir.join("world.material.json"),
        world_mat.to_string() + "\n",
    )?;
    std::fs::write(
        assets_dir.join("chip.material.json"),
        chip_mat.to_string() + "\n",
    )?;
    std::fs::write(
        assets_dir.join("hud.material.json"),
        hud_mat.to_string() + "\n",
    )?;

    let catalog = serde_json::json!({
        "meshes": ["screen_quad.mesh.json", "chip_quad.mesh.json"],
        "materials": ["world.material.json", "chip.material.json", "hud.material.json"],
        "sounds": []
    });
    std::fs::write(
        assets_dir.join("catalog.json"),
        serde_json::to_string_pretty(&catalog)? + "\n",
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atlas_png_has_exact_header_and_white_tile() {
        let png = generate_atlas_png().unwrap();
        assert_eq!(&png[0..8], b"\x89PNG\r\n\x1a\n");
        let w = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
        let h = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
        assert_eq!((w, h), (256, 16));
        assert_eq!(atlas_pixel(WHITE_TILE, 7, 7), [255, 255, 255, 255]);
        let lamp_frame = atlas_pixel(13, 0, 0);
        assert!(lamp_frame[0] > lamp_frame[1] && lamp_frame[1] > lamp_frame[2]);
    }

    #[test]
    fn mini_minecraft_blot_gameplay_suite_passes() {
        let mut fx = crate::Fixture::new("examples/mini_minecraft.blot");
        let out = fx.floats("test_mini_minecraft", ());
        assert_eq!(out, vec![1.0, 0.0], "mini_minecraft gameplay tests failed");
    }
}
