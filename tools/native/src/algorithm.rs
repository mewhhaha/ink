use super::*;
fn unpack(values: &[u32]) -> Vec<Vec<u32>> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < values.len() {
        let n = values[at] as usize;
        at += 1;
        assert!(at + n <= values.len());
        out.push(values[at..at + n].to_vec());
        at += n;
    }
    out
}
#[test]
fn adversarial_sort_and_snapshot_copies() {
    let mut f = Fixture::new("tests/algorithm-stress.blot");
    let mut rng = Random(u32::MAX);
    for n in [0usize, 1, 2, 15, 16, 17, 31, 257, 4096] {
        let cases: Vec<Vec<u32>> = vec![
            (0..n as u32).collect(),
            (0..n).map(|i| (n - i) as u32).collect(),
            vec![7; n],
            (0..n).map(|_| rng.word() % 13).collect(),
            (0..n).map(|_| rng.word()).collect(),
        ];
        for keys in cases {
            let mut expected: Vec<u32> = (0..n as u32).collect();
            expected.sort_by_key(|&i| keys[i as usize]);
            assert_eq!(f.words("order_u32", keys.clone()), expected);
            let floats: Vec<f64> = keys.iter().map(|v| f32(*v as f64)).collect();
            let mut expected: Vec<u32> = (0..n as u32).collect();
            expected.sort_by(|&a, &b| floats[a as usize].total_cmp(&floats[b as usize]));
            assert_eq!(f.words("order", floats), expected);
        }
    }
    let values = vec![0u32, 1, 16777217, 0x80000000, 0xfffffffe, u32::MAX];
    assert_eq!(
        f.words("copied_u32", values.clone()),
        [
            values.clone(),
            values.iter().map(|v| v ^ u32::MAX).collect()
        ]
        .concat()
    );
    for values in [vec![], vec![-8.0, 0.0, 2.5, 100.0]] {
        assert_eq!(
            f.floats("copied", values.clone()),
            [values.clone(), values.iter().map(|v| v + 1.0).collect()].concat()
        );
    }
}
#[test]
fn spatial_dense_flat_crossing_refits_match_exhaustive_bounds() {
    let mut f = Fixture::new("tests/algorithm-stress.blot");
    let mut rng = Random(813);
    for n in [0usize, 1, 7, 16, 127, 512] {
        for mode in [0, 1, 2] {
            let items: Vec<[f64; 6]> = (0..n)
                .map(|i| {
                    let (mut x, mut y, mut z) = (0.0, 0.0, 0.0);
                    if mode == 1 {
                        x = i as f64 - n as f64 / 2.0;
                    }
                    if mode == 2 {
                        x = (rng.word() % 100) as f64 - 50.0;
                        y = (rng.word() % 100) as f64 - 50.0;
                        z = (rng.word() % 100) as f64 - 50.0;
                    }
                    [x, y, z, x + 1.0, y + 1.0, z + 1.0]
                })
                .collect();
            let dirty: Vec<usize> = (0..n).filter(|i| i % 3 == 0).collect();
            let mut final_items = items.clone();
            for &i in &dirty {
                final_items[i] = [80.0, 0.0, 0.0, 81.0, 1.0, 1.0];
            }
            for query in [
                [-1.0, -1.0, -1.0, 1.0, 1.0, 1.0],
                [80.0, 1.0, 1.0, 80.0, 1.0, 1.0],
                [-100.0, -100.0, -100.0, 100.0, 100.0, 100.0],
            ] {
                let mut input = vec![n as f64, dirty.len() as f64];
                input.extend(query);
                input.extend(items.iter().flatten());
                for &i in &dirty {
                    input.push(i as f64);
                    input.extend(final_items[i]);
                }
                let result = unpack(&f.words("spatial_probe", input));
                let overlaps = |xs: &[[f64; 6]]| {
                    xs.iter()
                        .enumerate()
                        .filter(|(_, a)| {
                            (0..3).all(|axis| {
                                a[axis] <= query[axis + 3] && a[axis + 3] >= query[axis]
                            })
                        })
                        .map(|(i, _)| i as u32)
                        .collect::<Vec<_>>()
                };
                let before = overlaps(&items);
                let after = overlaps(&final_items);
                assert_eq!(result, [before.clone(), after.clone(), after, before]);
            }
        }
    }
    for n in [0u32, 1, 16, 127, 512] {
        let ids: Vec<u32> = (0..n).map(|i| u32::MAX - i).collect();
        let after: Vec<u32> = ids
            .iter()
            .enumerate()
            .filter(|(i, _)| i % 2 != 0)
            .map(|(_, &v)| v)
            .collect();
        assert_eq!(
            unpack(&f.words("scene_dense", ids.clone())),
            [ids.clone(), after.clone(), after, ids]
        );
    }
}
#[test]
fn placement_chunks_spacing_terrain_borders_and_long_tile_walks() {
    let mut f = Fixture::new("tests/algorithm-stress.blot");
    for seed in [0u32, 16777217, u32::MAX] {
        for spacing in [0.0, 0.7, 2.5] {
            let mut place = |z, depth| {
                f.floats(
                    "placed",
                    [
                        (seed & 65535) as f64,
                        (seed >> 16) as f64,
                        0.5,
                        spacing,
                        -12.0,
                        z,
                        24.0,
                        depth,
                    ],
                )
            };
            let whole = place(-10.0, 20.0);
            assert_eq!(whole, [place(-10.0, 10.0), place(0.0, 10.0)].concat());
            assert_eq!(place(-10.0, 20.0), whole);
            for (i, p) in whole.chunks_exact(2).enumerate() {
                assert!(p[0] >= -6.0 && p[0] < 6.0 && p[1] >= -5.0 && p[1] < 5.0);
                for q in whole[..i * 2].chunks_exact(2) {
                    assert!((p[0] - q[0]).hypot(p[1] - q[1]) >= spacing - 1e-6);
                }
            }
            if spacing == 0.0 {
                assert_eq!(whole.len(), 24 * 20 * 2);
            }
        }
    }
    for cells in [0usize, 1, 4, 32] {
        let n = (cells + 1) * (cells + 1);
        let grid: Vec<f64> = (0..n).map(|i| (i % (cells + 1)) as f64 * 0.25).collect();
        for heights in [vec![], grid.iter().take(2).copied().collect(), grid.clone()] {
            for [x, z] in [[3.0, -5.0], [-100.0, -100.0], [100.0, 100.0]] {
                let out = f.floats(
                    "terrain_probe",
                    [vec![cells as f64, x, z], heights.clone()].concat(),
                );
                assert!(out.iter().all(|x| x.is_finite()));
                assert!(out[0] >= out[4] && out[0] <= out[5]);
                near(
                    out[1..4].iter().map(|x| x * x).sum::<f64>().sqrt(),
                    1.0,
                    1e-5,
                );
                if heights.is_empty() {
                    assert_eq!(out[0], 2.0);
                }
                if heights.len() == n && cells > 0 {
                    let column = ((x + 1.0) / 8.0 * cells as f64).clamp(0.0, cells as f64);
                    near(out[0], 2.0 + column * 0.25, 1e-5);
                }
            }
        }
    }
    for ticks in [1, 256, 4096] {
        let out = f.floats("tile_walk", ticks);
        near(out[0], 1.0 + ticks as f64 * 0.25 / 60.0, 0.001);
        near(out[1], 1.4, 1e-6);
        assert_eq!(out[2], 1.0);
    }
}
#[test]
fn degenerate_segments_contact_reversals_and_debug_packing() {
    let mut f = Fixture::new("tests/algorithm-stress.blot");
    for scale in [0.001, 1.0, 1000.0] {
        assert_eq!(
            f.floats(
                "segment",
                [
                    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, scale, 0.0, 0.0, scale, 0.0, 0.0
                ]
            ),
            [0.0, 0.0, 0.0, f32(scale), 0.0, 0.0]
        );
        for v in f.floats(
            "segment",
            [
                -scale, 0.0, 0.0, scale, 0.0, 0.0, 0.0, -scale, 0.0, 0.0, scale, 0.0,
            ],
        ) {
            near(v, 0.0, 1e-4);
        }
        for distance in [0.0, scale, 2.0 * scale, 3.0 * scale] {
            let forward = f.floats("spheres", [scale, scale, 0.0, 0.0, 0.0, distance, 0.0, 0.0]);
            let reverse = f.floats("spheres", [scale, scale, distance, 0.0, 0.0, 0.0, 0.0, 0.0]);
            assert!(forward.iter().all(|x| x.is_finite()));
            assert_eq!(forward[0], reverse[0]);
            if distance > 2.0 * scale + 0.02 {
                assert_eq!(forward[0], 0.0);
            } else {
                assert_eq!(forward[0], 1.0);
                near(
                    forward[7],
                    distance - scale * 2.0,
                    1e-6f64.max(scale * 1e-6),
                );
                near(
                    forward[4..7].iter().map(|x| x * x).sum::<f64>().sqrt(),
                    1.0,
                    1e-6,
                );
                if distance > 0.0 {
                    for i in 4..7 {
                        near(forward[i], -reverse[i], 1e-6);
                    }
                }
            }
        }
    }
    for segments in [0, 1, 2, 3, 32, 512] {
        let out = f.floats("debug_capsule", segments);
        let lines = 4 + if segments >= 3 { 6 * segments } else { 0 };
        assert_eq!(out.len(), lines as usize * 14);
        for lanes in out.chunks_exact(7) {
            assert_eq!(lanes, [0.0, 0.0, 0.0, 0.25, 0.5, 0.75, 1.0]);
        }
    }
    for copies in [1, 2, 4, 8] {
        let out = f.floats("redundant_hull", copies);
        assert_eq!(
            &out[..10],
            [8.0, -1.0, -1.0, -1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]
        );
        near(out[10], -0.1, 1e-6);
    }
    for cells in [1.0, 8.0, 32.0, 128.0] {
        for half in [0.0, 2.0, 64.0] {
            near_all(
                &f.floats("terrain_segment", [cells, half])[..4],
                &[2.0, 0.0, 1.0, 0.0],
                1e-5,
            );
        }
    }
}
#[test]
fn host_carried_rigid_and_character_state_replays_600_ticks() {
    let mut f = Fixture::new("tests/algorithm-stress.blot");
    for mode in [0.0, 1.0] {
        let mut state = if mode == 0.0 {
            vec![
                mode, 0.0, 2.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
            ]
        } else {
            vec![
                mode, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
            ]
        };
        let mut replay = state.clone();
        for _ in 0..600 {
            state = f.floats("body_tick", state);
            replay = f.floats("body_tick", replay);
            assert_eq!(state, replay);
            assert!(state.iter().all(|x| x.is_finite()) && state.len() <= 54);
            near(
                state[4..8].iter().map(|x| x * x).sum::<f64>().sqrt(),
                1.0,
                1e-4,
            );
            if mode == 1.0 {
                near(
                    state[1..4].iter().map(|x| x * x).sum::<f64>().sqrt(),
                    1.0,
                    0.03,
                );
            }
        }
        if mode == 0.0 {
            near(state[2], 0.5, 0.02);
            assert!(state[9].abs() < 0.05 && state.len() > 14);
        }
    }
    let mut walker = vec![0.0, 0.01, 0.0, 0.0];
    for _ in 0..600 {
        walker = f.floats("walk_tick", walker);
        assert!(walker.iter().all(|x| x.is_finite()) && walker[0] <= 2.102);
        near(walker[1], 0.002, 0.012);
    }
    near(walker[0], 2.098, 0.01);
    assert_eq!(walker[3], 1.0);
}
#[test]
fn broad_phase_matches_exhaustive_active_resting_and_layer_pairs() {
    let mut f = Fixture::new("tests/algorithm-stress.blot");
    let mut rng = Random(0xabcdef01);
    for count in [0usize, 1, 16, 64, 128] {
        let sources: Vec<[f64; 9]> = (0..count)
            .map(|i| {
                let kind = i % 3;
                let active = u32::from(kind > 0 && i % 5 != 0);
                let mut x = (rng.word() % 8) as f64 * 0.25;
                if i % 7 == 0 {
                    x += 100.0;
                }
                [
                    x,
                    (rng.word() % 8) as f64 * 0.25,
                    (rng.word() % 8) as f64 * 0.25,
                    0.5,
                    kind as f64,
                    active as f64,
                    (1u32 << (i % 3)) as f64,
                    (i % 7 + 1) as f64,
                    u32::from(i % 11 == 0) as f64,
                ]
            })
            .collect();
        let mut expected = Vec::new();
        for i in 0..count {
            for j in i + 1..count {
                let a = sources[i];
                let b = sources[j];
                if a[8] != 0.0 || b[8] != 0.0 || (a[5] == 0.0 && b[5] == 0.0) {
                    continue;
                }
                if a[4] != 2.0 && b[4] != 2.0 {
                    continue;
                }
                if (a[6] as u32 & b[7] as u32) == 0 || (b[6] as u32 & a[7] as u32) == 0 {
                    continue;
                }
                let reach = a[3]
                    + b[3]
                    + if a[5] != 0.0 { 0.04 } else { 0.0 }
                    + if b[5] != 0.0 { 0.04 } else { 0.0 };
                if (0..3).all(|axis| (a[axis] - b[axis]).abs() <= reach) {
                    expected.extend([i as u32, j as u32]);
                }
            }
        }
        assert_eq!(
            f.words(
                "broad_pairs",
                sources.iter().flatten().copied().collect::<Vec<f64>>()
            ),
            expected
        );
    }
    for count in [0u32, 1, 8, 32, 64] {
        let mut expected = vec![count];
        for i in (0..count).rev() {
            expected.extend([16777217, u32::MAX - i]);
        }
        assert_eq!(f.words("physics_dense", count), expected);
    }
}
#[test]
fn dense_bodies_and_snapshots_keep_committed_memory_bounded() {
    let mut f = Fixture::new("tests/algorithm-stress.blot");
    for count in [16usize, 32, 64] {
        let state = f.floats("dense_bodies", count);
        assert_eq!(state[0], count as f64);
        assert_eq!(state[1], (count * (count - 1) / 2) as f64);
        assert_eq!(state, f.floats("dense_bodies", count));
        assert!(state.iter().all(|x| x.is_finite()));
        let mut expected = Vec::new();
        for i in 1..=count {
            for j in i + 1..=count {
                expected.extend([i as f64, j as f64]);
            }
            let o = 2 + (i - 1) * 13;
            assert!(
                state[o + 1] >= 10.0 - 9.81 / 3600.0 - 1e-5
                    && state[o + 1] <= 10.0 - 9.81 / 7200.0 + 1e-5
            );
            near(
                state[o + 3..o + 7]
                    .iter()
                    .map(|x| x * x)
                    .sum::<f64>()
                    .sqrt(),
                1.0,
                1e-5,
            );
        }
        assert_eq!(&state[2 + count * 13..], expected);
    }
    assert!(f.guest.memory_bytes() <= 40 * 1024 * 1024);
    let count = 512u32;
    let indices: Vec<u32> = (0..count).collect();
    let ids: Vec<u32> = indices.iter().map(|i| u32::MAX - i).collect();
    for (entry, before, limit) in [
        ("spatial_dense_refit", indices, 4 * 1024 * 1024),
        ("scene_dense", ids, 12 * 1024 * 1024),
    ] {
        let mut f = Fixture::new("tests/algorithm-stress.blot");
        let after: Vec<u32> = before
            .iter()
            .enumerate()
            .filter(|(i, _)| i % 2 != 0)
            .map(|(_, &v)| v)
            .collect();
        let expected = [before.clone(), after.clone(), after, before.clone()];
        for _ in 0..3 {
            let input = if entry == "scene_dense" {
                Input::Words(before.clone())
            } else {
                count.into()
            };
            assert_eq!(unpack(&f.words(entry, input)), expected);
            assert!(
                f.guest.memory_bytes() <= limit,
                "{entry}: {} bytes",
                f.guest.memory_bytes()
            );
        }
    }
}
