// Independent f64 references for ink/render/volumetrics and the 3D value noise it
// draws on: the hash and lattice, the exponential slicing, the global mist and
// the local volumes, the height mist's optical depth by closed form and by a
// fine sum, the phase function, a froxel's source and the front to back
// integration of a column. The same formulas Pen's froxel shaders are held to
// (crates/pen-render/src/shaders/volume_*.wgsl). Squid's arithmetic is F32 and
// blends `a + (b - a) t`; this one is f64 and blends `a (1 - t) + b t`, as
// WGSL's `mix` does, so agreement is to F32's precision and not by construction.
use crate::*;

fn f32_of(x: f64) -> f64 {
    f64::from(x as f32)
}
fn close(got: f64, want: f64, tolerance: f64) -> bool {
    (got - want).abs() <= tolerance * (1.0 + want.abs())
}

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
    /// A value an F32 holds exactly, so that both sides see the same input.
    fn between(&mut self, low: f64, high: f64) -> f64 {
        f32_of(low + (high - low) * self.next())
    }
    fn pick<T: Copy>(&mut self, options: &[T]) -> T {
        options[(self.next() * options.len() as f64) as usize % options.len()]
    }
}

// ---------------------------------------------------------------- noise

fn mixed(mut h: u32) -> u32 {
    h ^= h >> 15;
    h = h.wrapping_mul(2246822507);
    h ^= h >> 13;
    h = h.wrapping_mul(3266489909);
    h ^ (h >> 16)
}
fn hash3(x: u32, y: u32, z: u32, seed: u32) -> u32 {
    mixed(
        x.wrapping_mul(2747636419)
            ^ y.wrapping_mul(2654435769)
            ^ z.wrapping_mul(2246822519)
            ^ seed.wrapping_mul(3266489917),
    )
}
fn corner(x: u32, y: u32, z: u32, seed: u32) -> f64 {
    f64::from(hash3(x, y, z, seed) >> 8) / 16777216.0 * 2.0 - 1.0
}
fn cell(v: f64) -> u32 {
    v.floor() as i64 as u32
}
fn fade(t: f64) -> f64 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}
fn mix(a: f64, b: f64, t: f64) -> f64 {
    a * (1.0 - t) + b * t
}
fn value3(seed: u32, p: [f64; 3]) -> f64 {
    let [xi, yi, zi] = p.map(cell);
    let [u, v, w] = p.map(|c| fade(c - c.floor()));
    let c = |dx, dy, dz| {
        corner(
            xi.wrapping_add(dx),
            yi.wrapping_add(dy),
            zi.wrapping_add(dz),
            seed,
        )
    };
    let x00 = mix(c(0, 0, 0), c(1, 0, 0), u);
    let x10 = mix(c(0, 1, 0), c(1, 1, 0), u);
    let x01 = mix(c(0, 0, 1), c(1, 0, 1), u);
    let x11 = mix(c(0, 1, 1), c(1, 1, 1), u);
    mix(mix(x00, x10, v), mix(x01, x11, v), w)
}
fn fbm(seed: u32, octaves: u32, p: [f64; 3]) -> f64 {
    let (mut sum, mut total, mut amplitude, mut frequency) = (0.0, 0.0, 1.0, 1.0);
    for octave in 0..octaves {
        sum += amplitude * value3(seed + octave * 101, p.map(|c| c * frequency));
        total += amplitude;
        amplitude *= 0.5;
        frequency *= 2.0;
    }
    if total == 0.0 { 0.0 } else { sum / total }
}

fn random_point(rng: &mut Lcg, reach: f64) -> [f64; 3] {
    [
        rng.between(-reach, reach),
        rng.between(-reach, reach),
        rng.between(-reach, reach),
    ]
}

#[test]
fn value_noise_and_its_fractal_sum_match_the_f64_reference() {
    let mut f = Fixture::new("tests/volumetrics.sq");
    let mut rng = Lcg(3);
    let (mut least, mut most) = (1.0f64, -1.0f64);
    for case in 0..600 {
        let seed = rng.pick(&[0u32, 5, 77]);
        let octaves = (case % 5) as u32;
        let p = random_point(&mut rng, if case % 3 == 0 { 3.0 } else { 60.0 });
        let got = f.floats(
            "noise_at",
            vec![f64::from(seed), f64::from(octaves), p[0], p[1], p[2]],
        );
        let (value, sum) = (value3(seed, p), fbm(seed, octaves, p));
        assert!(
            close(got[0], value, 4e-6),
            "case {case}: value3 {} vs {value}",
            got[0]
        );
        assert!(
            close(got[1], sum, 4e-6),
            "case {case}: fbm {} vs {sum}",
            got[1]
        );
        assert!((-1.0..=1.0).contains(&got[0]) && (-1.0..=1.0).contains(&got[1]));
        least = least.min(got[0]);
        most = most.max(got[0]);
    }
    assert!(least < -0.9 && most > 0.9, "the noise spans its range");
    // No octaves: nothing. One octave: the value noise itself.
    assert_eq!(f.floats("noise_at", vec![0., 0., 1.5, 2.5, 3.5])[1], 0.0);
}

#[test]
fn value_noise_at_a_lattice_point_is_its_hashed_corner_and_the_wrap_is_that_of_u32() {
    let mut f = Fixture::new("tests/volumetrics.sq");
    for (seed, x, y, z) in [
        (0u32, 0i32, 0i32, 0i32),
        (7, 2, 3, 5),
        (7, -3, -1, 4),
        (9, -1, 0, -7),
        (1, 1000, -1000, 250),
        (2, -16_000, 16_000, -1),
    ] {
        let got = f.floats(
            "noise_at",
            vec![
                f64::from(seed),
                1.,
                f64::from(x),
                f64::from(y),
                f64::from(z),
            ],
        )[0];
        let want = corner(x as u32, y as u32, z as u32, seed);
        assert_eq!(got, f64::from(want as f32), "{seed} {x} {y} {z}");
    }
    // The hash itself, from an independent Python transcription, so that the
    // reference and the guest are not wrong the same way.
    assert_eq!(hash3(2, 3, 5, 7), 1259072837);
    assert_eq!(hash3(1, 1, 1, 1), 1125162249);
    assert_eq!(hash3(0, 0, 0, 0), 0);
}

#[test]
fn the_fractal_sum_has_no_mean_over_many_points() {
    let mut f = Fixture::new("tests/volumetrics.sq");
    let mut rng = Lcg(21);
    let (mut sum, mut sum_squares) = (0.0, 0.0);
    let n = 3000;
    for _ in 0..n {
        let p = random_point(&mut rng, 200.0);
        let v = f.floats("noise_at", vec![0., 3., p[0], p[1], p[2]])[1];
        assert!((-1.0..=1.0).contains(&v));
        sum += v;
        sum_squares += v * v;
    }
    let mean = sum / f64::from(n);
    let spread = (sum_squares / f64::from(n) - mean * mean).sqrt();
    assert!(mean.abs() < 0.025, "mean {mean}");
    // Three octaves of value noise vary about a quarter either way.
    assert!((0.15..0.4).contains(&spread), "spread {spread}");
}

// ---------------------------------------------------------------- slicing

const SPAN: f64 = 4.174387269895637; // ln 65

fn depth(distance: f64, slices: f64, boundary: f64) -> f64 {
    let knee = distance / 64.0;
    knee * ((boundary / slices * SPAN).exp() - 1.0)
}
fn boundary(distance: f64, slices: f64, depth: f64) -> f64 {
    let knee = distance / 64.0;
    slices * (1.0 + depth / knee).ln() / SPAN
}

#[test]
fn slicing_matches_the_f64_reference_round_trips_and_ends_at_the_reach() {
    let mut f = Fixture::new("tests/volumetrics.sq");
    let mut rng = Lcg(5);
    for case in 0..120 {
        let distance = rng.between(1.0, 600.0);
        let slices = rng.pick(&[16.0, 32.0, 64.0, 100.0]);
        let mut a = vec![distance, slices];
        a.extend([0.0, slices, slices * 0.5, slices - 1.0]);
        for _ in 0..8 {
            a.push(rng.between(0.0, slices));
        }
        let got = f.floats("slicing", a.clone());
        for (i, &b) in a[2..].iter().enumerate() {
            let want = depth(distance, slices, b);
            assert!(
                close(got[i * 2], want, 1e-5 / (1.0 + want.abs()).max(1.0) + 6e-6),
                "case {case}: depth({b}) {} vs {want}",
                got[i * 2]
            );
        }
        // The first boundary is the eye, the last the reach.
        assert_eq!(got[0], 0.0);
        assert!(close(got[2], distance, 2e-6), "{} vs {distance}", got[2]);
    }
    for case in 0..120 {
        let distance = rng.between(1.0, 600.0);
        let slices = rng.pick(&[16.0, 32.0, 64.0]);
        let mut a = vec![distance, slices];
        for _ in 0..10 {
            a.push(rng.between(0.0, distance));
        }
        let got = f.floats("slicing", a.clone());
        for (i, &d) in a[2..].iter().enumerate() {
            let want = boundary(distance, slices, d);
            assert!(
                (got[i * 2 + 1] - want).abs() < 2e-5 * slices,
                "case {case}: coordinate({d}) {} vs {want}",
                got[i * 2 + 1]
            );
        }
    }
    // Round trip, and every slice longer than the last by the same ratio.
    let (distance, slices) = (180.0, 48.0);
    let bounds: Vec<f64> = (0..=48).map(f64::from).collect();
    let mut a = vec![distance, slices];
    a.extend(&bounds);
    let got = f.floats("slicing", a);
    let depths: Vec<f64> = (0..bounds.len()).map(|i| got[i * 2]).collect();
    let ratio = (SPAN / slices).exp();
    for k in 1..depths.len() - 1 {
        let (before, after) = (depths[k] - depths[k - 1], depths[k + 1] - depths[k]);
        assert!(after > before);
        assert!(
            (after / before - ratio).abs() < 3e-4,
            "slice {k}: {}",
            after / before
        );
    }
    let mut a = vec![distance, slices];
    a.extend(&depths);
    let back = f.floats("slicing", a);
    for (i, &b) in bounds.iter().enumerate() {
        assert!(
            (back[i * 2 + 1] - b).abs() < 1e-3,
            "boundary {b}: {}",
            back[i * 2 + 1]
        );
    }
}

#[test]
fn a_slices_centre_and_length_along_a_slanted_ray_match_the_f64_reference() {
    let mut f = Fixture::new("tests/volumetrics.sq");
    let mut rng = Lcg(8);
    for case in 0..100 {
        let distance = rng.between(5.0, 400.0);
        let slices = rng.pick(&[32.0, 64.0]);
        let k = (rng.next() * slices).floor();
        let ray = [rng.between(-1.5, 1.5), rng.between(-1.0, 1.0), -1.0];
        let got = f.floats(
            "slice_of",
            vec![distance, slices, k, ray[0], ray[1], ray[2]],
        );
        let slant = (ray[0] * ray[0] + ray[1] * ray[1] + 1.0).sqrt();
        let centre = depth(distance, slices, k + 0.5);
        let length = (depth(distance, slices, k + 1.0) - depth(distance, slices, k)) * slant;
        assert!(close(got[0], centre, 6e-6), "case {case}: centre");
        assert!(
            close(got[1], length, 3e-5),
            "case {case}: length {} vs {length}",
            got[1]
        );
    }
}

// ---------------------------------------------------------------- the medium

#[derive(Clone, Copy, Debug)]
struct Fog {
    radius: f64,
    density: f64,
    height: f64,
    edge: f64,
    albedo: [f64; 3],
    noise: f64,
    scale: f64,
    drift: [f64; 3],
}
#[derive(Clone, Copy, Debug)]
struct Volume {
    shape: u32,
    centre: [f64; 3],
    extent: [f64; 3],
    density: f64,
    albedo: [f64; 3],
    emission: [f64; 3],
    falloff: f64,
}

fn smoothstep(low: f64, high: f64, x: f64) -> f64 {
    let t = ((x - low) / (high - low)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// The global mist's density at `p` and its noise factor.
fn global(fog: &Fog, octaves: u32, p: [f64; 3]) -> (f64, f64) {
    let factor = if fog.noise > 0.0 {
        let q = [0, 1, 2].map(|a| (p[a] + fog.drift[a]) / fog.scale);
        (1.0 + fog.noise * fbm(0, octaves, q)).max(0.0)
    } else {
        1.0
    };
    if fog.density <= 0.0 {
        return (0.0, factor);
    }
    let across = (p[0] * p[0] + p[2] * p[2]).sqrt();
    let mask = if fog.edge > 0.0 {
        smoothstep(fog.radius, fog.radius + fog.edge, across)
    } else if across > fog.radius {
        1.0
    } else {
        0.0
    };
    (
        fog.density * (-p[1].max(0.0) / fog.height).exp() * mask * factor,
        factor,
    )
}

fn weight(v: &Volume, p: [f64; 3]) -> f64 {
    if v.extent.iter().any(|&e| e <= 0.0) {
        return 0.0;
    }
    let d: Vec<f64> = (0..3).map(|a| (p[a] - v.centre[a]) / v.extent[a]).collect();
    let m = if v.shape == 0 {
        d.iter().fold(0.0f64, |m, c| m.max(c.abs()))
    } else {
        d.iter().map(|c| c * c).sum::<f64>().sqrt()
    };
    let t = if v.falloff > 0.0 {
        ((1.0 - m) / v.falloff).clamp(0.0, 1.0)
    } else if m < 1.0 {
        1.0
    } else {
        0.0
    };
    t * t * (3.0 - 2.0 * t)
}

/// Extinction, scattering by channel, emission by channel.
fn medium(fog: &Fog, volumes: &[Volume], octaves: u32, p: [f64; 3]) -> [f64; 7] {
    let (sigma, _) = global(fog, octaves, p);
    let mut out = [
        sigma,
        sigma * fog.albedo[0],
        sigma * fog.albedo[1],
        sigma * fog.albedo[2],
        0.0,
        0.0,
        0.0,
    ];
    for v in volumes {
        let s = v.density * weight(v, p);
        out[0] += s;
        for c in 0..3 {
            out[1 + c] += s * v.albedo[c];
            out[4 + c] += s * v.emission[c];
        }
    }
    out
}

fn pack_medium(fog: &Fog, volumes: &[Volume], octaves: u32, p: [f64; 3]) -> Vec<f64> {
    let mut a = vec![fog.radius, fog.density, fog.height, fog.edge];
    a.extend(fog.albedo);
    a.extend([fog.noise, fog.scale]);
    a.extend(fog.drift);
    a.push(f64::from(octaves));
    a.extend(p);
    a.push(volumes.len() as f64);
    for v in volumes {
        a.push(f64::from(v.shape));
        a.extend(v.centre);
        a.extend(v.extent);
        a.push(v.density);
        a.extend(v.albedo);
        a.extend(v.emission);
        a.push(v.falloff);
    }
    a
}

fn random_fog(rng: &mut Lcg) -> Fog {
    Fog {
        radius: rng.pick(&[0.0, 5.0, 20.0]),
        density: rng.pick(&[0.0, 0.02, 0.3, 1.5]),
        height: rng.between(0.5, 20.0),
        edge: rng.pick(&[0.0, 0.5, 8.0]),
        albedo: [
            rng.between(0.0, 1.0),
            rng.between(0.0, 1.0),
            rng.between(0.0, 1.0),
        ],
        noise: rng.pick(&[0.0, 0.3, 1.0]),
        scale: rng.between(1.0, 30.0),
        drift: random_point(rng, 40.0),
    }
}
fn random_volume(rng: &mut Lcg, near: [f64; 3]) -> Volume {
    let extent = [
        rng.between(0.5, 12.0),
        rng.between(0.5, 12.0),
        rng.between(0.5, 12.0),
    ];
    Volume {
        shape: rng.pick(&[0, 1]),
        centre: [0, 1, 2].map(|a| near[a] + rng.between(-1.0, 1.0) * extent[a]),
        extent,
        density: rng.between(0.0, 2.0),
        albedo: [
            rng.between(0.0, 1.0),
            rng.between(0.0, 1.0),
            rng.between(0.0, 1.0),
        ],
        emission: [
            rng.between(0.0, 3.0),
            rng.pick(&[0.0, 1.0]),
            rng.between(0.0, 1.0),
        ],
        falloff: rng.pick(&[0.0, 0.2, 0.8, 1.0]),
    }
}

#[test]
fn the_medium_matches_the_f64_reference_for_mist_noise_and_local_volumes() {
    let mut f = Fixture::new("tests/volumetrics.sq");
    let mut rng = Lcg(13);
    let (mut inside, mut noisy, mut cleared, mut soft) = (0, 0, 0, 0);
    for case in 0..500 {
        let fog = random_fog(&mut rng);
        let octaves = rng.pick(&[0u32, 2, 3]);
        let p = [
            rng.between(-40.0, 40.0),
            rng.between(-5.0, 30.0),
            rng.between(-40.0, 40.0),
        ];
        let volumes: Vec<Volume> = (0..(case % 5))
            .map(|_| random_volume(&mut rng, p))
            .collect();
        let got = f.floats("medium", pack_medium(&fog, &volumes, octaves, p));
        let want = medium(&fog, &volumes, octaves, p);
        let (density, factor) = global(&fog, octaves, p);
        for lane in 0..7 {
            assert!(
                close(got[lane], want[lane], 2e-5),
                "case {case} lane {lane}: {} vs {} ({fog:?} {volumes:?} {p:?})",
                got[lane],
                want[lane]
            );
        }
        assert!(close(got[7], density, 2e-5), "case {case}: global density");
        assert!(close(got[8], factor, 2e-5), "case {case}: noise factor");
        inside += usize::from(volumes.iter().any(|v| weight(v, p) > 0.0));
        noisy += usize::from(fog.noise > 0.0 && octaves > 0 && (factor - 1.0).abs() > 0.01);
        cleared += usize::from(fog.density > 0.0 && density == 0.0);
        soft += usize::from(volumes.iter().any(|v| {
            let w = weight(v, p);
            w > 0.0 && w < 1.0
        }));
    }
    assert!(inside > 100, "points inside volumes: {inside}");
    assert!(noisy > 60, "noisy points: {noisy}");
    assert!(cleared > 20, "points inside the radius: {cleared}");
    assert!(soft > 30, "points on a falloff: {soft}");
}

#[test]
fn a_volume_is_bounded_by_its_box_or_its_ellipsoid_and_adds_to_the_mist() {
    let mut f = Fixture::new("tests/volumetrics.sq");
    let fog = Fog {
        radius: 0.0,
        density: 0.0,
        height: 1.0,
        edge: 0.0,
        albedo: [1.0; 3],
        noise: 0.0,
        scale: 16.0,
        drift: [0.0; 3],
    };
    let base = Volume {
        shape: 0,
        centre: [2.0, 3.0, -4.0],
        extent: [1.0, 2.0, 3.0],
        density: 0.5,
        albedo: [0.25; 3],
        emission: [1.0, 2.0, 3.0],
        falloff: 0.0,
    };
    for shape in [0, 1] {
        let v = Volume { shape, ..base };
        let mut hits = 0;
        for i in -10..=10 {
            for j in -10..=10 {
                for k in -10..=10 {
                    let p = [
                        f32_of(2.0 + f64::from(i) * 0.17),
                        f32_of(3.0 + f64::from(j) * 0.37),
                        f32_of(-4.0 + f64::from(k) * 0.55),
                    ];
                    let d: Vec<f64> = (0..3).map(|a| (p[a] - v.centre[a]) / v.extent[a]).collect();
                    let (m_box, m_ball) = (
                        d.iter().fold(0.0f64, |m, c| m.max(c.abs())),
                        d.iter().map(|c| c * c).sum::<f64>().sqrt(),
                    );
                    let m = if shape == 0 { m_box } else { m_ball };
                    // Stay clear of the surface, where rounding may decide.
                    if (m - 1.0).abs() < 1e-3 {
                        continue;
                    }
                    let got = f.floats("medium", pack_medium(&fog, &[v], 0, p));
                    let inside = m < 1.0;
                    assert_eq!(got[0] > 0.0, inside, "{shape} {p:?} m {m}");
                    assert_eq!(got[0], if inside { 0.5 } else { 0.0 }, "{shape} {p:?}");
                    assert_eq!(got[6] > 0.0, inside);
                    hits += usize::from(inside);
                }
            }
        }
        assert!(hits > 500 && hits < 9261, "{shape}: {hits}");
    }
}

// ---------------------------------------------------------------- height mist

fn height_depth(density: f64, height: f64, a: [f64; 3], b: [f64; 3]) -> f64 {
    let (ya, yb) = (a[1].max(0.0), b[1].max(0.0));
    let length = (0..3).map(|c| (b[c] - a[c]).powi(2)).sum::<f64>().sqrt();
    if (yb - ya).abs() < 0.01 {
        return length * density * (-ya / height).exp();
    }
    length * density * height * ((-ya / height).exp() - (-yb / height).exp()) / (yb - ya)
}
/// The integral itself, by 200,000 midpoints.
fn height_sum(density: f64, height: f64, a: [f64; 3], b: [f64; 3]) -> f64 {
    let length = (0..3).map(|c| (b[c] - a[c]).powi(2)).sum::<f64>().sqrt();
    let steps = 200_000;
    let sum: f64 = (0..steps)
        .map(|i| {
            let y = a[1] + (b[1] - a[1]) * ((f64::from(i) + 0.5) / f64::from(steps));
            density * (-y.max(0.0) / height).exp()
        })
        .sum();
    sum * length / f64::from(steps)
}

#[test]
fn the_height_mists_optical_depth_is_its_closed_form_and_its_fine_sum() {
    let mut f = Fixture::new("tests/volumetrics.sq");
    let mut rng = Lcg(17);
    for case in 0..300 {
        let density = rng.between(0.01, 2.0);
        let height = rng.between(0.5, 30.0);
        let a = [
            rng.between(-50.0, 50.0),
            rng.between(0.0, 25.0),
            rng.between(-50.0, 50.0),
        ];
        // A third near level, whose height gain is below the flat branch's 0.01 or just above it.
        let rise = if case % 3 == 0 {
            rng.between(-0.02, 0.02)
        } else {
            rng.between(-20.0, 25.0)
        };
        let b = [
            rng.between(-50.0, 50.0),
            f32_of((a[1] + rise).max(0.0)),
            rng.between(-50.0, 50.0),
        ];
        let got = f.floats(
            "optical",
            vec![density, height, a[0], a[1], a[2], b[0], b[1], b[2]],
        )[0];
        let want = height_depth(density, height, a, b);
        // Close to level the difference of two exponentials loses digits.
        let tolerance = if (b[1] - a[1]).abs() < 0.2 {
            3e-3
        } else {
            5e-5
        };
        assert!(
            close(got, want, tolerance),
            "case {case}: {got} vs {want} ({a:?} {b:?} h {height})"
        );
        // Against the integral itself: exact when the segment stays above the
        // ground, except the flat branch's 0.01 allowance.
        let fine = height_sum(density, height, a, b);
        let allowance = if (b[1] - a[1]).abs() < 0.01 {
            0.01 / height
        } else {
            0.0
        };
        assert!(
            (want - fine).abs() <= (3e-5 + allowance) * fine.max(1e-3) + 1e-6,
            "case {case}: closed form {want} vs sum {fine}"
        );
    }
}

// ---------------------------------------------------------------- phase and light

fn phase_scaled(g: f64, c: f64) -> f64 {
    let k = g.clamp(-0.95, 0.95);
    let d = (1.0 + k * k - 2.0 * k * c).max(0.0001);
    (1.0 - k * k) / (4.0 * d.powf(1.5))
}

#[test]
fn the_phase_function_matches_the_f64_reference_and_the_normalised_one_integrates_to_one() {
    let mut f = Fixture::new("tests/volumetrics.sq");
    let mut rng = Lcg(19);
    for case in 0..300 {
        let (g, c) = (rng.between(-1.2, 1.2), rng.between(-1.0, 1.0));
        let got = f.floats("phase", vec![g, c]);
        let want = phase_scaled(g, c);
        assert!(
            close(got[0], want, 2e-5),
            "case {case}: {} vs {want}",
            got[0]
        );
        assert!(close(got[1], want / std::f64::consts::PI, 2e-5));
    }
    // Forward over back is ((1 + g) / (1 - g))^3, and g of 0 is 1/4 whatever the angle.
    for g in [-0.9, -0.5, 0.0, 0.25, 0.5, 0.9] {
        let ahead = f.floats("phase", vec![g, 1.0])[0];
        let behind = f.floats("phase", vec![g, -1.0])[0];
        let want: f64 = ((1.0 + g) / (1.0 - g)).powi(3);
        assert!(((ahead / behind) / want - 1.0).abs() < 1e-4, "{g}");
    }
    assert_eq!(f.floats("phase", vec![0.0, 0.123])[0], 0.25);
    // Over the sphere: 2 pi times the integral over the angle of p sin, midpoints.
    for g in [-0.95, -0.5, 0.0, 0.3, 0.7, 0.95] {
        let steps = 1500;
        let step = std::f64::consts::PI / f64::from(steps);
        let sum: f64 = (0..steps)
            .map(|i| {
                let angle = (f64::from(i) + 0.5) * step;
                f.floats("phase", vec![g, angle.cos()])[1] * angle.sin() * step
            })
            .sum();
        let total = 2.0 * std::f64::consts::PI * sum;
        assert!((total - 1.0).abs() < 2e-3, "g {g}: {total}");
    }
}

#[test]
fn a_froxels_source_matches_the_f64_formula() {
    let mut f = Fixture::new("tests/volumetrics.sq");
    let mut rng = Lcg(23);
    for case in 0..200 {
        let g = rng.between(-0.95, 0.95);
        let (sun_scale, ambient_scale, sky) = (
            rng.between(0.0, 2.0),
            rng.between(0.0, 2.0),
            rng.between(0.0, 1.0),
        );
        let sun = [0, 1, 2].map(|_| rng.between(0.0, 4.0));
        let (sun_cosine, sun_seen) = (rng.between(-1.0, 1.0), rng.between(0.0, 1.0));
        let mean = [0, 1, 2].map(|_| rng.between(0.0, 1.0));
        let sky_colour = [0, 1, 2].map(|_| rng.between(0.0, 1.0));
        let lamp = [0, 1, 2].map(|_| rng.between(0.0, 5.0));
        let (lamp_cosine, lamp_seen) = (rng.between(-1.0, 1.0), rng.between(0.0, 1.0));
        let extinction = rng.between(0.0, 1.0);
        let scattering = [0, 1, 2].map(|_| rng.between(0.0, 1.0));
        let emitted = [0, 1, 2].map(|_| rng.between(0.0, 1.0));
        let mut a = vec![g, sun_scale, ambient_scale, sky];
        a.extend(sun);
        a.extend([sun_cosine, sun_seen]);
        a.extend(mean);
        a.extend(sky_colour);
        a.extend(lamp);
        a.extend([lamp_cosine, lamp_seen, extinction]);
        a.extend(scattering);
        a.extend(emitted);
        let got = f.floats("lit", a);
        for c in 0..3 {
            let sun_in = sun[c] * phase_scaled(g, sun_cosine) * sun_seen * sun_scale;
            let around = (mean[c] * (1.0 - sky) + sky_colour[c] * sky) * ambient_scale;
            let lamp_in = lamp[c] * phase_scaled(g, lamp_cosine) * lamp_seen;
            let want = scattering[c] * (sun_in + around + lamp_in) + emitted[c];
            assert!(
                close(got[c], want, 3e-5),
                "case {case} lane {c}: {} vs {want}",
                got[c]
            );
        }
    }
}

// ---------------------------------------------------------------- the column

/// The cumulative light and optical depth at every boundary, front to back.
fn integrate(slices: &[([f64; 3], f64, f64)]) -> Vec<[f64; 4]> {
    let mut out = vec![[0.0; 4]];
    let (mut light, mut kept, mut tau) = ([0.0; 3], 1.0, 0.0);
    for &(source, sigma, delta) in slices {
        let keep = (-sigma * delta).exp();
        let gain = if sigma > 1e-6 {
            source.map(|s| s * (1.0 - keep) / sigma)
        } else {
            source.map(|s| s * delta)
        };
        for c in 0..3 {
            light[c] += kept * gain[c];
        }
        kept *= keep;
        tau += sigma * delta;
        out.push([light[0], light[1], light[2], tau]);
    }
    out
}

fn pack_column(slices: &[([f64; 3], f64, f64)]) -> Vec<f64> {
    let mut a = vec![slices.len() as f64];
    for &(source, sigma, delta) in slices {
        a.extend(source);
        a.extend([sigma, delta]);
    }
    a
}

fn random_slices(rng: &mut Lcg, n: usize) -> Vec<([f64; 3], f64, f64)> {
    (0..n)
        .map(|_| {
            (
                [
                    rng.between(0.0, 3.0),
                    rng.between(0.0, 3.0),
                    rng.between(0.0, 3.0),
                ],
                rng.pick(&[0.0, 1e-7, 1e-6, 5e-6, 1e-4, 1e-3, 0.05, 0.4, 3.0]),
                rng.between(0.01, 25.0),
            )
        })
        .collect()
}

#[test]
fn a_column_integrates_front_to_back_as_the_f64_reference_does() {
    let mut f = Fixture::new("tests/volumetrics.sq");
    let mut rng = Lcg(29);
    for case in 0..200 {
        let n = 1 + (case % 64);
        let slices = random_slices(&mut rng, n);
        let got = f.floats("column", pack_column(&slices));
        let want = integrate(&slices);
        assert_eq!(got.len(), (n + 1) * 4, "case {case}");
        assert_eq!(&got[..4], &[0.0; 4], "layer 0 holds nothing");
        for (k, boundary) in want.iter().enumerate() {
            for lane in 0..4 {
                assert!(
                    close(got[k * 4 + lane], boundary[lane], 2e-4),
                    "case {case} boundary {k} lane {lane}: {} vs {} ({slices:?})",
                    got[k * 4 + lane],
                    boundary[lane]
                );
            }
        }
    }
    // An empty column is its first layer.
    assert_eq!(f.floats("column", vec![0.0]), vec![0.0; 4]);
}

#[test]
fn a_medium_that_is_in_equilibrium_with_its_light_never_adds_or_loses_any() {
    // Source = extinction * L everywhere, whatever the thickness: the light
    // reaching the eye plus L attenuated by the optical depth is always L, so
    // an exact integral of a slice conserves energy however thick the slice is.
    let mut f = Fixture::new("tests/volumetrics.sq");
    let mut rng = Lcg(31);
    let light = [0.25, 0.5, 2.0];
    for case in 0..200 {
        let n = 1 + (case % 48);
        let slices: Vec<_> = random_slices(&mut rng, n)
            .into_iter()
            .map(|(_, sigma, delta)| (light.map(|l| l * sigma), sigma, delta))
            .collect();
        let got = f.floats("column", pack_column(&slices));
        let mut last_tau = 0.0;
        for k in 0..=n {
            let tau = got[k * 4 + 3];
            assert!(tau >= last_tau, "optical depth only grows");
            last_tau = tau;
            for c in 0..3 {
                let total = got[k * 4 + c] + light[c] * (-tau).exp();
                assert!(
                    (total - light[c]).abs() <= 3e-5 * light[c].max(1.0),
                    "case {case} boundary {k} lane {c}: {total} vs {} ({slices:?})",
                    light[c]
                );
            }
        }
    }
}

// ---------------------------------------------------------------- the temporal blend

#[test]
fn the_histories_weight_and_blend_match_the_f64_reference() {
    let mut f = Fixture::new("tests/volumetrics.sq");
    let mut rng = Lcg(37);
    let (mut full, mut none, mut between) = (0, 0, 0);
    for case in 0..400 {
        let weight = rng.pick(&[0.9, 0.5, 1.0]);
        let valid = case % 7 != 0;
        let current = rng.pick(&[0.0, 0.3, 1.0, 5.0]) * rng.between(0.0, 1.0);
        let history = if case % 3 == 0 {
            current * rng.between(0.9, 1.1)
        } else {
            rng.pick(&[0.0, 0.3, 1.0, 5.0]) * rng.between(0.0, 1.0)
        };
        let got = f.floats(
            "history",
            vec![weight, if valid { 1.0 } else { 0.0 }, current, history],
        );
        let change = (current - history).abs() / current.max(history).max(1e-5);
        let want = if valid {
            weight * (1.0 - smoothstep(0.25, 0.75, change))
        } else {
            0.0
        };
        assert!(
            close(got[0], want, 2e-5),
            "case {case}: {} vs {want}",
            got[0]
        );
        let blended = current * (1.0 - want) + history * want;
        assert!(close(got[1], blended, 2e-5), "case {case}: blend");
        full += usize::from(valid && (want - weight).abs() < 1e-9);
        none += usize::from(want == 0.0);
        between += usize::from(want > 0.0 && want < weight);
    }
    assert!(
        full > 60 && none > 50 && between > 20,
        "{full} {none} {between}"
    );
}

// ---------------------------------------------------------------- the preference lane

#[test]
fn the_volumetrics_lane_decodes_off_low_and_high_and_traps_beyond() {
    let mut f = Fixture::new("tests/preferences.sq");
    for tier in [0.0, 1.0, 2.0] {
        let saved = f.floats("resaved", vec![15.0, tier]);
        assert_eq!(saved.len(), 17);
        assert_eq!(saved[15], tier);
        // Reflections and the saved flag beside it are not disturbed.
        assert_eq!((saved[14], saved[16]), (1.0, 0.0));
    }
    f.traps("resaved", vec![15.0, 3.0]);
    f.traps("resaved", vec![15.0, 1.5]);
    f.traps("resaved", vec![15.0, -1.0]);
    // The lane before it keeps its own bound.
    f.traps("resaved", vec![14.0, 3.0]);
}
