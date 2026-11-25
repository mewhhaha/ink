// Independent references for ink/render/probes: analytic ray-box casts in f64 against
// the closed room of tests/probes.blot, with the sky's SH from quadrature.
use crate::render_math::{basis, dot, sky_radiance, sphere};
use crate::*;
use std::f64::consts::PI;

const SKY: [[f64; 3]; 3] = [[0.1, 0.2, 0.5], [0.5, 0.6, 0.8], [0.1, 0.08, 0.05]];
const AMBIENT: [f64; 3] = [0.3, 0.32, 0.4];
const SUN: [f64; 3] = [1.0, 0.9, 0.8];
const REACH: f64 = 60.0;

// Box centres and full sizes with their ids, as tests/probes.blot's room.
const ROOM: [([f64; 3], [f64; 3], u32); 6] = [
    ([0., -3.5, 0.], [8., 1., 8.], 1),
    ([0., 3.5, 0.], [8., 1., 8.], 2),
    ([-3.5, 0., 0.], [1., 8., 8.], 3),
    ([0., 0., -3.5], [8., 8., 1.], 4),
    ([0., 0., 3.5], [8., 8., 1.], 6),
    ([3.5, 0., 0.], [1., 8., 8.], 5),
];

fn sun_direction() -> [f64; 3] {
    let v = [0.3, -1., 0.2];
    let n = dot(&v, &v).sqrt();
    v.map(|x| x / n)
}
// The SH of the sky scaled to a flat ambient, as `environment.diffuse`.
fn sky_light() -> ([f64; 3], [[f64; 3]; 9]) {
    static CACHE: std::sync::OnceLock<([f64; 3], [[f64; 3]; 9])> = std::sync::OnceLock::new();
    *CACHE.get_or_init(sky_light_uncached)
}
fn sky_light_uncached() -> ([f64; 3], [[f64; 3]; 9]) {
    let mut sums = [[0.; 3]; 9];
    let mut mean = [0.; 3];
    sphere(720, 1440, |d, weight| {
        let terms = basis(&d);
        let radiance = sky_radiance(&SKY, &d);
        for c in 0..3 {
            mean[c] += radiance[c] * weight / (4. * PI);
            for (i, term) in terms.iter().enumerate() {
                let kernel = if i == 0 {
                    PI
                } else if i <= 3 {
                    2. * PI / 3.
                } else {
                    PI / 4.
                };
                sums[i][c] += radiance[c] * term * weight * kernel / PI;
            }
        }
    });
    let tint: [f64; 3] = std::array::from_fn(|c| AMBIENT[c] / mean[c]);
    for row in sums.iter_mut() {
        for c in 0..3 {
            row[c] *= tint[c];
        }
    }
    (tint, sums)
}
fn evaluate(coefficients: &[[f64; 3]; 9], n: &[f64; 3]) -> [f64; 3] {
    let terms = basis(n);
    std::array::from_fn(|c| {
        (0..9)
            .map(|i| coefficients[i][c] * terms[i])
            .sum::<f64>()
            .max(0.)
    })
}
// The nearest box a ray enters: distance, outward normal and id.
fn cast(
    o: &[f64; 3],
    d: &[f64; 3],
    boxes: &[([f64; 3], [f64; 3], u32)],
) -> Option<(f64, [f64; 3], u32)> {
    let mut best: Option<(f64, [f64; 3], u32)> = None;
    for (center, size, id) in boxes {
        let (mut near, mut far, mut axis, mut sign) = (f64::NEG_INFINITY, f64::INFINITY, 0, 1.);
        let mut miss = false;
        for a in 0..3 {
            let low = center[a] - size[a] / 2.;
            let high = center[a] + size[a] / 2.;
            if d[a].abs() < 1e-12 {
                if o[a] < low || o[a] > high {
                    miss = true;
                }
                continue;
            }
            let (t0, t1) = ((low - o[a]) / d[a], (high - o[a]) / d[a]);
            let (enter, leave, s) = if t0 < t1 { (t0, t1, -1.) } else { (t1, t0, 1.) };
            if enter > near {
                near = enter;
                axis = a;
                sign = s;
            }
            far = far.min(leave);
        }
        if miss || near > far || near < 1e-6 || near > REACH {
            continue;
        }
        if best.is_none_or(|b| near < b.0) {
            let mut n = [0.; 3];
            n[axis] = sign;
            best = Some((near, n, *id));
        }
    }
    best
}
fn albedo(id: u32) -> [f64; 3] {
    if id == 5 {
        [0.8, 0.1, 0.1]
    } else {
        [0.6, 0.6, 0.6]
    }
}
fn inside(p: &[f64; 3], boxes: &[([f64; 3], [f64; 3], u32)]) -> bool {
    boxes
        .iter()
        .any(|(c, s, _)| (0..3).all(|a| (p[a] - c[a]).abs() < s[a] / 2.))
}

// One probe's nine terms, over pi, from `rays` Fibonacci rays; None if inside.
fn bake(
    p: [f64; 3],
    rays: usize,
    boxes: &[([f64; 3], [f64; 3], u32)],
    previous: Option<&dyn Fn(&[f64; 3], &[f64; 3]) -> [f64; 3]>,
) -> (Option<[[f64; 3]; 9]>, usize) {
    if inside(&p, boxes) {
        return (None, 0);
    }
    let (tint, ambient) = sky_light();
    let sun = sun_direction();
    let to_sun = sun.map(|x| -x);
    let mut sums = [[0.; 3]; 9];
    let mut escaped = 0;
    for i in 0..rays {
        let y = 1. - 2. * (i as f64 + 0.5) / rays as f64;
        let ring = (1. - y * y).max(0.).sqrt();
        let phi = i as f64 * 2.3999632297;
        let d = [ring * phi.cos(), y, ring * phi.sin()];
        let radiance: [f64; 3] = match cast(&p, &d, boxes) {
            None => {
                escaped += 1;
                let s = sky_radiance(&SKY, &d);
                std::array::from_fn(|c| s[c] * tint[c])
            }
            Some((t, n, id)) => {
                let point: [f64; 3] = std::array::from_fn(|a| p[a] + d[a] * t);
                let facing = dot(&n, &to_sun).max(0.);
                let start: [f64; 3] = std::array::from_fn(|a| point[a] + n[a] * 0.05);
                let direct = if facing > 0. && cast(&start, &to_sun, boxes).is_none() {
                    facing
                } else {
                    0.
                };
                let bounce = previous.map_or_else(|| evaluate(&ambient, &n), |f| f(&point, &n));
                let a = albedo(id);
                std::array::from_fn(|c| a[c] * (SUN[c] * direct + bounce[c]))
            }
        };
        let terms = basis(&d);
        let weight = 4. * PI / rays as f64;
        for k in 0..9 {
            let kernel = if k == 0 {
                PI
            } else if k <= 3 {
                2. * PI / 3.
            } else {
                PI / 4.
            };
            for c in 0..3 {
                sums[k][c] += radiance[c] * terms[k] * weight * kernel / PI;
            }
        }
    }
    (Some(sums), escaped)
}

fn lattice(mode: u32) -> ([f64; 3], f64, [usize; 3]) {
    if mode == 2 {
        ([1., 0., 0.], 2.5, [3, 1, 1])
    } else {
        ([-2., -2., -2.], 2., [3, 3, 3])
    }
}
fn lattice_points(mode: u32) -> Vec<[f64; 3]> {
    let (o, s, n) = lattice(mode);
    let mut out = vec![];
    for z in 0..n[2] {
        for y in 0..n[1] {
            for x in 0..n[0] {
                out.push([
                    o[0] + x as f64 * s,
                    o[1] + y as f64 * s,
                    o[2] + z as f64 * s,
                ]);
            }
        }
    }
    out
}
fn input(mode: f64, rays: f64, bounces: f64, queries: &[[f64; 7]]) -> Vec<f64> {
    [vec![mode, rays, bounces], queries.concat()].concat()
}

#[test]
fn open_sky_probes_equal_the_sky_light_and_a_closed_room_never_sees_it() {
    let mut f = Fixture::new("tests/probes.blot");
    let (_, sky) = sky_light();
    let terms = f.floats("sky_terms", vec![0.]);
    for i in 0..9 {
        near_all(&terms[i * 3..i * 3 + 3], &sky[i], 0.01 * sky[0][2]);
    }
    // Open sky: every probe is the sky's own light, to the quadrature error.
    let r = f.floats("bake", input(0., 256., 1., &[]));
    let scale = sky.iter().flatten().fold(0f64, |m, v| m.max(v.abs()));
    for probe in 0..27 {
        let base = probe * 28;
        assert_eq!(r[base + 27], 1.);
        for i in 0..9 {
            near_all(&r[base + i * 3..base + i * 3 + 3], &sky[i], 0.02 * scale);
        }
    }
    // The closed room: no ray escapes in the reference, and the bake agrees
    // with it probe by probe.
    let r = f.floats("bake", input(1., 128., 1., &[]));
    let points = lattice_points(1);
    let mut room_scale = 0f64;
    for (probe, p) in points.iter().enumerate() {
        let (reference, escaped) = bake(*p, 128, &ROOM, None);
        assert_eq!(escaped, 0, "probe {probe} sees the sky");
        let reference = reference.unwrap();
        let base = probe * 28;
        assert_eq!(r[base + 27], 1.);
        room_scale = room_scale.max(reference.iter().flatten().fold(0f64, |m, v| m.max(v.abs())));
        for i in 0..9 {
            near_all(
                &r[base + i * 3..base + i * 3 + 3],
                &reference[i],
                0.03 * room_scale.max(0.1),
            );
        }
    }
    // Light stays in the room: the average is far below the open sky's.
    assert!(r[0] * 0.2820947918 < sky[0][2] * 0.2820947918 * 2.0);
    // A second bounce lights the hits with the first bake's probes instead
    // of the sky's open ambient: darker inside a closed room, and equal to a
    // reference that does the same with an independent trilinear sampler.
    let two = f.floats("bake", input(1., 128., 2., &[]));
    let first_dc: f64 = (0..27).map(|k| r[k * 28]).sum();
    let second_dc: f64 = (0..27).map(|k| two[k * 28]).sum();
    assert!(second_dc < first_dc * 0.9, "{first_dc} {second_dc}");
    let first: Vec<(Option<[[f64; 3]; 9]>, usize)> =
        points.iter().map(|p| bake(*p, 128, &ROOM, None)).collect();
    let (tint_unused, sky_ambient) = sky_light();
    let _ = tint_unused;
    let previous = |point: &[f64; 3], n: &[f64; 3]| -> [f64; 3] {
        let (light, confidence) = sample_ref(&first, &points, point, n, 0.5);
        let sky = evaluate(&sky_ambient, n);
        std::array::from_fn(|c| sky[c] + (light[c] - sky[c]) * confidence)
    };
    for (probe, p) in points.iter().enumerate() {
        let (reference, _) = bake(*p, 128, &ROOM, Some(&previous));
        let reference = reference.unwrap();
        let base = probe * 28;
        for i in 0..9 {
            near_all(
                &two[base + i * 3..base + i * 3 + 3],
                &reference[i],
                0.03 * room_scale.max(0.1),
            );
        }
    }
}

// Trilinear light at `point` for the 3 x 3 x 3 room lattice, as the Blot sampler
// weighs it (validity, facing, a cell of fade), summed independently in f64.
fn sample_ref(
    baked: &[(Option<[[f64; 3]; 9]>, usize)],
    points: &[[f64; 3]],
    position: &[f64; 3],
    normal: &[f64; 3],
    bias: f64,
) -> ([f64; 3], f64) {
    let n = {
        let l = dot(normal, normal).sqrt();
        normal.map(|x| x / l)
    };
    let (origin, spacing, count) = lattice(1);
    let g: [f64; 3] = std::array::from_fn(|a| (position[a] + n[a] * bias - origin[a]) / spacing);
    let edge = (0..3)
        .map(|a| g[a].min(count[a] as f64 - 1. - g[a]))
        .fold(f64::INFINITY, f64::min);
    let reach = (edge + 1.).clamp(0., 1.);
    if reach <= 0. {
        return ([0.; 3], 0.);
    }
    let c: [f64; 3] = std::array::from_fn(|a| g[a].clamp(0., count[a] as f64 - 1.));
    let i0: [usize; 3] = std::array::from_fn(|a| (c[a].floor() as usize).min(count[a] - 2));
    let terms = basis(&n);
    let (mut sum, mut weight, mut share, mut total) = ([0.; 3], 0., 0., 0.);
    for corner in 0..8usize {
        let d = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1];
        let tri: f64 = (0..3)
            .map(|a| {
                let f = c[a] - i0[a] as f64;
                if d[a] == 1 { f } else { 1. - f }
            })
            .product();
        if tri <= 0. {
            continue;
        }
        let at = [i0[0] + d[0], i0[1] + d[1], i0[2] + d[2]];
        let index = (at[2] * count[1] + at[1]) * count[0] + at[0];
        total += tri;
        let Some(sh) = &baked[index].0 else { continue };
        share += tri;
        let to: [f64; 3] = std::array::from_fn(|a| points[index][a] - position[a]);
        let length = dot(&to, &to).sqrt();
        let facing = if length < 1e-4 {
            1.
        } else {
            0.5 + 0.5 * dot(&to, &n) / length
        };
        let w = tri * (facing * facing).max(0.02);
        let light: [f64; 3] =
            std::array::from_fn(|ch| (0..9).map(|i| sh[i][ch] * terms[i]).sum::<f64>().max(0.));
        for ch in 0..3 {
            sum[ch] += w * light[ch];
        }
        weight += w;
    }
    if weight <= 1e-6 || total <= 0. {
        return ([0.; 3], 0.);
    }
    (
        sum.map(|v| v / weight),
        reach * reach * (3. - 2. * reach) * share / total,
    )
}

#[test]
fn probes_inside_a_wall_are_invalid_and_leave_no_darkness() {
    let mut f = Fixture::new("tests/probes.blot");
    // x = 1, 3.5 (inside the wall), 6 (outside).
    let q = |p: [f64; 3], n: [f64; 3], bias: f64| [p[0], p[1], p[2], n[0], n[1], n[2], bias];
    let r = f.floats(
        "bake",
        input(
            2.,
            128.,
            1.,
            &[
                q([3.5, 0., 0.], [-1., 0., 0.], 0.),
                q([2.25, 0., 0.], [-1., 0., 0.], 0.),
                q([1., 0., 0.], [-1., 0., 0.], 0.),
            ],
        ),
    );
    assert_eq!(r[28 + 27], 0., "the probe in the wall is invalid");
    assert!(r[28..28 + 27].iter().all(|v| *v == 0.));
    assert_eq!(r[27], 1.);
    assert_eq!(r[56 + 27], 1.);
    // At the invalid probe's centre there is nothing to give.
    let at = 84;
    assert_eq!(r[at + 3], 0., "no confidence from an invalid probe alone");
    // Halfway to the valid probe: its light only, at half confidence.
    let n = [-1., 0., 0.];
    let want = evaluate(
        &std::array::from_fn(|i| [r[i * 3], r[i * 3 + 1], r[i * 3 + 2]]),
        &n,
    );
    near_all(&r[at + 4..at + 7], &want, 1e-5);
    near(r[at + 7], 0.5, 1e-5);
    // At the valid probe's centre: exactly its own light, full confidence.
    near_all(&r[at + 8..at + 11], &want, 1e-5);
    near(r[at + 11], 1., 1e-6);
    // The probe outside the room sees the sky and the room's wall; it is valid.
    let (reference, escaped) = bake([6., 0., 0.], 128, &ROOM, None);
    assert!(escaped > 0 && reference.is_some());
}

#[test]
fn sampling_is_exact_at_probe_centres_and_follows_the_normal() {
    let mut f = Fixture::new("tests/probes.blot");
    let points = lattice_points(1);
    let normals = [[0.2f64, 0.9, 0.3], [-1., 0., 0.], [0., -0.6, 0.8]];
    let mut queries = vec![];
    for p in &points {
        for n in &normals {
            let len = dot(n, n).sqrt();
            queries.push([p[0], p[1], p[2], n[0] / len, n[1] / len, n[2] / len, 0.]);
        }
    }
    let r = f.floats("bake", input(1., 64., 1., &queries));
    let values = &r[..27 * 28];
    let samples = &r[27 * 28..];
    for (k, q) in queries.iter().enumerate() {
        let probe = k / 3;
        let coefficients: [[f64; 3]; 9] = std::array::from_fn(|i| {
            let b = probe * 28 + i * 3;
            [values[b], values[b + 1], values[b + 2]]
        });
        let want = evaluate(&coefficients, &[q[3], q[4], q[5]]);
        near_all(&samples[k * 4..k * 4 + 3], &want, 2e-6);
        near(samples[k * 4 + 3], 1., 1e-6);
    }
    // Outside the lattice by more than a cell: no confidence; just beyond
    // its edge, partial.
    let far = f.floats(
        "bake",
        input(
            1.,
            32.,
            1.,
            &[[9., 0., 0., 0., 1., 0., 0.], [-3.5, 0., 0., 0., 1., 0., 0.]],
        ),
    );
    let tail = &far[27 * 28..];
    assert_eq!(tail[3], 0.);
    assert!(tail[7] > 0. && tail[7] < 1.);
}

#[test]
fn the_probe_bench_entry_checks_itself() {
    let mut f = Fixture::new("tools/library-bench.blot");
    for n in [8., 32.] {
        let v = f.floats("probes_batch", n);
        assert_eq!((v[0], v[1]), (n, n));
        assert!(v[2] <= 1e-6, "{v:?}");
    }
}

// With INK_PROBE_DUMP=path, writes the gallery's baked probes as JSON for
// pen-render's probe_room look test (the before/after pictures).
#[test]
fn the_gallery_bakes_red_light_onto_its_floor_and_can_be_dumped() {
    let mut f = Fixture::new("tests/probes.blot");
    let r = f.floats("gallery_bake", vec![0.]);
    let values = &r[..r.len() - 27];
    assert_eq!(values.len(), 5 * 3 * 8 * 28);
    // A probe near the red wall at floor height holds more red than blue light
    // facing the wall, and one by the white wall does not.
    let eval = |probe: usize, n: [f64; 3]| {
        let terms = basis(&n);
        let b = probe * 28;
        std::array::from_fn::<f64, 3, _>(|c| {
            (0..9)
                .map(|i| values[b + i * 3 + c] * terms[i])
                .sum::<f64>()
                .max(0.)
        })
    };
    let at = |x: usize, y: usize, z: usize| (z * 3 + y) * 5 + x;
    let red = eval(at(4, 0, 2), [1., 0., 0.]);
    let white = eval(at(0, 0, 2), [-1., 0., 0.]);
    assert!(red[0] > red[2] * 1.5, "{red:?}");
    assert!(white[0] < white[2] * 1.5, "{white:?}");
    if let Ok(path) = std::env::var("INK_PROBE_DUMP") {
        let json = format!(
            "{{\"origin\":[-2.4,0.4,-2.4],\"spacing\":1.2,\"counts\":[5,3,8],\"values\":{:?},\"sky\":{:?}}}",
            values.iter().map(|v| *v as f32).collect::<Vec<_>>(),
            r[r.len() - 27..]
                .iter()
                .map(|v| *v as f32)
                .collect::<Vec<_>>()
        );
        std::fs::write(path, json).unwrap();
    }
}
