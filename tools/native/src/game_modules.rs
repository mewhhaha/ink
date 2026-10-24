use crate::numeric_stress::next;
use crate::*;
use std::f64::consts::PI;
fn rotate(v: [f64; 3], yaw: f64, pitch: f64) -> [f64; 3] {
    let [x, y, z] = v;
    let py = y * pitch.cos() - z * pitch.sin();
    let pz = y * pitch.sin() + z * pitch.cos();
    [
        x * yaw.cos() + pz * yaw.sin(),
        py,
        -x * yaw.sin() + pz * yaw.cos(),
    ]
}
pub fn spring(x: f64, v: f64, target: f64, w: f64, z: f64, dt: f64) -> [f64; 2] {
    let x = x - target;
    if w == 0. {
        return [target + x + v * dt, v];
    }
    if z == 1. {
        let b = v + w * x;
        let e = (-w * dt).exp();
        return [target + (x + b * dt) * e, (v - w * b * dt) * e];
    }
    if z < 1. {
        let a = z * w;
        let b = w * (1. - z * z).sqrt();
        let e = (-a * dt).exp();
        let (sn, cs) = (b * dt).sin_cos();
        return [
            target + e * (x * cs + (v + a * x) * sn / b),
            e * (v * cs - (a * v + w * w * x) * sn / b),
        ];
    }
    let root = (z * z - 1.).sqrt();
    let r1 = -w / (z + root);
    let r2 = -w * (z + root);
    let c1 = (v - r2 * x) / (r1 - r2);
    let c2 = x - c1;
    [
        target + c1 * (r1 * dt).exp() + c2 * (r2 * dt).exp(),
        r1 * c1 * (r1 * dt).exp() + r2 * c2 * (r2 * dt).exp(),
    ]
}
#[test]
fn camera_projection_matrix_picking_roundtrips_and_frustum() {
    let mut f = Fixture::new("tests/game_modules.blot");
    for ortho in [false, true] {
        for reversed in [false, true] {
            for local in [[0., 0., -0.2], [0.5, -0.4, -4.], [0., 0., -200.]] {
                let position = [3., -2., 7.];
                let world = rotate(local, 0.6, -0.3).map(|x| x);
                let world: [f64; 3] = std::array::from_fn(|i| world[i] + position[i]);
                let r = f.floats(
                    "camera_probe",
                    [
                        vec![
                            1.3,
                            1.7,
                            0.2,
                            200.,
                            reversed as u8 as f64,
                            ortho as u8 as f64,
                        ],
                        position.to_vec(),
                        vec![0.6, -0.3],
                        world.to_vec(),
                        vec![0.],
                    ]
                    .concat(),
                );
                let (sy, w, a) = if ortho {
                    (2. / 1.3, 1., 1. / (0.2 - 200.))
                } else {
                    (1. / 0.65f64.tan(), -local[2], 200. / (0.2 - 200.))
                };
                let mut depth = (a * local[2] + 0.2 * a) / w;
                if reversed {
                    depth = 1. - depth;
                }
                near_all(
                    &r[..3],
                    &[local[0] * sy / 1.7 / w, local[1] * sy / w, depth],
                    2e-5,
                );
                near_all(&r[3..6], &world, 0.04);
                let m = &r[13..];
                let point = [world[0], world[1], world[2], 1.];
                let clip: [f64; 4] = std::array::from_fn(|row| {
                    (0..4).map(|col| m[col * 4 + row] * point[col]).sum()
                });
                near_all(
                    &clip[..3].iter().map(|v| v / clip[3]).collect::<Vec<_>>(),
                    &r[..3],
                    2e-5,
                );
                let dir = if ortho {
                    [0., 0., -1.]
                } else {
                    let length = local.iter().map(|x| x * x).sum::<f64>().sqrt();
                    local.map(|v| v / length)
                };
                near_all(&r[9..12], &rotate(dir, 0.6, -0.3), 2e-5);
            }
        }
    }
    for (p, r, w) in [
        ([0., 0., -5.], 0., 1.),
        ([0., 0., 1.], 0.5, 0.),
        ([0., 0., -11.], 0.5, 0.),
        ([7., 0., -5.], 0.5, 0.),
        ([-7., 0., -5.], 0.5, 0.),
        ([0., 7., -5.], 0.5, 0.),
        ([0., -7., -5.], 0.5, 0.),
        ([5.3, 0., -5.], 0.5, 1.),
    ] {
        assert_eq!(
            f.floats(
                "camera_probe",
                [
                    vec![PI / 2., 1., 1., 10., 0., 0., 0., 0., 0., 0., 0.],
                    p.to_vec(),
                    vec![r]
                ]
                .concat()
            )[12],
            w
        );
    }
}
#[test]
fn analytic_springs_and_seeded_ballistic_particles() {
    let mut f = Fixture::new("tests/game_modules.blot");
    for damping in [0., 0.3, 0.99, 1., 1.01, 2., 10.] {
        for dt in [0.001, 0.2, 2.] {
            let full = f.floats("spring_probe", [3., -2., 1., 5., damping, dt, 0.3]);
            near_all(&full[..2], &spring(3., -2., 1., 5., damping, dt), 8e-5);
            let half = f.floats("spring_probe", [3., -2., 1., 5., damping, dt / 2., 0.3]);
            near_all(
                &f.floats(
                    "spring_probe",
                    [half[..2].to_vec(), vec![1., 5., damping, dt / 2., 0.3]].concat(),
                )[..2],
                &full[..2],
                5e-5,
            );
            near_all(
                &full[2..8],
                &[0.468, 0.216, 0.48, 1.26, 0.216, 0.16308],
                2e-5,
            );
            near_all(
                &full[8..],
                &[spring(0., 1., 0., 5., damping, dt)[0]; 2],
                2e-5,
            );
        }
    }
    let r = f.floats("particle_probe", [123., 20., 0.5]);
    assert_eq!(f.floats("particle_probe", [123., 20., 0.5]), r);
    assert_eq!(r[0], 20.);
    near_all(
        &r[1..4],
        &[r[10] * 0.5, r[11] * 0.5 - 9. * 0.125, r[12] * 0.5],
        2e-5,
    );
    near_all(&r[4..7], &[r[10], r[11] - 4.5, r[12]], 2e-5);
    assert_eq!((r[7], r[13]), (0.5, 0.));
    assert!(r[8] >= 2.5 && r[8] < 3.5);
    assert_eq!(f.floats("particle_probe", [123., 20., 4.]), vec![0.]);
    assert_ne!(f.floats("particle_probe", [124., 20., 0.5])[1], r[1]);
    for seed in [0u32, 123, 0x80000001, u32::MAX] {
        let r = f.words("seed_probe", seed);
        let mut expected = seed;
        for _ in 0..15 {
            expected = next(expected);
        }
        assert_eq!(r[0], expected);
        for i in [0, 2, 4] {
            assert_eq!(r[i], r[i + 1]);
        }
    }
}
#[test]
fn animation_masks_loop_motion_and_ordered_crossings() {
    let mut f = Fixture::new("tests/game_modules.blot");
    let r = f.floats("animation_probe", [0.8, 2.2, 1.]);
    near_all(&r[..3], &[2., 1., 2.], 2e-5);
    near(r[3], 1. + 2. * 0.1f64.cos(), 0.002);
    let angle = |t: f64| (t * 0.5f64.sin()).atan2(1. - t + t * 0.5f64.cos());
    let half = 1. + angle(0.2) - angle(0.8);
    near_all(&r[4..8], &[14., 1., half.sin(), half.cos()], 2e-5);
    assert_eq!(&r[8..], &[7., 9., 7.]);
    let r = f.floats("animation_probe", [-0.2, 0., 1.]);
    assert_eq!(&r[8..], &[7.]);
    near(r[4], 2., 1e-5);
    assert_eq!(&f.floats("animation_probe", [0., 0.5, 0.])[8..], &[9.]);
    let r = f.floats("animation_probe", [2.2, 0.8, 1.]);
    near(r[4], -14., 1e-5);
    assert!(r[8..].is_empty());
}
fn candidate(x: i32, z: i32) -> (u32, [f64; 2]) {
    let priority = next(
        next(
            (x as u32).wrapping_mul(374761393)
                ^ (z as u32).wrapping_mul(668265263)
                ^ 123
                ^ 2246822519,
        )
        .wrapping_mul(3266489917),
    );
    let a = next(priority);
    let b = next(a);
    (
        priority,
        [
            f32(x as f64 + (a >> 8) as f64 / 16777216.),
            f32(z as f64 + (b >> 8) as f64 / 16777216.),
        ],
    )
}
#[test]
fn placement_matches_independent_candidates_across_chunk_seams() {
    let mut f = Fixture::new("tests/game_modules.blot");
    let full = f.floats("placement_probe", [123., 1., 1.2, -4., -3., 8., 6.]);
    let chunks = [
        f.floats("placement_probe", [123., 1., 1.2, 0., -3., 4., 6.]),
        f.floats("placement_probe", [123., 1., 1.2, -4., -3., 4., 6.]),
    ]
    .concat();
    let ordered = |v: &[f64]| {
        let mut p = v.chunks(2).map(|p| [p[0], p[1]]).collect::<Vec<_>>();
        p.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
        p
    };
    assert_eq!(ordered(&chunks), ordered(&full));
    assert_eq!(
        f.floats("placement_probe", [123., 1., 1.2, -4., -3., 8., 6.]),
        full
    );
    let mut reference = Vec::new();
    for z in -3..3 {
        for x in -4..4 {
            let (c, p) = candidate(x, z);
            let mut accepted = true;
            for dz in -3..=3 {
                for dx in -3..=3 {
                    if dx == 0 && dz == 0 {
                        continue;
                    }
                    let (other, q) = candidate(x + dx, z + dz);
                    if other < c && (q[0] - p[0]).hypot(q[1] - p[1]) < 1.2 {
                        accepted = false;
                    }
                }
            }
            if accepted {
                reference.extend(p);
            }
        }
    }
    assert_eq!(full, reference);
    assert!(full.len() > 10);
    for (i, a) in full.chunks(2).enumerate() {
        for b in full.chunks(2).skip(i + 1) {
            assert!((a[0] - b[0]).hypot(a[1] - b[1]) >= 1.2 - 1e-6);
        }
    }
    assert_ne!(
        f.floats("placement_probe", [124., 1., 1.2, -4., -3., 8., 6.]),
        full
    );
}
#[test]
fn debug_geometry_sprite_winding_billboards_and_bounded_workloads() {
    let mut f = Fixture::new("tests/game_modules.blot");
    for (name, expected) in [
        ("debug_probe", vec![12., 52., 168., 1., 0.5, 0., 1.]),
        ("edge_probe", vec![1., 4., 2., 3., 7., 0.]),
        (
            "geometry_probe",
            vec![3., 4., 3., 3., 4.5, 5., 3., 12., 8., 2., 18., 12., 2., 22.],
        ),
    ] {
        assert_eq!(f.floats(name, [0.]), expected);
    }
    let r = f.floats("workload", [10000.]);
    assert!(r[0] > 4000. && r[0] < 10000.);
    assert_eq!(r[1], 10000.);
    near(r[2], (0..100).map(|i| (i as f64 * 0.1).cos()).sum(), 0.0002);
    for yaw in [0., 0.7] {
        for pitch in [0., -0.3] {
            for spin in [0., PI / 2., -0.4] {
                let r = f.floats(
                    "billboard_probe",
                    [3., 4., 5., 2., 4., yaw, pitch, spin, 7., 4., 2.],
                );
                let expected = [[-1., -2.], [1., -2.], [1., 2.], [-1., 2.]]
                    .into_iter()
                    .flat_map(|[x, y]| {
                        let p = rotate(
                            [
                                x * spin.cos() - y * spin.sin(),
                                x * spin.sin() + y * spin.cos(),
                                0.,
                            ],
                            yaw,
                            pitch,
                        );
                        [p[0] + 3., p[1] + 4., p[2] + 5.]
                    })
                    .collect::<Vec<_>>();
                near_all(&r[..12], &expected, 2e-5);
                near_all(&r[12..], &[0.75, 1., 1., 1., 1., 0.5, 0.75, 0.5], 2e-5);
            }
        }
    }
    let base = vec![0., 0., 0., 1., 1., 0., 0., 0.];
    assert_eq!(
        f.floats("billboard_probe", [base.clone(), vec![0., 0., 2.]].concat())
            .len(),
        12
    );
    let a = f.floats(
        "billboard_probe",
        [base.clone(), vec![15., 4., 2.]].concat(),
    );
    let b = f.floats("billboard_probe", [base, vec![7., 4., 2.]].concat());
    near_all(&a[12..], &b[12..], 2e-5);
    let v = f.floats("sprite_probe", [0.25, 0., 0., 0., 1.]);
    assert_eq!(v.len(), 108);
    let corners = [[0., 1., 3.], [2., 1., 3.], [2., 3., 3.], [0., 3., 3.]];
    let uv = [[0.5, 1.], [0.75, 1.], [0.75, 0.5], [0.5, 0.5]];
    let ids = [0, 1, 2, 0, 2, 3];
    for (i, j) in ids.into_iter().enumerate() {
        near_all(
            &v[i * 9..i * 9 + 9],
            &[
                corners[j].to_vec(),
                uv[j].to_vec(),
                vec![0.2, 0.4, 0.6, 0.8],
            ]
            .concat(),
            2e-5,
        );
    }
    assert!((v[9] - v[0]) * (v[19] - v[1]) - (v[10] - v[1]) * (v[18] - v[0]) > 0.);
    near_all(&v[54..57], &[-1.5, -0.5, 2.], 2e-5);
    let held = f.floats("sprite_probe", [2., PI / 2., 0.4, -0.2, 0.]);
    near_all(&held[3..5], &[0.75, 1.], 2e-5);
    for (i, j) in ids.into_iter().enumerate() {
        let [x, y] = [[-1., -1.], [1., -1.], [1., 1.], [-1., 1.]][j];
        let p = rotate([-y, x, 0.], 0.4, -0.2);
        near_all(
            &held[i * 9..i * 9 + 3],
            &[p[0] + 1., p[1] + 2., p[2] + 3.],
            2e-5,
        );
    }
    assert_eq!(f.number("sprite_workload", 10000), 540000.);
}
#[test]
fn bounded_compiler_probes_and_library_examples() {
    let mut f = Fixture::new("tools/compiler-probe.blot");
    for n in [1000, 2000] {
        for entry in ["inline_writes", "break_writes"] {
            assert_eq!(
                f.floats(entry, n),
                vec![(n - 1) as f64, (n * (n - 1) / 2) as f64]
            );
        }
        assert_eq!(
            f.floats("pathfinding", n),
            vec![(n - 1) as f64, n as f64, n as f64]
        );
        assert_eq!(
            f.words("unsigned_sort", n),
            vec![
                (n - 1) as u32,
                0,
                n as u32,
                (n as u64 * (n as u64 * n as u64 - 1) / 6) as u32
            ]
        );
    }
    let r = Fixture::new("examples/navigation.blot").floats("route", 0);
    assert_eq!(&r[..2], &[7., 4.]);
    near(r[2], 0., 1e-6);
    assert!(r[3] > 0.);
    let r = Fixture::new("examples/joints.blot").floats("pendulum", 16);
    near(r[2], 1., 0.002);
    assert!(r[1] < 2.);
}
