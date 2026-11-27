//! The color grade and exposure maths: Ink's Squid (`color.grade`, `color.lut_lookup`,
//! the metering and adaptation functions) against independent f64 references, and
//! against Pen's present-pass WGSL (`grade.wgsl`) run on a real offscreen device.
use crate::*;
use wgpu::util::DeviceExt;

const LUMA: [f64; 3] = [0.2126, 0.7152, 0.0722];

fn cc_low() -> f64 {
    (-16.0 + 9.72) / 17.52
}
fn cc_high() -> f64 {
    (65504f64.log2() + 9.72) / 17.52
}
fn cc_encode(x: f64) -> f64 {
    if x <= 0.0 {
        cc_low()
    } else if x < 2f64.powi(-15) {
        ((2f64.powi(-16) + x * 0.5).log2() + 9.72) / 17.52
    } else {
        (x.log2() + 9.72) / 17.52
    }
}
fn cc_decode(v: f64) -> f64 {
    if v < (9.72 - 15.0) / 17.52 {
        ((2f64.powf(v * 17.52 - 9.72) - 2f64.powi(-16)) * 2.0).max(0.0)
    } else {
        2f64.powf(v * 17.52 - 9.72).min(65504.0)
    }
}

/// A grade's twenty lanes, as `tests/color_grade.sq` reads them.
#[derive(Clone, Copy, Debug)]
struct Grade {
    temperature: f64,
    tint: f64,
    exposure: f64,
    contrast: f64,
    pivot: f64,
    saturation: f64,
    vibrance: f64,
    lift: [f64; 3],
    gamma: [f64; 3],
    gain: [f64; 3],
    vignette: f64,
    radius: f64,
    blend: f64,
    weight: f64,
}
const NEUTRAL: Grade = Grade {
    temperature: 0.0,
    tint: 0.0,
    exposure: 0.0,
    contrast: 1.0,
    pivot: 0.18,
    saturation: 1.0,
    vibrance: 0.0,
    lift: [0.0; 3],
    gamma: [1.0; 3],
    gain: [1.0; 3],
    vignette: 0.0,
    radius: 0.5,
    blend: 0.0,
    weight: 1.0,
};
impl Grade {
    fn lanes(&self) -> Vec<f64> {
        let mut out = vec![
            self.temperature,
            self.tint,
            self.exposure,
            self.contrast,
            self.pivot,
            self.saturation,
            self.vibrance,
        ];
        out.extend(self.lift);
        out.extend(self.gamma);
        out.extend(self.gain);
        out.extend([self.vignette, self.radius, self.blend, self.weight]);
        out
    }
}

/// A table of `size` slices, texel (r, g, b) at ((g * size + b) * size + r).
#[derive(Clone)]
struct Table {
    size: usize,
    texels: Vec<[f64; 3]>,
}
impl Table {
    fn lookup(&self, v: [f64; 3]) -> [f64; 3] {
        let top = (self.size - 1) as f64;
        let p = v.map(|x| x.clamp(0.0, 1.0) * top);
        let low = p.map(|x| (x.floor() as usize).min(self.size - 1));
        let high = low.map(|x| (x + 1).min(self.size - 1));
        let f = [0, 1, 2].map(|i| p[i] - p[i].floor());
        let at = |r: usize, g: usize, b: usize| self.texels[(g * self.size + b) * self.size + r];
        let mut out = [0.0; 3];
        for corner in 0..8 {
            let pick = |bit: usize| (corner >> bit) & 1 == 1;
            let (r, wr) = if pick(0) {
                (high[0], f[0])
            } else {
                (low[0], 1.0 - f[0])
            };
            let (g, wg) = if pick(1) {
                (high[1], f[1])
            } else {
                (low[1], 1.0 - f[1])
            };
            let (b, wb) = if pick(2) {
                (high[2], f[2])
            } else {
                (low[2], 1.0 - f[2])
            };
            let texel = at(r, g, b);
            for c in 0..3 {
                out[c] += texel[c] * wr * wg * wb;
            }
        }
        out
    }
    fn lanes(&self) -> Vec<f64> {
        self.texels.iter().flatten().copied().collect()
    }
}

fn vignette(strength: f64, radius: f64, u: f64, v: f64) -> f64 {
    let d = ((u - 0.5).powi(2) + (v - 0.5).powi(2)).sqrt() * 2f64.sqrt();
    let edge = radius.min(0.999);
    let t = ((d - edge) / (1.0 - edge)).clamp(0.0, 1.0);
    1.0 - strength * t * t * (3.0 - 2.0 * t)
}

fn grade(g: &Grade, tables: [Option<&Table>; 2], light: [f64; 3], u: f64, v: f64) -> [f64; 3] {
    let factor = vignette(g.vignette, g.radius, u, v);
    let stops = [
        0.5 * g.temperature + 0.25 * g.tint,
        -0.5 * g.tint,
        -0.5 * g.temperature + 0.25 * g.tint,
    ];
    let pivot = cc_encode(g.pivot);
    let mut c = [0.0; 3];
    for i in 0..3 {
        let x = light[i].max(0.0) * factor * 2f64.powf(stops[i] + g.exposure);
        let x = cc_decode(((cc_encode(x) - pivot) * g.contrast + pivot).clamp(cc_low(), cc_high()));
        c[i] = (x * g.gain[i] + g.lift[i]).max(0.0).powf(1.0 / g.gamma[i]);
    }
    let y: f64 = (0..3).map(|i| c[i] * LUMA[i]).sum();
    let high = c[0].max(c[1]).max(c[2]);
    let low = c[0].min(c[1]).min(c[2]);
    let chroma = if high > 1e-6 {
        (high - low) / high
    } else {
        0.0
    };
    let weight = if g.vibrance > 0.0 {
        1.0 - chroma
    } else {
        chroma
    };
    let k = g.saturation * (1.0 + g.vibrance * weight);
    for x in &mut c {
        *x = (*x * k + y * (1.0 - k)).max(0.0);
    }
    if let (Some(first), true) = (tables[0], g.weight > 0.0) {
        let encoded = c.map(cc_encode);
        let inside = encoded.map(|x| x.clamp(0.0, 1.0));
        let mut looked = first.lookup(inside);
        if let Some(second) = tables[1] {
            let other = second.lookup(inside);
            for i in 0..3 {
                looked[i] += (other[i] - looked[i]) * g.blend;
            }
        }
        for i in 0..3 {
            c[i] = cc_decode(encoded[i] + (looked[i] - inside[i]) * g.weight);
        }
    }
    c
}

fn settings() -> Vec<Grade> {
    let n = NEUTRAL;
    vec![
        n,
        Grade {
            temperature: 0.7,
            ..n
        },
        Grade {
            temperature: -1.0,
            tint: 0.4,
            ..n
        },
        Grade {
            tint: -0.8,
            exposure: 1.5,
            ..n
        },
        Grade {
            exposure: -3.0,
            contrast: 1.6,
            ..n
        },
        Grade {
            contrast: 0.4,
            pivot: 0.5,
            ..n
        },
        Grade {
            saturation: 0.0,
            ..n
        },
        Grade {
            saturation: 2.5,
            vibrance: 0.8,
            ..n
        },
        Grade {
            vibrance: -0.9,
            ..n
        },
        Grade {
            lift: [0.05, -0.02, 0.1],
            gamma: [0.6, 1.0, 2.2],
            ..n
        },
        Grade {
            gain: [1.4, 0.8, 2.0],
            vignette: 0.7,
            radius: 0.3,
            ..n
        },
        Grade {
            temperature: 0.3,
            tint: -0.2,
            exposure: 0.5,
            contrast: 1.2,
            pivot: 0.3,
            saturation: 1.3,
            vibrance: 0.4,
            lift: [0.01, 0.02, -0.01],
            gamma: [1.1, 0.9, 1.3],
            gain: [1.1, 0.95, 1.2],
            vignette: 0.4,
            radius: 0.5,
            ..n
        },
    ]
}

/// Light spread over the stops that matter, channels within three stops of each other.
fn samples(count: usize, seed: u32) -> Vec<([f64; 3], [f64; 2])> {
    let mut random = Random(seed);
    let mut unit = move || f64::from(random.word() >> 8) / f64::from(1u32 << 24);
    let mut out = vec![
        ([0.0; 3], [0.5, 0.5]),
        ([1.0; 3], [0.0, 0.0]),
        ([0.18; 3], [1.0, 1.0]),
        ([1e-6, 1e-4, 1e-3], [0.25, 0.75]),
        ([60000.0, 3.0, 0.0], [0.9, 0.1]),
    ];
    while out.len() < count {
        let base = 2f64.powf(unit() * 22.0 - 14.0);
        let mut channel = || base * 2f64.powf(unit() * 6.0 - 3.0);
        let light = [channel(), channel(), channel()];
        out.push((light, [unit(), unit()]));
    }
    out
}

fn close(got: &[f64], want: &[f64], relative: f64, absolute: f64) -> bool {
    let brightest = want.iter().fold(0.0f64, |most, w| most.max(w.abs()));
    got.iter()
        .zip(want)
        .all(|(g, w)| (g - w).abs() <= relative * w.abs() + absolute + 4e-7 * brightest)
}

fn scrambled(size: usize, seed: u32, quantize: bool) -> Table {
    let mut random = Random(seed);
    let texels = (0..size * size * size)
        .map(|_| {
            [(); 3].map(|()| {
                let v = f64::from(random.word() >> 8) / f64::from(1u32 << 24);
                if quantize {
                    (v * 255.0).round() / 255.0
                } else {
                    f32(v)
                }
            })
        })
        .collect();
    Table { size, texels }
}

fn identity(size: usize) -> Table {
    let level = |i: usize| f32(i as f64 / (size - 1) as f64);
    let mut texels = vec![[0.0; 3]; size * size * size];
    for g in 0..size {
        for b in 0..size {
            for r in 0..size {
                texels[(g * size + b) * size + r] = [level(r), level(g), level(b)];
            }
        }
    }
    Table { size, texels }
}

fn grade_input(g: &Grade, light: [f64; 3], uv: [f64; 2]) -> Vec<f64> {
    let mut a = g.lanes();
    a.extend(light);
    a.extend(uv);
    a
}

#[test]
fn the_log_encoding_the_vignette_and_the_identity_grade() {
    let mut f = Fixture::new("tests/color_grade.sq");
    for x in [
        0.0, 1e-9, 1e-5, 3e-5, 0.001, 0.18, 1.0, 16.0, 223.0, 65504.0,
    ] {
        let r = f.floats("encoded", [x, 0.0, 0.0, 0.0]);
        near(r[0], f32(cc_encode(x)), 1e-6);
        let v = cc_encode(x);
        let back = f.floats("encoded", [v, 0.0, 0.0, 0.0]);
        // The curve's published values: middle grey encodes to 0.4135884.
        if x == 0.18 {
            near(r[0], 0.4135884, 2e-6);
        }
        assert!(
            (back[1] - x).abs() <= 2e-5 * x.abs() + 1e-9,
            "{x} -> {v} -> {}",
            back[1]
        );
    }
    for (strength, radius, u, v) in [
        (0.6, 0.5, 0.5, 0.5),
        (0.6, 0.5, 0.0, 1.0),
        (0.3, 0.2, 0.9, 0.4),
        (1.0, 1.0, 0.0, 0.0),
    ] {
        let r = f.floats("encoded", [strength, radius, u, v]);
        near(r[2], f32(vignette(strength, radius, u, v)), 1e-6);
    }
    // Nothing set changes nothing, to float error, and black stays black.
    for (light, uv) in samples(400, 5) {
        let r = f.floats("graded", grade_input(&NEUTRAL, light, uv));
        assert!(close(&r[..3], &light, 1e-4, 1e-7), "{light:?} became {r:?}");
        assert_eq!(r[3], 1.0);
    }
}

#[test]
fn the_squid_grade_matches_the_f64_reference_for_every_setting() {
    let mut f = Fixture::new("tests/color_grade.sq");
    let samples = samples(120, 9);
    for g in settings() {
        for (light, uv) in &samples {
            let r = f.floats("graded", grade_input(&g, *light, *uv));
            let want = grade(&g, [None, None], *light, uv[0], uv[1]);
            assert!(
                close(&r[..3], &want, 6e-4, 2e-6),
                "{g:?} on {light:?}: {r:?} vs {want:?}"
            );
        }
    }
}

#[test]
fn table_lookups_blends_and_weights_match_the_reference() {
    let mut f = Fixture::new("tests/color_grade.sq");
    for (size, seed) in [(2usize, 3u32), (5, 5), (9, 7), (16, 9)] {
        let table = scrambled(size, seed, false);
        let mut random = Random(seed * 77);
        let mut unit = move || f64::from(random.word() >> 8) / f64::from(1u32 << 24);
        let mut points = vec![
            [0.0; 3],
            [1.0; 3],
            [0.5; 3],
            [-0.3, 1.7, 0.5],
            [1.0 / (size - 1) as f64; 3],
        ];
        points.extend((0..60).map(|_| [unit(), unit(), unit()]));
        for v in points {
            let r = f.floats(
                "lookup",
                [v.to_vec(), vec![size as f64], table.lanes()].concat(),
            );
            near_all(&r, &table.lookup(v), 2e-6);
        }
    }
    let (a, b) = (scrambled(6, 31, true), scrambled(6, 37, true));
    let grade_lanes = |g: &Grade, light: [f64; 3], uv: [f64; 2], second: bool| {
        let mut input = grade_input(g, light, uv);
        input.extend([6.0, if second { 1.0 } else { 0.0 }]);
        input.extend(a.lanes());
        input.extend(b.lanes());
        input
    };
    let base = Grade {
        saturation: 1.2,
        temperature: 0.1,
        ..NEUTRAL
    };
    for (blend, weight) in [
        (0.0, 1.0),
        (1.0, 1.0),
        (0.5, 1.0),
        (0.3, 0.6),
        (0.7, 0.0),
        (0.5, 0.25),
    ] {
        let g = Grade {
            blend,
            weight,
            ..base
        };
        for (light, uv) in samples(30, 41) {
            let r = f.floats("tabled", grade_lanes(&g, light, uv, true));
            let want = grade(&g, [Some(&a), Some(&b)], light, uv[0], uv[1]);
            assert!(
                close(&r[..3], &want, 6e-4, 2e-6),
                "blend {blend} weight {weight}: {r:?} vs {want:?}"
            );
            // Without the second table the first stands alone, whatever the blend.
            let alone = f.floats("tabled", grade_lanes(&g, light, uv, false));
            let want = grade(&g, [Some(&a), None], light, uv[0], uv[1]);
            assert!(
                close(&alone[..3], &want, 6e-4, 2e-6),
                "alone: {alone:?} vs {want:?}"
            );
        }
    }
    // The identity table agrees with no table, to its own steps.
    let table = identity(8);
    for (light, uv) in samples(60, 43) {
        let mut input = grade_input(&NEUTRAL, light, uv);
        input.extend([8.0, 0.0]);
        input.extend(table.lanes());
        input.extend(table.lanes());
        let r = f.floats("tabled", input);
        assert!(close(&r[..3], &light, 2e-3, 1e-6), "{light:?}: {r:?}");
    }
}

#[test]
fn metering_and_adaptation_follow_the_reference() {
    let mut f = Fixture::new("tests/color_grade.sq");
    let bin = |low: f64, high: f64, light: f64| {
        (((light.log2() - low) * 256.0 / (high - low)).clamp(0.0, 255.0)) as u32
    };
    for light in [0.0, 1e-9, 0.001, 0.18, 1.0, 4.0, 60.0, 1e9] {
        let got = f.words("bin", [-10.0, 6.0, light]);
        let want = if light > 0.0 {
            bin(-10.0, 6.0, f32(light))
        } else {
            0
        };
        // The same bin, or a neighbour when the luminance sits on a bin's edge in f32.
        assert!(got[0].abs_diff(want) <= 1, "{light}: {got:?} vs {want}");
    }
    // A bimodal histogram: a dark mode and a bright one.
    let mut bins = vec![0.0; 256];
    bins[40] = 400.0;
    bins[200] = 600.0;
    let reference = |from: f64, to: f64| {
        let total: f64 = bins.iter().sum();
        let (mut seen, mut weight, mut logs) = (0.0, 0.0, 0.0);
        for (i, &count) in bins.iter().enumerate() {
            let before = seen / total;
            seen += count;
            let inside = (f64::min(seen / total, to) - f64::max(before, from)).max(0.0);
            weight += inside;
            logs += inside * (-10.0 + (i as f64 + 0.5) * 16.0 / 256.0);
        }
        logs / weight
    };
    for (from, to) in [
        (0.0, 1.0),
        (0.1, 0.9),
        (0.05, 0.35),
        (0.4, 0.6),
        (0.45, 0.99),
    ] {
        let r = f.floats(
            "average",
            [vec![256.0, -10.0, 6.0, from, to], bins.clone()].concat(),
        );
        assert_eq!(r[0], 1.0);
        near(r[1], reference(from, to), 1e-4);
    }
    // An empty histogram meters nothing.
    let r = f.floats(
        "average",
        [vec![256.0, -10.0, 6.0, 0.1, 0.9], vec![0.0; 256]].concat(),
    );
    assert_eq!(r[0], 0.0);
    // The goal brings the average to middle grey, plus compensation, within the limits.
    for (average, compensation) in [(-5.0, 0.0), (-2.4739, 0.0), (3.0, 0.5), (-9.0, -1.0)] {
        let r = f.floats(
            "goal",
            [
                average,
                0.18,
                compensation,
                -6.0,
                6.0,
                0.0,
                0.0,
                3.0,
                1.0,
                0.1,
            ],
        );
        near(
            r[0],
            (0.18f64.log2() - average + compensation).clamp(-6.0, 6.0),
            1e-5,
        );
    }
    // Adaptation closes 1 - exp(-rate * dt) of the distance at the rate of its direction,
    // and splitting a second into any number of frames lands in the same place.
    for (current, target, rate_up, rate_down) in [(-3.0, 2.0, 3.0, 1.0), (4.0, -1.0, 3.0, 1.0)] {
        let rate = if target > current { rate_up } else { rate_down };
        for frames in [1u32, 4, 20, 60] {
            let dt = 1.0 / f64::from(frames);
            let mut stops = current;
            for _ in 0..frames {
                stops = f.floats(
                    "goal",
                    [
                        0.0, 0.18, 0.0, -6.0, 6.0, stops, target, rate_up, rate_down, dt,
                    ],
                )[1];
            }
            let want = target + (current - target) * (-rate).exp();
            near(stops, want, 2e-4);
        }
    }
    // The limits hold it, and no time holds it.
    let r = f.floats(
        "goal",
        [0.0, 0.18, 0.0, -6.0, 6.0, 5.9, 9.0, 3.0, 1.0, 100.0],
    );
    near(r[1], 6.0, 1e-5);
    let r = f.floats(
        "goal",
        [0.0, 0.18, 0.0, -6.0, 6.0, 1.25, 4.0, 3.0, 1.0, 0.0],
    );
    near(r[1], 1.25, 1e-6);
}

// ------------------------------------------------------------------ the GPU

struct Gpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
}

/// Pen's shader source, from its sibling checkout (or the one `PEN_CHECKOUT` names).
fn pen_shader(name: &str) -> String {
    let checkout =
        std::env::var_os("PEN_CHECKOUT").map_or_else(|| root().join("../pen"), PathBuf::from);
    let path = checkout.join("crates/pen-render/src/shaders").join(name);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("Pen's {name} is read from its sibling checkout: {path:?}"))
}

const HARNESS: &str = "
@group(0) @binding(0) var<uniform> g: Grade;
@group(0) @binding(1) var<storage, read> inputs: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> outputs: array<vec4f>;
@group(0) @binding(3) var lut_a: texture_2d<f32>;
@group(0) @binding(4) var lut_b: texture_2d<f32>;
@compute @workgroup_size(64) fn run(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&inputs) / 2u) { return; }
  let a = inputs[2u * i];
  let b = inputs[2u * i + 1u];
  outputs[i] = vec4f(grade_apply(g, lut_a, lut_b, a.xyz, vec2f(a.w, b.x)), 0.0);
}";

impl Gpu {
    fn new() -> Option<Gpu> {
        let instance =
            wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let adapter = pollster::block_on(instance.request_adapter(&Default::default())).ok()?;
        let (device, queue) =
            pollster::block_on(adapter.request_device(&Default::default())).ok()?;
        Some(Gpu { device, queue })
    }

    fn strip(&self, table: &Table) -> wgpu::TextureView {
        let size = table.size as u32;
        // The strip's texel (b * size + r, g) is the table's ((g * size + b) * size + r).
        let bytes: Vec<u8> = table
            .texels
            .iter()
            .flat_map(|t| [t[0], t[1], t[2], 1.0].map(|v| (v * 255.0).round() as u8))
            .collect();
        self.device
            .create_texture_with_data(
                &self.queue,
                &wgpu::TextureDescriptor {
                    label: None,
                    size: wgpu::Extent3d {
                        width: size * size,
                        height: size,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                },
                wgpu::util::TextureDataOrder::LayerMajor,
                &bytes,
            )
            .create_view(&Default::default())
    }

    /// The WGSL grade's answers for `samples`, with `g` and the tables (the
    /// uniform's layout is `grade.wgsl`'s `Grade`).
    fn run(
        &self,
        g: &Grade,
        tables: [Option<&Table>; 2],
        samples: &[([f64; 3], [f64; 2])],
    ) -> Vec<[f64; 3]> {
        let code = format!(
            "{}\n{}\n{HARNESS}",
            pen_shader("transfer.wgsl"),
            pen_shader("grade.wgsl")
        );
        let module = self
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: None,
                source: wgpu::ShaderSource::Wgsl(code.into()),
            });
        let pipeline = self
            .device
            .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: None,
                layout: None,
                module: &module,
                entry_point: Some("run"),
                compilation_options: Default::default(),
                cache: None,
            });
        let blank = Table {
            size: 2,
            texels: vec![[0.0; 3]; 8],
        };
        let views =
            [tables[0].unwrap_or(&blank), tables[1].unwrap_or(&blank)].map(|t| self.strip(t));
        let size = |t: Option<&Table>| t.map_or(0.0, |t| t.size as f32);
        let uniform: Vec<f32> = [
            [g.temperature, g.tint, g.exposure, g.contrast],
            [g.pivot, g.saturation, g.vibrance, g.weight],
            [g.lift[0], g.lift[1], g.lift[2], 0.0],
            [g.gamma[0], g.gamma[1], g.gamma[2], 0.0],
            [g.gain[0], g.gain[1], g.gain[2], 0.0],
            [
                f64::from(size(tables[0])),
                f64::from(size(tables[1])),
                g.blend,
                1.0,
            ],
            [g.vignette, g.radius, 0.0, 0.0],
        ]
        .iter()
        .flatten()
        .map(|&v| v as f32)
        .collect();
        let inputs: Vec<f32> = samples
            .iter()
            .flat_map(|(l, uv)| {
                [
                    l[0] as f32,
                    l[1] as f32,
                    l[2] as f32,
                    uv[0] as f32,
                    uv[1] as f32,
                    0.0,
                    0.0,
                    0.0,
                ]
            })
            .collect();
        let buffer = |contents: &[u8], usage| {
            self.device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: None,
                    contents,
                    usage,
                })
        };
        let parameters = buffer(bytemuck::cast_slice(&uniform), wgpu::BufferUsages::UNIFORM);
        let input = buffer(bytemuck::cast_slice(&inputs), wgpu::BufferUsages::STORAGE);
        let bytes = (samples.len() * 16) as u64;
        let output = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let read = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: bytes,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: parameters.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: input.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: output.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&views[0]),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::TextureView(&views[1]),
                },
            ],
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(samples.len().div_ceil(64) as u32, 1, 1);
        }
        encoder.copy_buffer_to_buffer(&output, 0, &read, 0, bytes);
        self.queue.submit([encoder.finish()]);
        read.slice(..)
            .map_async(wgpu::MapMode::Read, |result| result.unwrap());
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .unwrap();
        let mapped = read.slice(..).get_mapped_range().unwrap();
        let floats: &[f32] = bytemuck::cast_slice(&mapped);
        floats
            .chunks(4)
            .map(|t| [f64::from(t[0]), f64::from(t[1]), f64::from(t[2])])
            .collect()
    }
}

#[test]
fn pens_grade_shader_matches_the_squid_grade() {
    let Some(gpu) = Gpu::new() else {
        eprintln!("no GPU adapter; skipping");
        return;
    };
    let mut f = Fixture::new("tests/color_grade.sq");
    let samples = samples(150, 51);
    for g in settings() {
        let shaded = gpu.run(&g, [None, None], &samples);
        for ((light, uv), shaded) in samples.iter().zip(&shaded) {
            let r = f.floats("graded", grade_input(&g, *light, *uv));
            assert!(
                close(&r[..3], shaded, 8e-4, 3e-6),
                "{g:?} on {light:?}: Squid {r:?}, WGSL {shaded:?}"
            );
        }
    }
    // Through two tables, blended and weighed (8-bit texels, as the strip holds them).
    let (a, b) = (scrambled(6, 61, true), scrambled(6, 67, true));
    for (blend, weight) in [(0.0, 1.0), (1.0, 1.0), (0.4, 0.7)] {
        let g = Grade {
            blend,
            weight,
            saturation: 1.1,
            ..NEUTRAL
        };
        let shaded = gpu.run(&g, [Some(&a), Some(&b)], &samples[..60]);
        for ((light, uv), shaded) in samples.iter().zip(&shaded) {
            let mut input = grade_input(&g, *light, *uv);
            input.extend([6.0, 1.0]);
            input.extend(a.lanes());
            input.extend(b.lanes());
            let r = f.floats("tabled", input);
            assert!(
                close(&r[..3], shaded, 8e-4, 3e-6),
                "blend {blend} weight {weight}: Squid {r:?}, WGSL {shaded:?}"
            );
        }
    }
}

fn srgb_encode_ref(l: f64) -> f64 {
    let l = l.max(0.0);
    if l <= 0.003_130_8 {
        l * 12.92
    } else {
        1.055 * l.powf(1.0 / 2.4) - 0.055
    }
}

fn srgb_decode_ref(c: f64) -> f64 {
    let c = c.max(0.0);
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn tonemap_linear_ref(linear: [f64; 3], mode: u32, peak_linear: f64) -> [f64; 3] {
    let peak = peak_linear.max(1.0);
    let v = linear.map(|c| c.max(0.0));
    if mode == 0 {
        let peak_enc = if peak > 1.001 {
            srgb_encode_ref(peak)
        } else {
            1.0
        };
        let shoulder = peak_enc * 0.9;
        let d = (peak_enc - shoulder).max(0.0001);
        return v.map(|c| {
            let e = srgb_encode_ref(c);
            let rolled = if e > shoulder {
                peak_enc - d * d / (e + d - shoulder)
            } else {
                e
            };
            srgb_decode_ref(rolled)
        });
    }
    let s = v.map(|c| c / peak);
    let mapped = match mode {
        1 => {
            let c0 = 0.842_479_062_253_094 * s[0]
                + 0.078_433_599_999_999_2 * s[1]
                + 0.079_223_745_147_764_3 * s[2];
            let c1 = 0.042_328_242_261_012_3 * s[0]
                + 0.878_468_636_469_772 * s[1]
                + 0.079_166_127_460_543_4 * s[2];
            let c2 =
                0.042_375_654_905_705_1 * s[0] + 0.078_433_6 * s[1] + 0.879_142_973_793_104 * s[2];
            let poly = |x: f64| {
                let t = ((x.max(1e-10).log2() + 12.47393) / (4.026069 + 12.47393)).clamp(0.0, 1.0);
                let t2 = t * t;
                let t4 = t2 * t2;
                15.5 * t4 * t2 - 40.14 * t4 * t + 31.96 * t4 - 6.868 * t2 * t
                    + 0.4298 * t2
                    + 0.1191 * t
                    - 0.00232
            };
            let p = [poly(c0), poly(c1), poly(c2)];
            let luma = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
            let q = p.map(|ch| luma + (ch.max(0.0).powf(1.15) - luma) * 1.15);
            let o0 = (1.196_879_005_120_17 * q[0]
                - 0.098_020_881_140_136_8 * q[1]
                - 0.099_029_744_079_720_5 * q[2])
                .clamp(0.0, 1.0);
            let o1 = (-0.052_896_851_757_456_2 * q[0] + 1.151_903_129_904_17 * q[1]
                - 0.098_961_176_844_843_3 * q[2])
                .clamp(0.0, 1.0);
            let o2 = (-0.052_971_635_514_443_8 * q[0] - 0.098_043_450_117_124_1 * q[1]
                + 1.151_073_672_641_16 * q[2])
                .clamp(0.0, 1.0);
            [
                srgb_decode_ref(o0),
                srgb_decode_ref(o1),
                srgb_decode_ref(o2),
            ]
        }
        2 => {
            let x0 = 0.59719 * s[0] + 0.35458 * s[1] + 0.04823 * s[2];
            let x1 = 0.07600 * s[0] + 0.90834 * s[1] + 0.01566 * s[2];
            let x2 = 0.02840 * s[0] + 0.13383 * s[1] + 0.83777 * s[2];
            let rrt = |x: f64| {
                (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.4329510) + 0.238081)
            };
            let y = [rrt(x0), rrt(x1), rrt(x2)];
            [
                (1.60475 * y[0] - 0.53108 * y[1] - 0.07367 * y[2]).clamp(0.0, 1.0),
                (-0.10208 * y[0] + 1.10813 * y[1] - 0.00605 * y[2]).clamp(0.0, 1.0),
                (-0.00327 * y[0] - 0.07276 * y[1] + 1.07602 * y[2]).clamp(0.0, 1.0),
            ]
        }
        _ => {
            let start = 0.76;
            let desat = 0.15;
            let x = s[0].min(s[1]).min(s[2]);
            let offset = if x < 0.08 { x - 6.25 * x * x } else { 0.04 };
            let mut c = s.map(|ch| ch - offset);
            let p = c[0].max(c[1]).max(c[2]);
            if p >= start {
                let d = 1.0 - start;
                let new_peak = 1.0 - d * d / (p + d - start);
                for ch in &mut c {
                    *ch *= new_peak / p;
                }
                let g = 1.0 - 1.0 / (desat * (p - new_peak) + 1.0);
                c = c.map(|ch| ch * (1.0 - g) + new_peak * g);
            }
            c
        }
    };
    mapped.map(|ch| ch * peak)
}

#[test]
fn filmic_tonemap_operators_match_f64_reference_and_hdr_headroom() {
    let mut f = Fixture::new("tests/color_grade.sq");
    let inputs = [
        [0.0, 0.0, 0.0],
        [0.02, 0.05, 0.09],
        [0.18, 0.18, 0.18],
        [0.85, 0.35, 0.12],
        [2.5, 0.4, 0.1],
        [12.0, 4.5, 1.2],
        [-0.2, 0.5, 8.0],
    ];
    for mode in 0u32..=3 {
        for peak in [1.0, 4.0] {
            for rgb in inputs {
                let got = f.floats("tonemap", [mode as f64, peak, rgb[0], rgb[1], rgb[2], 0.75]);
                let want = tonemap_linear_ref(rgb, mode, peak);
                assert_eq!(got[3], 0.75);
                assert!(
                    close(&got[..3], &want, 4e-4, 2e-5),
                    "mode {mode} peak {peak} rgb {rgb:?}: got {:?}, want {want:?}",
                    &got[..3]
                );
            }
        }
    }
}
