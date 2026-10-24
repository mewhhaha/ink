use crate::render_math::normalize;
use crate::terrain::{fade, hash, lerp, perlin};
use crate::*;
pub fn next(mut s: u32) -> u32 {
    if s == 0 {
        s = 2654435769;
    }
    s ^= s << 13;
    s ^= s >> 17;
    s ^ s << 5
}
struct R(u32);
impl R {
    fn unit(&mut self) -> f64 {
        self.0 = next(self.0);
        (self.0 >> 8) as f64 / 16777216.
    }
    fn between(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.unit()
    }
    fn vector(&mut self) -> [f64; 3] {
        std::array::from_fn(|_| self.between(-5., 5.))
    }
}
fn call(f: &mut Fixture, name: &str, a: impl Into<Input>) -> Vec<f64> {
    let r = f.floats(name, a);
    assert!(r.iter().all(|x| x.is_finite()), "{name}: {r:?}");
    r
}
fn fbm(p: [f64; 3], dimension: usize) -> f64 {
    let (mut sum, mut total) = (0., 0.);
    for octave in 0..6 {
        let mut p = p.map(|x| f32(x * 2f64.powi(octave)));
        if dimension == 2 {
            p[2] = 0.5;
        }
        let weight = 2f64.powi(-octave);
        sum += perlin(
            0xdeadbeefu32.wrapping_add(octave as u32 * 101),
            p[0],
            p[1],
            p[2],
        ) * weight;
        total += weight;
    }
    sum / total
}
#[test]
fn full_width_random_noise_rotations_and_subnormal_normalization() {
    let mut f = Fixture::new("tests/numeric-stress.blot");
    for initial in [0u32, 1, 0x80000001, u32::MAX] {
        let a = f.words("sequence", initial);
        assert_eq!(a.len(), 4096);
        let mut s = initial;
        for x in &a {
            s = next(s);
            assert_eq!(*x, s);
            assert_eq!(f.number("unit", s), (s >> 8) as f64 / 16777216.);
        }
        assert_eq!(f.words("sequence", initial), a);
    }
    let mut rng = R(0xa19c4037);
    for i in 0..128 {
        let mut p = rng.vector().map(f32);
        if i < 16 {
            p = [-3. + i as f64 * 0.5, -2., 1.];
        }
        let input = [p.to_vec(), vec![4294967040., 16777216.]].concat();
        let a = call(&mut f, "noises", input.clone());
        let x = p[0].floor() as i32;
        let y = p[1].floor() as i32;
        let u = fade(p[0] - x as f64);
        let v = fade(p[1] - y as f64);
        let val = |x: i32, y: i32| {
            (hash(x as u32, y as u32, 0, 0xdeadbeef) >> 8) as f64 / 16777216. * 2. - 1.
        };
        near_all(
            &a,
            &[
                perlin(0xdeadbeef, p[0], 0.5, 0.5),
                perlin(0xdeadbeef, p[0], p[1], 0.5),
                perlin(0xdeadbeef, p[0], p[1], p[2]),
                lerp(
                    lerp(val(x, y), val(x + 1, y), u),
                    lerp(val(x, y + 1), val(x + 1, y + 1), u),
                    v,
                ),
                fbm(p, 2),
                fbm(p, 3),
                0.,
                0.,
                (hash(4294967040, 16777216, 0, 0xdeadbeef) >> 8) as f64 / 16777216.,
            ],
            2e-6,
        );
        assert!(a[..6].iter().all(|x| x.abs() <= 1.5));
        assert_eq!(call(&mut f, "noises", input), a);
        let left = call(&mut f, "noises", [-2. - 1e-4, p[1], p[2], 0., 0.]);
        let right = call(&mut f, "noises", [-2. + 1e-4, p[1], p[2], 0., 0.]);
        near_all(&left[..6], &right[..6], 0.003);
    }
    let scales = [1e-30, 1e-23, 1e-22, 1e-20, 1e-10, 1., 1e10, 1e30];
    for d in [[1., -2., 3.], [0., 1., 0.], [0., -1., 0.]] {
        let baseline = call(
            &mut f,
            "rotations",
            [d.to_vec(), vec![1.3], d.to_vec()].concat(),
        );
        for scale in scales {
            let r = call(
                &mut f,
                "rotations",
                [d.map(|v| v * scale).to_vec(), vec![1.3], d.to_vec()].concat(),
            );
            near_all(&r[..4], &baseline[..4], 2e-6);
            for q in r.chunks(4) {
                near(q.iter().map(|x| x * x).sum::<f64>().sqrt(), 1., 2e-6);
            }
            let (x, y, z, w) = (r[4], r[5], r[6], r[7]);
            near_all(
                &[
                    -2. * (x * z + y * w),
                    -2. * (y * z - x * w),
                    -1. + 2. * (x * x + y * y),
                ],
                &normalize(&d),
                2e-6,
            );
        }
    }
    for scale in scales {
        let q = [scale, -2. * scale, 3. * scale, 4. * scale].map(f32);
        let r = call(&mut f, "normalize_quaternion", q);
        near_all(&r, &normalize(&q), 2e-6);
        near(r.iter().map(|x| x * x).sum::<f64>().sqrt(), 1., 2e-6);
    }
}
#[test]
fn springs_conserve_or_dissipate_energy_and_variable_frames_account_time() {
    let mut f = Fixture::new("tests/numeric-stress.blot");
    for damping in [0., 0.001, 0.25, 0.999, 1., 1.001, 2., 20.] {
        let dt = f32(1. / 60.);
        let direct = call(&mut f, "spring", [3., -2., 1., 6., damping, f32(dt * 240.)]);
        let mut state = vec![3., -2.];
        let mut energy = 148.;
        for _ in 0..240 {
            state = call(
                &mut f,
                "spring",
                [state, vec![1., 6., damping, dt]].concat(),
            );
            assert_eq!(state.len(), 2);
            let next = (state[0] - 1.).powi(2) * 36. + state[1] * state[1];
            assert!(next <= energy + 0.0001);
            energy = next;
        }
        near_all(&state, &direct, 0.0005);
        if damping >= 0.999 && damping < 3. {
            near_all(&state, &[1., 0.], 0.01);
        }
        if damping == 0. {
            near(energy, 148., 0.003);
        }
    }
    let step = f32(1. / 60.);
    let (mut remainder, mut timer, mut transitions, mut elapsed, mut consumed) =
        (0., 2.5, 0., 0., 0.);
    for i in 0..8192 {
        let dt = if i % 997 == 0 {
            0.5
        } else {
            f32((i % 7 + 1) as f64 / 240.)
        };
        let r = call(&mut f, "fixed", [step, remainder, dt]);
        assert_eq!(r.len(), 4);
        assert!(r[0] >= 0. && r[0] <= 8. && r[2] >= 0. && r[2] < 1.);
        near(remainder + dt, r[0] * step + r[1] + r[3], 1e-7);
        elapsed += dt;
        consumed += r[0] * step + r[3];
        remainder = r[1];
        let t = call(&mut f, "timer", [timer, dt]);
        transitions += t[1];
        timer = t[0];
    }
    near(elapsed, consumed + remainder, 0.0001);
    assert_eq!((transitions, timer), (1., 0.));
}
#[test]
fn random_affines_camera_conventions_shadow_fits_hdr_and_audio() {
    let mut f = Fixture::new("tests/numeric-stress.blot");
    let mut rng = R(0xa19c4037);
    for _ in 0..128 {
        rng.vector();
    }
    for i in 0..64 {
        let p = rng.vector().map(f32);
        let mut a = Vec::new();
        for _ in 0..2 {
            a.extend(rng.vector());
            a.extend([
                rng.between(-3., 3.),
                rng.between(-1.5, 1.5),
                rng.between(0.2, 3.),
                rng.between(-3., -0.2),
                rng.between(0.2, 3.),
            ]);
        }
        a.extend(p);
        let r = call(&mut f, "affine", a);
        near_all(&r[..3], &r[3..6], 0.00003);
        near_all(&r[6..], &p, 0.00005);
        for ortho in [0., 1.] {
            for reverse in [0., 1.] {
                let local = [
                    rng.between(-0.1, 0.1),
                    rng.between(-0.1, 0.1),
                    rng.between(-40., -1.),
                ];
                let mut a = vec![
                    rng.between(0.5, 2.),
                    rng.between(0.5, 3.),
                    0.1,
                    100.,
                    reverse,
                    ortho,
                ];
                a.extend(rng.vector());
                a.extend([rng.between(-3., 3.), rng.between(-1.5, 1.5)]);
                a.extend(local);
                let r = call(&mut f, "lens", a);
                assert_eq!(r.len(), 19);
                near_all(&r[..3], &r[3..6], 0.005);
                near(r[6..9].iter().map(|x| x * x).sum::<f64>().sqrt(), 1., 1e-6);
                near_all(&r[13..], &[1.; 6], 1e-6);
                assert_eq!(r[9], 1.);
            }
        }
        let mut a = rng.vector().to_vec();
        a.extend(rng.vector());
        a.extend([
            rng.between(0.01, 10.),
            rng.between(0.01, 10.),
            rng.between(0.01, 10.),
            (2 + i * 16) as f64,
            rng.between(0., 5.),
        ]);
        let r = call(&mut f, "cascade", a);
        assert_eq!(r.len(), 24);
        for p in r.chunks(3) {
            assert!(
                p[0].abs() <= 1.000001
                    && p[1].abs() <= 1.000001
                    && p[2] >= -1e-6
                    && p[2] <= 1.000001
            );
        }
    }
    for _ in 0..96 {
        let c = [
            rng.between(-0.1, 8.),
            rng.between(-0.1, 8.),
            rng.between(-0.1, 8.),
            rng.unit(),
        ]
        .map(f32);
        let exponent = f32(rng.between(-126., 126.));
        let value = f32(2f64.powf(rng.between(-125., 125.)));
        let r = call(
            &mut f,
            "display",
            [c.to_vec(), vec![rng.between(-10., 10.), exponent, value]].concat(),
        );
        near_all(&r[..4], &c, 0.00004);
        assert!(r[4..7].iter().all(|x| *x >= 0. && *x <= 1.000001));
        assert_eq!(r[7], c[3]);
        near(r[8] / 2f64.powf(exponent), 1., 0.00002);
        near(r[9], value.log2(), 0.00002);
        let rad = [rng.unit(), rng.unit(), rng.unit()].map(f32);
        near_all(
            &call(
                &mut f,
                "irradiance",
                [rad.to_vec(), rng.vector().to_vec()].concat(),
            ),
            &rad.map(|x| x * std::f64::consts::PI),
            0.00001,
        );
        let p = rng.vector().map(f32);
        let d = p.iter().map(|x| x * x).sum::<f64>().sqrt();
        let range = f32(rng.between(1., 10.));
        let r = call(
            &mut f,
            "local_light",
            [p.to_vec(), rad.to_vec(), vec![range]].concat(),
        );
        let att = if d < range {
            (1. - (d / range).powi(4)).powi(2) / (d * d).max(0.0001)
        } else {
            0.
        };
        near_all(&r[3..], &rad.map(|x| x * att), 0.000002);
    }
    for i in 0..128 {
        let p = rng.vector().map(f32);
        let listener = rng.vector().map(|x| f32(x * 100.));
        let emitter = rng.vector().map(|x| f32(x * 100.));
        let gain = f32(rng.between(0., 4.));
        let dir = normalize(&p);
        let d = p.iter().map(|x| x * x).sum::<f64>().sqrt();
        let blocked = i % 2;
        let r = call(
            &mut f,
            "sound",
            [
                p.to_vec(),
                listener.to_vec(),
                emitter.to_vec(),
                vec![gain, blocked as f64, 2., 0.5, -0.2, 0.8],
            ]
            .concat(),
        );
        let expected = gain * ((100. - d) / 99.).clamp(0., 1.) / (1. + (d - 1.).max(0.))
            * if blocked == 1 { 0.25 } else { 1. };
        let dot = |v: [f64; 3]| v.iter().zip(&dir).map(|(a, b)| a * b).sum::<f64>();
        let rate =
            ((343. + dot(listener)).max(34.3) / (343. + dot(emitter)).max(34.3)).clamp(0.5, 2.);
        near_all(
            &r,
            &[
                expected,
                dir[0],
                rate,
                if blocked == 1 { 1200. } else { 20000. },
                0.05,
            ],
            2e-6,
        );
    }
}
#[test]
fn signed_root_loops_ordered_events_and_rounded_endpoints() {
    let mut f = Fixture::new("tests/numeric-stress.blot");
    for previous in [-8f64, -1.75, -0.25, 0., 0.25, 1.75] {
        for delta in [-4f64, -0.5, 0., 0.5, 4., 31.] {
            let current = previous + delta;
            let r = call(&mut f, "root", [previous, current]);
            near(r[0], delta * 10., 1e-5);
            near_all(&[r[1], r[3]], &[0., 0.], 1e-5);
            near(r[1..5].iter().map(|x| x * x).sum::<f64>().sqrt(), 1., 1e-6);
            if previous.fract() == 0. && current.fract() == 0. {
                near(
                    (r[2] * (delta / 2.).sin() + r[4] * (delta / 2.).cos()).abs(),
                    1.,
                    2e-6,
                );
            }
            let mut expected = Vec::new();
            for cycle in previous.floor() as i32..=current.floor() as i32 {
                for (phase, id) in [(0., 7.), (0.25, 9.), (0.75, 13.)] {
                    let t = cycle as f64 + phase;
                    if t > previous && t <= current {
                        expected.push(id);
                    }
                }
            }
            assert_eq!(&r[5..], &expected);
            assert_eq!(call(&mut f, "root", [previous, current]), r);
        }
    }
    for row in [
        [-32., 0., 1., 1.],
        [-16777216., -16777184., 1., 1.],
        [16777184., 16777216., 1., 1.],
        [0.1, 0.4, 0., 1.],
        [-0.31, 0.91, 1., 0.3],
    ] {
        let [p, c, looping, d] = row.map(f32);
        let (first, last) = if looping != 0. {
            (f32(p / d).floor() as i32, f32(c / d).floor() as i32)
        } else {
            (0, 0)
        };
        let mut expected = Vec::new();
        for cycle in first..=last {
            for event in 0..512 {
                let phase = f32(event as f64 / 512. * d);
                let time = if looping != 0. {
                    f32(f32(cycle as f64 * d) + phase)
                } else {
                    phase
                };
                if time > p && time <= c {
                    expected.push(2147483648u32 + event);
                }
            }
        }
        assert_eq!(f.words("event_workload", row), expected);
    }
    let expected = (0..16384)
        .map(|i| 2147483648u32 + (i + 1) % 512)
        .collect::<Vec<_>>();
    assert_eq!(f.words("event_workload", [0., 32., 1.]), expected);
    let warmed = f.guest.memory_bytes();
    assert!(warmed <= 1024 * 1024);
    for _ in 0..4 {
        assert_eq!(f.words("event_workload", [0., 32., 1.]), expected);
        assert_eq!(f.guest.memory_bytes(), warmed);
    }
}
#[test]
fn ballistic_steering_240_steps_replay() {
    fn trajectory() -> Vec<f64> {
        let mut f = Fixture::new("tests/numeric-stress.blot");
        let dt = f32(1. / 120.);
        let a = [0., f32(-9.8), 0.];
        let mut state = vec![1., 2., 3., 4., 5., -2., 0.];
        let mut p = [1., 2., 3.];
        let mut v = [4., 5., -2.];
        for _ in 0..240 {
            state = call(
                &mut f,
                "ballistic",
                [state[..7].to_vec(), a.to_vec(), vec![dt]].concat(),
            );
            assert!(state[7] >= 0. && state[7] < 13.);
            let chase = call(
                &mut f,
                "chase",
                [
                    p.to_vec(),
                    v.to_vec(),
                    vec![0., 0., 0., 5., 3., 0.05, 0.2, 10.],
                ]
                .concat(),
            );
            assert!(chase[..3].iter().map(|x| x * x).sum::<f64>().sqrt() <= 5.000001);
            assert!(chase[3..6].iter().map(|x| x * x).sum::<f64>().sqrt() <= 10.000002);
            near_all(&chase[6..], &[0., -2., 0.], 1e-5);
            for j in 0..3 {
                v[j] = f32(v[j] + chase[j + 3] * dt);
                p[j] = f32(p[j] + v[j] * dt);
            }
        }
        let t = dt * 240.;
        near_all(
            &state[..3],
            &[1. + 4. * t, 2. + 5. * t + 0.5 * a[1] * t * t, 3. - 2. * t],
            0.00003,
        );
        near_all(&state[3..6], &[4., 5. + a[1] * t, -2.], 0.00004);
        assert!(p.iter().map(|x| x * x).sum::<f64>().sqrt() < 0.5);
        [state, p.to_vec(), v.to_vec()].concat()
    }
    assert_eq!(trajectory(), trajectory());
}
