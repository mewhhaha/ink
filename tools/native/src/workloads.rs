//! Independent benchmark witnesses. Shared by the test suite and native runner.
use crate::*;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Workload {
    pub name: String,
    pub modules: Vec<String>,
    pub fixture: String,
    pub entry: String,
    pub sizes: Vec<usize>,
    pub unit: String,
    #[serde(default = "one")]
    pub dimension: u32,
    pub complexity: String,
    #[serde(default)]
    pub expensive: bool,
}
fn one() -> u32 {
    1
}
pub fn workloads() -> Vec<Workload> {
    serde_json::from_str(include_str!("../workloads.json")).unwrap()
}
pub fn witness(f: &mut Fixture, w: &Workload, size: usize) -> Vec<f64> {
    match f.call(&w.entry, size).unwrap() {
        Value::F32(v) => vec![v as f64],
        Value::U32(v) => vec![v as f64],
        Value::ArrayF32(v) => v.into_iter().map(f64::from).collect(),
        Value::ArrayU32(v) => v.into_iter().map(f64::from).collect(),
        v => panic!("unsupported witness {v:?}"),
    }
}
pub fn check(w: &Workload, size: usize, v: &[f64]) {
    assert!(
        !v.is_empty() && v.iter().all(|v| v.is_finite()),
        "{}({size}): {v:?}",
        w.name
    );
    let s = size as f64;
    let sum = s * (s - 1.) / 2.;
    let entry = w.entry.as_str();
    let fixture = w.fixture.as_str();
    let eq = |expected: Vec<f64>| assert_eq!(v, expected, "{}({size})", w.name);
    match fixture {
        "../tests/perf/queue_bulk.blot" => {
            let n = size as u32;
            let mut words = vec![1, 1, n + 1, n, 1, 1, n];
            for i in 0..n {
                words.extend([i + 1, 1, 1, 0, 0, 1, 1, 0, i, i * 3]);
            }
            eq(words.into_iter().map(f64::from).collect());
            return;
        }
        "../tests/perf/six_more.blot" => {
            let n = size as u32;
            let mut words = Vec::new();
            match entry {
                "point_grid_build" => {
                    let buckets = n.max(16).next_power_of_two();
                    let mut heads = vec![0; buckets as usize];
                    let mut points = Vec::new();
                    for i in 0..n {
                        let x = i % 128;
                        let z = i / 128;
                        let bucket = ((x * 2).wrapping_mul(73856093)
                            ^ (z * 2).wrapping_mul(19349663))
                            & (buckets - 1);
                        points.extend([x, z, x, z, heads[bucket as usize]]);
                        heads[bucket as usize] = i + 1;
                    }
                    words.extend(heads);
                    words.extend(points);
                }
                "set_build" => {
                    let mut keys: Vec<_> = (0..n).map(|i| i.wrapping_mul(2654435761)).collect();
                    keys.sort_unstable();
                    words.push(n);
                    words.extend(keys);
                }
                "relation_remove" => {
                    words.extend([1, 1, n + 1]);
                    words.extend(0..n);
                    words.push(n);
                }
                "indices_sparse" => words.extend((0..n).map(|i| i * 32 + i % 32)),
                "indices_dense" => words.extend(0..n * 32),
                "ecs_payload_edits" => {
                    words.extend([0, n / 2, n - 1, 1015, 2015, 3015, n / 32, n / 32, n])
                }
                "ecs_membership_edits" => words.extend([3, 3, 0, 25, 0, n / 2, n - 1]),
                "ecs_dense_edits" => words.extend([0, n - 1, 4, n + 3, n / 32, n / 32, n]),
                _ => panic!("unknown six-more workload {entry}"),
            }
            eq(words.into_iter().map(f64::from).collect());
            return;
        }
        "../tests/perf/followup_six.blot" => {
            let count = size as u32;
            let mut words = Vec::new();
            if entry.starts_with("decode_") {
                words.extend([1, 1, count + 1, count, 1, 1, count]);
                for i in 0..count {
                    words.extend([
                        i + 1,
                        0,
                        1,
                        i % 3 + 1,
                        1,
                        1,
                        1,
                        1,
                        i,
                        i * 3,
                        i * [5, 7, 11][(i % 3) as usize],
                    ]);
                }
            } else if entry.starts_with("publish_") {
                words.extend([0, 1, count, count]);
                for i in 0..count {
                    words.extend([i + 1, 1, i * 3, i % 3 + 1, i * [5, 7, 11][(i % 3) as usize]]);
                }
            } else if entry.starts_with("journal_") {
                words.extend([8, 12, 7, 11]);
                for i in 0..count {
                    words.extend([if i % 2 == 0 { 2 } else { 3 }, i]);
                }
            } else if entry.starts_with("sparse_") || entry.starts_with("dense_") {
                let stride = if entry.starts_with("sparse_") { 64 } else { 1 };
                words.extend([0, count - 1, count]);
                words.extend((0..count).map(|i| i + if i % stride == 0 { 1_600_000 } else { 0 }));
            } else if entry.starts_with("schedule_") {
                words.push(count * (count - 1) / 2 * 64);
            } else if entry.starts_with("map_edits_") {
                words.extend([0, count - count / 16]);
                words.extend((0..count).map(|i| match i % 16 {
                    0 => u32::MAX,
                    8 => i + 16,
                    _ => i,
                }));
            } else if entry.starts_with("map_") {
                words.extend((0..count).map(|i| i * 3));
            } else if entry.starts_with("broad_dense_") {
                words.push(192 * count + 800);
                for i in 0..count + 8 {
                    for j in i + 1..count + 8 {
                        if (i >= count && i % 2 == 0) || (j >= count && j % 2 == 0) {
                            words.extend([i, j]);
                        }
                    }
                }
            } else if entry.starts_with("broad_") {
                words.push(192);
                for i in [0, 2, 4, 6] {
                    words.extend([i, count + i]);
                }
            } else {
                panic!("unknown followup workload {entry}");
            }
            eq(words.into_iter().map(f64::from).collect());
            return;
        }
        "../tests/perf/next_six.blot" => {
            match entry {
                "decode_before" | "decode_after" => eq((0..size)
                    .map(|i| (i as u32).wrapping_mul(2654435761) as f64)
                    .collect()),
                "changes_before" | "changes_after" => eq((0..size)
                    .filter(|i| (i * 2) % 3 != 0)
                    .map(|i| (i * 2) as f64)
                    .collect()),
                "queue_before" | "queue_after" => {
                    let mut words = vec![1, 1, size as u32 + 1, size as u32, 1, 1, size as u32];
                    for i in 0..size as u32 {
                        let tag = i % 4;
                        let value = match tag {
                            0 => vec![],
                            1 => vec![i * 5, i * 5 + 1, i * 5 + 2],
                            2 => vec![i * 7],
                            _ => vec![i * 11],
                        };
                        words.extend([
                            i + 1,
                            0,
                            1,
                            tag,
                            u32::from(tag != 0),
                            2,
                            1,
                            value.len() as u32,
                        ]);
                        words.extend([i, i + 1, i * 3]);
                        words.extend(value);
                    }
                    eq(words.into_iter().map(f64::from).collect());
                }
                "refit_dense" | "refit_sparse" => eq(vec![
                    -16.,
                    4. * (s - 1.) + 1.,
                    0.,
                    4. * (s - 1.) + 1.,
                    (size / 2) as f64,
                ]),
                "casts_ordered" | "casts_direct" => eq(vec![24.]),
                "ui_unprepared" | "ui_prepared" => eq(vec![s, 32., 32., s - 31., s - 31., s - 32.]),
                _ => panic!("unknown next-six fixture {entry}"),
            }
            return;
        }
        "../tests/perf/simd_batches.blot" => {
            if entry.starts_with("field_") {
                eq(vec![0.; size.div_ceil(16).pow(2)]);
            } else if entry.starts_with("pack_") {
                let mut expected = vec![(size as u32 & 65535) as f64, (size as u32 >> 16) as f64];
                for i in 0..size {
                    let word = (i as u32).wrapping_mul(2654435761);
                    expected.extend([(word & 65535) as f64, (word >> 16) as f64]);
                }
                expected.resize(2 + (size + 7) * 2, 0.);
                eq(expected);
            } else if entry.starts_with("bounds_") {
                assert_eq!(v.len(), size * 2);
                for i in 0..size {
                    let x = (i % 9) as f64 - 4.;
                    let y = (i % 11) as f64 - 5.;
                    let depth = (i % 129) as f64 - 3.;
                    let r = (i % 3) as f64 * 0.5;
                    let visible = depth + r >= 0.1
                        && depth - r <= 100.
                        && (x * 1.2).abs() <= depth + r * 2.44_f64.sqrt()
                        && (y * 1.4).abs() <= depth + r * 2.96_f64.sqrt();
                    assert_eq!(v[i], if visible { 1. } else { 0. });
                    near(v[size + i], 1080. * 1.4 * r / (depth - r).max(0.1), 0.003);
                }
            } else {
                assert_eq!(v.len(), size * 2);
                let damping = if entry.starts_with("critical_") {
                    1.
                } else if entry.starts_with("over_") {
                    2.5
                } else {
                    0.4
                };
                // Independent RK4 integration of x'' = -2zw*x' - w²(x-target).
                // 1024 short steps cover the same 16 library timesteps.
                for i in 0..size {
                    let mut x = (i % 17) as f64 - 8.;
                    let mut speed = (i % 13) as f64 * 0.125 - 0.75;
                    let target = (i % 7) as f64 - 3.;
                    let h = 0.016 / 64.;
                    let acceleration =
                        |x: f64, speed: f64| -16. * damping * speed - 64. * (x - target);
                    for _ in 0..1024 {
                        let a1 = acceleration(x, speed);
                        let v2 = speed + h * a1 / 2.;
                        let a2 = acceleration(x + h * speed / 2., v2);
                        let v3 = speed + h * a2 / 2.;
                        let a3 = acceleration(x + h * v2 / 2., v3);
                        let v4 = speed + h * a3;
                        let a4 = acceleration(x + h * v3, v4);
                        x += h * (speed + 2. * v2 + 2. * v3 + v4) / 6.;
                        speed += h * (a1 + 2. * a2 + 2. * a3 + a4) / 6.;
                    }
                    near(v[i], x, 0.001);
                    near(v[size + i], speed, 0.003);
                }
            }
            return;
        }

        "../tests/perf/netcode.blot" => {
            match entry {
                "rollback_session" => eq(vec![s, 1., 1.]),
                "delta_codec" => eq(vec![s, 1.]),
                // Rows i and i+1 blend halfway: lane k holds i + k + 0.5, doubled.
                "snapshot_interpolation" => eq(vec![s, 2. * s - 3., 2. * s + 11.]),
                _ => panic!("unknown netcode workload {entry}"),
            }
            return;
        }
        "../tests/perf/animation_rig.blot" => {
            assert_eq!(v[0], s, "{}({size})", w.name);
            match entry {
                // Worst end error and bone-length error, in metres.
                "ik_two_bone_batch" => assert!(v[1] <= 0.0005 && v[2] <= 0.00002, "{v:?}"),
                // Worst distance between the tip's forward axis and the aim.
                "ik_aim_batch" => assert!(v[1] <= 0.0001, "{v:?}"),
                // Pelvis on the lowest ground after convergence, no foot below its ground.
                "feet_batch" => assert!(v[1] <= 0.001 && v[2] == 0., "{v:?}"),
                "blend_space_batch" => assert!(v[1] <= 0.000001 && v[2] == 0., "{v:?}"),
                "blend_sync_batch" => assert!(v[1] <= 0.0001, "{v:?}"),
                // Weights stay normalised; the state flips once per 20 frames.
                "machine_batch" => {
                    assert!(v[1] <= 0.000001, "{v:?}");
                    assert_eq!(v[2], ((s - 1.) / 20.).floor(), "{v:?}");
                }
                "layers_batch" => assert_eq!(v[1], 0., "{v:?}"),
                _ => panic!("unknown animation rig workload {entry}"),
            }
            return;
        }
        "../tests/perf/audit_storage.blot" => {
            match entry {
                "message_general" | "message_direct" => eq(vec![s, s * (3. * s - 1.) / 2., s * 2.]),
                "query_universe" | "query_anchor" => {
                    eq(vec![2048., (size / 64 * 2016 * 32) as f64])
                }
                "map_persistent" | "map_frozen" | "map_frozen_library" => {
                    eq(vec![s, (sum * 3. + s) * 4.])
                }
                "writes_slice" | "writes_generate" => eq(vec![sum, sum + s]),
                "writes_branches" | "writes_merged" => eq(vec![sum + s * 2.]),
                "collect_comprehension" | "collect_generate" => eq(vec![s, s * s]),
                "handles_concat" | "handles_exact" => {
                    eq(vec![7. + s * 7., 20. + s * 17. + sum * 3.])
                }
                "profile_parse" | "profile_two_pass" => eq(vec![s, 0.]),
                "profile_hot" => eq(vec![8., 7.]),
                "profile_layout" => eq(vec![s]),
                "navigation_short" => eq(vec![32., 32.]),
                "buffer_build" => eq(vec![s * 2., s * s]),
                "graph_chain" => eq(vec![s, s, sum]),
                "path_prepared" | "path_scanned" => eq(vec![s, sum * 4.]),
                _ => panic!("missing audit witness {entry}"),
            }
            return;
        }
        "../tests/perf/incremental_ecs.blot" => {
            match entry {
                "query_cached" | "query_uncached" => eq(vec![s * 32., 31.]),
                "command_batch" | "immediate_edits" => eq(vec![s * (s + 1.) / 2., s - 1.]),
                "streams" => eq(vec![sum, (size - size / 2) as f64, (size / 2) as f64]),
                "relations_indexed" | "relations_scanned" => eq(vec![sum * 16.]),
                "relations_reused" | "relations_rescanned" => eq(vec![sum * 128.]),
                "recipes" => eq(vec![s, sum]),
                _ => panic!("missing incremental ECS witness {entry}"),
            }
            return;
        }

        "../tests/perf/scaling_storage.blot" => {
            match entry {
                "lookup_indexed" | "lookup_linear" => eq(vec![s, sum * 4.]),
                "point_grid" => eq(vec![s, s * 2., s * 2., s * (2. * s - 1.)]),
                _ => panic!("missing scaling storage witness {entry}"),
            }
            return;
        }
        "../tests/perf/maps.blot" => {
            let original: std::collections::BTreeMap<_, _> =
                (0..size).map(|i| (i, i * 3 + 1)).collect();
            let original_sum = original.values().sum::<usize>() as f64;
            match entry {
                "map_lookup" | "linear_lookup" => eq(vec![s, original_sum * 4.]),
                "map_entries" => eq(vec![s * 4., original_sum * 4.]),
                "map_edits" => {
                    let mut edited = original.clone();
                    for i in 0..size {
                        edited.insert(i, i + 10);
                    }
                    for i in 0..size / 4 {
                        edited.remove(&(i * 4));
                        edited.insert(size + i, i);
                    }
                    eq(vec![
                        s,
                        edited.len() as f64,
                        original_sum,
                        edited.values().sum::<usize>() as f64,
                    ]);
                }
                "map_collisions" => {
                    let mut edited = original.clone();
                    for i in 0..size / 2 {
                        edited.remove(&(i * 2));
                    }
                    eq(vec![
                        s,
                        edited.len() as f64,
                        original_sum,
                        edited.values().sum::<usize>() as f64,
                    ]);
                }
                "set_algebra" => {
                    let a: std::collections::BTreeSet<_> = (0..size).collect();
                    let b: std::collections::BTreeSet<_> = (size / 2..size + size / 2).collect();
                    eq(vec![
                        a.union(&b).count() as f64,
                        a.intersection(&b).count() as f64,
                        a.difference(&b).count() as f64,
                        a.union(&b).sum::<usize>() as f64,
                        a.intersection(&b).sum::<usize>() as f64,
                        a.difference(&b).sum::<usize>() as f64,
                    ]);
                }
                _ => panic!("missing collection witness {entry}"),
            }
            return;
        }
        "../tests/perf/working_sets.blot" => {
            match entry {
                "ecs_full" | "ecs_sparse" => {
                    eq(vec![s, sum + 16. * size.div_ceil(257) as f64, sum])
                }
                "field_buckets" => eq(vec![s, sum, size.min(4096) as f64]),
                "retained_sparse" => eq(vec![s, 32., s, s]),
                "packing_nested" | "packing_flat" => eq(vec![s, sum + 4. * s, s - 1.]),
                _ => panic!("missing working set witness {entry}"),
            }
            return;
        }
        "../tests/perf/worker_sessions.blot" => {
            eq(vec![s, 0.]);
            return;
        }
        "../tests/perf/extractions.blot" => {
            match entry {
                "reconcile_original" | "reconcile_indexed" => eq(vec![s, sum]),
                "trajectory_original" | "trajectory_prepared" => eq(vec![
                    s,
                    (0..size)
                        .map(|i| {
                            let t = (i % 16) as f64 * 0.125;
                            15. * t - 5. * t * t
                        })
                        .sum(),
                ]),
                "sampling_original" | "sampling_rows" => {
                    assert_eq!(v.len(), 2);
                    assert_eq!(v[0], s);
                    near(
                        v[1],
                        (0..size)
                            .map(|i| 8. + (i % 8) as f64 * 0.125 + (i % 4) as f64 * 0.5)
                            .sum(),
                        s * 0.00001,
                    );
                }
                "profile_original" | "profile_grouped" => {
                    let mut totals = [0usize; 64];
                    for i in 0..size {
                        totals[i % 64] += 1;
                    }
                    let mut ids: Vec<_> = (0..size.min(64)).collect();
                    ids.sort_by_key(|&i| std::cmp::Reverse(totals[i]));
                    let mut expected = vec![s];
                    for id in ids.into_iter().take(5) {
                        expected.extend([id as f64, totals[id] as f64]);
                    }
                    eq(expected);
                }
                "lod_batch" => eq(vec![
                    s,
                    (0..size)
                        .map(|i| {
                            let depth = 25 + i % 200;
                            if depth < 50 {
                                2.
                            } else if depth < 100 {
                                1.
                            } else {
                                0.
                            }
                        })
                        .sum(),
                ]),
                "pen_profile_batch" => eq(vec![s, s * 5.]),
                _ => panic!("missing extraction witness {entry}"),
            }
            return;
        }
        "../tests/perf/native_mechanisms.blot" => {
            match entry {
                "profiling" => eq(vec![
                    s,
                    4.,
                    7.,
                    s,
                    3.25 * s,
                    s,
                    1024. - 3584. / s,
                    s,
                    s * (s - 1.) / 2.,
                    4.,
                ]),
                "matching" => eq(vec![
                    s,
                    3. * s * s / 4.,
                    s / 2.,
                    s * s / 4.,
                    s / 2.,
                    s * s / 4. - s / 2.,
                    s / 2. * (s - 1.) + 3. * s * s / 4.,
                ]),
                "sampling" => {
                    let expected = (0..size)
                        .map(|i| {
                            2. * (2. + (i % 8) as f64 / 8.)
                                + 3. * (3. + ((i / 8) % 8) as f64 / 8.)
                                + 1.
                        })
                        .sum();
                    assert_eq!(v[0], s);
                    near(v[1], expected, s * 0.0001);
                    assert_eq!(v[2], 0.);
                }
                "flight" => {
                    let expected = (0..size).fold(0., |sum, i| {
                        let t = (i % 17) as f64 / 8.;
                        f32(sum + 14. * t - 4. * t * t)
                    });
                    eq(vec![s, expected, 0., 2., 4.]);
                }
                "levels" => {
                    let cuts = [4., 16., 64.];
                    let mut prior = 4usize;
                    let mut projected = 0.;
                    let mut selected = 0;
                    let mut stable = 0;
                    for i in 0..size {
                        let pixels = f32(64. / (1 + i % 16) as f64);
                        let plain = cuts.iter().filter(|&&t| pixels > t).count();
                        prior = if prior > cuts.len() {
                            plain
                        } else if prior > 0 && pixels <= cuts[prior - 1] - 2. {
                            cuts.iter().filter(|&&t| pixels > t - 2.).count()
                        } else if prior < cuts.len() && pixels > cuts[prior] + 2. {
                            cuts.iter().filter(|&&t| pixels > t + 2.).count()
                        } else {
                            prior
                        };
                        projected = f32(projected + pixels);
                        selected += plain;
                        stable += prior;
                    }
                    eq(vec![s, projected, selected as f64, stable as f64]);
                }
                _ => panic!("unknown native mechanism {entry}"),
            }
            return;
        }

        "../tests/perf/mechanisms.blot" => {
            assert_eq!(v[0], s);
            match entry {
                "field_batch" => eq(vec![s, (s / 16.).ceil()]),
                "history_original" | "history_buffer" => {
                    let c = s.min(64.);
                    eq(vec![s, c, c * (2. * s - c - 1.) / 2.]);
                }
                "statistics_batch" => {
                    let mut a = (0..size).map(|i| (size - i) % 101).collect::<Vec<_>>();
                    a.sort();
                    eq(vec![
                        s,
                        a[(s * 0.95).ceil() as usize - 1] as f64,
                        a[size - 1] as f64,
                    ]);
                }
                "anchor_batch" => eq(vec![
                    s,
                    (0..size)
                        .map(|i| ((i % 100) as f64 - 10.).clamp(0., 80.) + 38.)
                        .sum(),
                ]),
                "outline_batch" => {
                    assert_eq!(v.len(), 4);
                    near(v[1], s * 40., s * 0.002);
                    near(v[2], s * 10., s * 0.002);
                    assert!(v[3] <= 0.005);
                }
                "console_batch" => eq(vec![
                    s,
                    (1..=size)
                        .filter(|i| i.to_string().starts_with('1'))
                        .count() as f64,
                ]),
                "locale_batch" => eq(vec![s, (0..size).map(|i| (97 + i % 26) as f64).sum(), 0.]),
                "pen_locale_batch" => eq(vec![s, s * 162.]),
                _ => panic!("unknown mechanism {entry}"),
            };
            return;
        }
        "../tests/dialogs.blot" => {
            let mut expected = s;
            for i in 0..size {
                if i % 3 == 2 {
                    continue;
                }
                let x = i % 160;
                expected += if i % 3 == 0 && (x < 20 || x >= 120) {
                    2.
                } else {
                    1.
                };
            }
            eq(vec![expected]);
            return;
        }
        "../tests/motion-batch.blot" => {
            assert_eq!(v.len(), size * 4);
            let dt = f32(0.016);
            let gain = f32(f32(-9.81) * dt);
            for i in 0..size {
                let p0 = ((i % 37) as f64 - 18.) * 0.125;
                let v0 = ((i % 19) as f64 - 9.) * 0.25;
                let (mut p, mut vel) = (p0, v0);
                for _ in 0..32 {
                    vel = f32(vel + gain);
                    p = f32(p + f32(vel * dt));
                }
                assert_eq!(
                    [v[i], v[size + i], v[size * 2 + i], v[size * 3 + i]],
                    [p, vel, p0, v0]
                );
            }
            return;
        }
        "../tests/perf/radial.blot" => {
            assert_eq!(v.len(), 193);
            for (x, value) in v.iter().enumerate() {
                let expected = (0..size)
                    .map(|i| {
                        (2. - (-48. + x as f64 * 0.5 - ((i % 9) as f64 - 4.)).abs()).clamp(0., 1.)
                    })
                    .fold(0., f64::max);
                assert_eq!(*value, expected);
            }
            return;
        }
        "../tests/perf/work_queue.blot" => {
            eq(match entry {
                "claims_workload" => (0..32)
                    .map(|i| if i < size { i as f64 } else { u32::MAX as f64 })
                    .collect(),
                "queue_workload" => vec![s, 3. * sum, 0.],
                "schedule_workload" => vec![(s / 4.).ceil(), sum],
                "partition_workload" => vec![sum, s - 1.],
                _ => vec![sum],
            });
            return;
        }
        "../tests/render-cache.blot" => {
            let changing = if entry.starts_with("moving") {
                size
            } else if entry.starts_with("sparse") {
                size / 100
            } else {
                0
            };
            let mut sum = 0.;
            for frame in 0..16 {
                for i in 0..size {
                    sum = f32(sum
                        + f32(i as f64
                            + if i < changing {
                                f32(2. * f32(frame as f64 / 15.))
                            } else {
                                0.
                            }));
                }
            }
            eq(vec![16. * s, sum, 0.]);
            return;
        }
        "../tests/word-persist.blot" => {
            eq(if ["roundtrip", "bridge_roundtrip"].contains(&entry) {
                vec![1., s, 9., 7., sum + 10. * s, 0., u32::MAX as f64]
            } else {
                vec![sum, s * if entry == "codec_bridge" { 66. } else { 24. }]
            });
            return;
        }
        "../tests/prepared-physics.blot" => {
            assert_eq!(v.len(), 2);
            assert!(v[0] >= 50. && v[0] <= 70.);
            assert_eq!(v[1], 128.);
            return;
        }
        "../tests/incremental.blot" => {
            eq(vec![s - 1., s + 30., s / 2. + 31.]);
            return;
        }
        "../tests/ecs-history.blot" => {
            eq(vec![32. * (4096. - 65. - 127.), 32., 132., 0.]);
            return;
        }
        "../tests/compiled-behavior.blot" => {
            eq(vec![6. * s, 24. * s, 25. * s]);
            return;
        }
        "../tests/pen-instances.blot" => {
            if entry == "stream" {
                eq(vec![s + 120., 0., s, sum + 420., 16.]);
            } else {
                let lanes = 16. * 151.
                    + if entry == "retained" {
                        26. * (s + 15. * (s / 100.).floor())
                    } else {
                        16. * 24. * s
                    };
                let checksum = (0..16).fold(0., |a, _| f32(a + 4670534.));
                eq(vec![lanes, checksum]);
            }
            return;
        }
        "../tests/nearest.blot" => {
            eq((0..100)
                .map(|q| {
                    let (mut best, mut distance) = (u32::MAX as f64, f64::INFINITY);
                    for id in 0..size {
                        if id % 7 == 2 {
                            continue;
                        }
                        let dx = (id * 47 % 127) as f64 * 0.125 - 8. - ((q * 11 % 37) as f64 - 18.);
                        let dz = (id * 29 % 131) as f64 * 0.25 - 16. - ((q * 17 % 41) as f64 - 20.);
                        let d = dx * dx + dz * dz;
                        if d < distance {
                            best = id as f64;
                            distance = d;
                        }
                    }
                    best
                })
                .collect());
            return;
        }
        "../tests/workers.blot" => {
            let n = s * 64.;
            eq(vec![n, n * (n - 1.) / 2.]);
            return;
        }
        "../tests/app_lifetime.blot" => {
            let retained = size.min(32);
            let steps = retained.saturating_sub(1);
            let undone: f64 = ((size - retained)..size.saturating_sub(1))
                .map(|value| value as f64)
                .sum();
            eq(vec![
                s,
                retained as f64,
                retained as f64,
                steps as f64,
                undone,
            ]);
            return;
        }
        "../tests/perf/composition.blot" => {
            eq(match entry {
                "cache_changes" => vec![4. * (s / 4.) * (s / 4. - 1.), s / 4.],
                "path_preparation" => vec![s, sum, 0.],
                _ => vec![s, s],
            });
            return;
        }
        "../tests/handles.blot"
        | "../tests/codec.blot"
        | "../tests/derived.blot"
        | "../tests/behavior.blot" => {
            let alive = (s / 2.).ceil();
            eq(match fixture {
                "../tests/handles.blot" => {
                    if ["workload", "dense_churn"].contains(&entry) {
                        vec![alive, alive * (alive - 1.), sum]
                    } else {
                        vec![sum, s]
                    }
                }
                "../tests/codec.blot" => {
                    vec![sum, s * if entry == "handwritten" { 7. } else { 66. }]
                }
                "../tests/derived.blot" => {
                    if entry.starts_with("staffing_") {
                        vec![
                            sum * 32.,
                            if entry == "staffing_cached" { 1. } else { 32. },
                            if entry == "staffing_cached" { 31. } else { 0. },
                        ]
                    } else {
                        vec![s * 6., 1., s - 1.]
                    }
                }
                _ => vec![s * 3., s * 8.],
            });
            return;
        }
        "../tests/perf/ui-text.blot" => {
            if entry == "ui_deep_tree" {
                eq(vec![
                    s,
                    32.,
                    32.,
                    u32::MAX as f64 - s + 32.,
                    u32::MAX as f64 - s + 32.,
                    s - 32.,
                ]);
            } else {
                let points = (0..size)
                    .map(|i| (128578 + 97 + i % 26) as f64)
                    .sum::<f64>();
                eq(if entry == "text_join_many" {
                    vec![s, s * 4. - 2., points + (s - 1.) * (10. + 66615.)]
                } else {
                    vec![
                        s,
                        s + if entry == "text_lines_long" { 1. } else { 0. },
                        s * 2.,
                        points,
                    ]
                });
            }
            return;
        }
        "../tests/perf/flock.blot" => {
            if entry == "sparse" {
                let rows = s / 32.;
                eq(vec![2. * (31. * rows + (rows - 1.) * 32.), s, s, 0.]);
            } else if entry == "dense_outputs" {
                eq(vec![s, 4.5 * s - 3.5]);
            } else {
                assert_eq!(v.len(), 4);
                assert_eq!(&v[..3], &[8. * s, 4.5 * s - 3.5, 4.5 * s - 3.5]);
                near(v[3], 32. * s, 0.1);
            }
            return;
        }
        "../tests/perf/adapters.blot" => {
            match entry {
                "simulation_colliders" => eq(vec![s * 11., sum]),
                "wire_tree" => eq(vec![s, sum, s * (s + 1.) / 2., s]),
                "frame_packet" => eq(vec![166. + s * 24., s, sum]),
                "decoded_events" | "service_requests" => eq(vec![s, s * 65. + sum]),
                "commands" => eq(vec![4., sum, 1.]),
                "platform_codec" => eq(vec![
                    s + 14.,
                    s,
                    (0..size).map(|i| (65 + i % 26) as f64).sum(),
                    4.,
                ]),
                "settings_controls" => {
                    assert_eq!(v[0], s * 4.);
                    let sum = (0..size).fold(0., |a, i| f32(a + f32((i % 100) as f64 * f32(0.01))));
                    near(v[1], sum, 0.001);
                }
                _ => panic!("unknown adapter {entry}"),
            };
            return;
        }
        "../tests/migrated_geometry.blot" => {
            match entry {
                "brushes" => eq(vec![8. * s, s * (s + 1.) / 2.]),
                "lighting" => {
                    let smooth = |lo: f64, hi: f64, x: f64| {
                        let t = ((x - lo) / (hi - lo)).clamp(0., 1.);
                        t * t * (3. - 2. * t)
                    };
                    let expected = (0..size)
                        .map(|i| {
                            let h =
                                (((i % 1000) as f64 + 0.5) / 1000. * std::f64::consts::TAU).sin();
                            let day = smooth(-0.18, 0.25, h);
                            let twilight = 1. - smooth(0., 0.3, h.abs());
                            let strength = smooth(0., 0.3, h.abs());
                            (if h < 0. { 0.12 } else { 1.15 }) * strength
                                + 0.075
                                + 0.25 * day
                                + 0.015 * twilight
                        })
                        .sum();
                    assert_eq!(v[0], s);
                    near(v[1], expected, s * 0.0001);
                }
                "orbits" => {
                    let p = (0.6 + s * 0.0005).min(1.4);
                    let tau = std::f64::consts::TAU;
                    let yaw = (tau - s * 0.005 % tau) % tau;
                    assert!(v[0].hypot(v[2]) <= 10.0001);
                    near(v[1], 6. * p.sin(), 0.001);
                    near(v[3], yaw, 0.001);
                    near(v[4], p, 0.001);
                }
                "paths" => {
                    let expected = (0..size)
                        .map(|i| {
                            (i % 8) as f64
                                + if i % 8 >= 3 {
                                    std::f64::consts::FRAC_PI_2
                                } else {
                                    0.
                                }
                        })
                        .sum();
                    assert_eq!(v[0], 7.);
                    near(v[1], expected, s * 0.0001);
                }
                "ground_segments" | "plots" => eq(vec![s, s]),
                "gizmos_graphics" => eq(vec![18. * s, 2048. * s, 1.041015625 * s]),
                "picking_view" => eq(vec![s, 4. * s, 565. * s]),
                _ => panic!("unknown geometry {entry}"),
            };
            return;
        }
        _ => {}
    }
    match entry {
        "semantic_batch" => {
            assert_eq!(v.len(), 3);
            assert_eq!(v[0], s);
            assert!(v[1] > 300. && v[1] <= 65536. && v[2] > v[1]);
            return;
        }
        "heap_flow" | "large_flow" => {
            assert_eq!(v[0], 2. * (s - 1.));
            return;
        }
        "late_queries" => {
            eq(vec![
                (0..1024).fold(0., |a, i| f32(a + s - 2. + (i % 4) as f64 * 0.25)),
            ]);
            return;
        }
        "input_codec" => {
            eq(vec![s, s * (s + 1.) * (s + 2.) / 6.]);
            return;
        }
        "split_flaps" => {
            eq(vec![s * 6. - (s / 5.).floor() * 2., 0.]);
            return;
        }
        "render_columns" | "render_meshes" => {
            let mut sum = 0.;
            let mut ids = 0.;
            for i in 0..size {
                if i % 4 >= 2 {
                    sum += (i - 1) as f64;
                    ids += i as f64;
                }
            }
            eq(vec![s / 2., sum, ids]);
            return;
        }
        "director_workload" => {
            let groups = s / 8.;
            eq(vec![
                s,
                4. * groups * (groups - 1.) + 6. * groups,
                0.,
                0.,
                3. * groups,
                3.5 * groups,
                s / 2.,
            ]);
            return;
        }
        "cull_workload" => {
            assert!(v[0] > 0. && v[0] <= s);
            return;
        }
        "particle_workload" => {
            assert_eq!(v[0], s);
            return;
        }
        "sprite_workload" => {
            assert_eq!(v[0], s * 54.);
            return;
        }
        "bones_workload" => {
            near(
                v[0],
                (0..size).map(|i| 5. * (i as f64 * 0.5).cos()).sum(),
                0.01,
            );
            return;
        }
        "thousand" => {
            assert!(v[0] > s && v[0] <= s * 100.);
            return;
        }
        "large" => {
            assert_eq!(v[0], 2. * (s - 1.));
            assert_eq!(v[2], 2. * s - 1.);
            assert!(v[1] >= v[2] && v[1] <= s * s);
            return;
        }
        "ui_workload" | "preference_tune" => {
            let expected = (0..size)
                .map(|i| {
                    2. * (i % 101) as f64 * 0.01 + if entry == "ui_workload" { 13. } else { 0. }
                })
                .sum();
            let actual = if entry == "preference_tune" {
                assert_eq!(v[0], s);
                assert_eq!(v[2], 2.);
                v[1]
            } else {
                v[0]
            };
            near(actual, expected, 0.001f64.max(s * 0.00001));
            return;
        }
        "input_workload" => {
            assert_eq!(v[0], 2. * s - 1.);
            return;
        }
        "schedule_workload" => {
            eq(vec![s, s, s * (s + 1.) / 2.]);
            return;
        }
        "steps" => {
            eq(vec![s, s]);
            return;
        }
        "roundtrip" | "bridge_roundtrip" => {
            eq(vec![s, s, sum, 5. * s + 20.]);
            return;
        }
        "dense" | "sparse" | "churn" => {
            let (mut live, mut total, mut prior) = (s, 0., 0.);
            for i in 0..size {
                if entry == "churn" && i % 4 == 0 {
                    live -= 1.;
                    continue;
                }
                prior += i as f64;
                total += i as f64;
                if entry == "dense"
                    || entry == "sparse" && i % 16 == 0
                    || entry == "churn" && i % 4 != 1
                {
                    total += 3.;
                }
            }
            eq(vec![s, live, total, prior]);
            return;
        }
        _ => {}
    }
    assert_eq!(v[0], s, "{} count", w.name);
    match entry {
        "bubbles_workload" => {
            assert_eq!(v.len(), 3);
            assert_eq!(
                v[1],
                (0..size)
                    .map(|i| 185. + 2. * (i % 32) as f64 + 1.5 * (i % 8) as f64)
                    .sum::<f64>()
            );
            assert!((0.0..=0.001).contains(&v[2]));
        }
        "ui_tree_menu" => eq(vec![s, 3., 1., 2. * s, s]),
        "text_workload" => {
            let bound = "1.251.250000InfinityNaN1.000000e20"
                .bytes()
                .map(|x| x as usize)
                .sum::<usize>();
            eq(vec![
                s,
                (0..size).map(|i| (i % 100) as f64 * 0.25).sum(),
                s * 3.,
                bound as f64 * s,
            ]);
        }
        "service_workload" => eq(vec![s, s, s * (s + 4.), 0., 0.]),
        "sound_workload" => eq(vec![s, s, s, 1., 0.]),
        "arrays_batch" => {
            assert_eq!(v[1], sum - 1.);
            assert_eq!(v[2], 0.);
            assert_eq!(v[3], f32(u32::MAX as f64));
        }
        "random_batch" => {
            let mut seed = 123u32;
            for _ in 0..size {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
            }
            assert_eq!(v[1], seed as f64);
            assert_eq!(v[2], 0.);
        }
        "tween_batch" => {
            let linear = (0..size)
                .step_by(9)
                .map(|i| f32(f32((i % 100) as f64) * f32(0.01)))
                .sum();
            near(v[1], linear, s * 0.00001);
            assert!((0.0..=0.001).contains(&v[2]));
        }
        "timeline_batch" => eq(vec![
            s,
            32. * s,
            32. * (4.5 * s - 1.),
            62. * s + s / 2. + 1.,
            938.,
        ]),
        "time_batch" => eq(vec![s, (s / 4.).floor(), (s % 4.) / 32., 1., 1.]),
        "math_batch" | "transform_batch" | "color_batch" | "environment_batch" | "shadow_batch"
        | "steering_batch" | "audio_batch" | "terrain_batch" | "shapes_batch" | "contact_batch"
        | "rigid_batch" => assert!((0.0..=0.001).contains(&v[2])),
        "noise_batch" => assert!(v[2] <= 1.5),
        "motion_batch" => {
            let mut seed = 123u32;
            for _ in 0..size * 3 {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
            }
            assert_eq!(v[2], f32(seed as f64));
        }
        "spline_batch" => {
            near(v[1], 20. * std::f64::consts::PI, 0.001);
            assert!(v[2] <= 0.0001 && v[3] <= 0.0001);
        }
        "rig_batch" => assert!(v[1] <= 0.0001 && v[2] <= 0.001 && v[3] == s && v[4] <= 0.0001),
        "lighting_batch" => assert!(v[1] > 0. && v[2] >= 0.),
        "tiles_batch" | "character_batch" => assert_eq!(v[2], s),
        "spatial_batch" => eq(vec![s, 1., 0., 1.]),
        "scene_batch" => eq(vec![s, 1.5, 1., 2.]),
        "scene_sparse_update" => eq(vec![s, 1., (size / 2 + 1) as f64, 0.]),
        "terrain_range" => eq(vec![s, 0., 16.]),
        "terrain_segment" => {
            near(v[1], 1., 0.001);
            assert_eq!(v[2], 1.);
        }
        "hull_planes" => eq(vec![s, 8., s]),
        "physics_sparse" => {
            near(v[1], 9.9983, 0.0001);
            assert_eq!(v[2], 0.);
        }
        "physics_dense" => assert_eq!(v[2], sum),
        "placement_batch" => assert!(v[1] > 0. && v[1] <= s * 16. && v[3] == 1.),
        "debug_batch" => eq(vec![s, s * 14., 29., 1.]),
        "animation_events" => assert_eq!(v[1], s * 32.),
        "particles_expired" => eq(vec![s, 0., s / 2., 0.]),
        "spatial_dense" | "scene_dense_update" => eq(vec![s, s, 0., s, 0.]),
        "navigation_unreachable" | "navigation_budget" => assert_eq!(v[1], 0.),
        "placement_neighbours" => assert!(v[1] > 0. && v[1] <= 1024.),
        "hull_unique" => assert!(v[1] >= 4. && v[2] == s && v[3] >= 1.9),
        "terrain_detail" => assert!(v[1] >= 1.5 && v[1] <= 2.5 && v[2] >= 0.9),
        "sort_ties" => eq(vec![s, 0., 0., 15.]),
        _ => panic!("unhandled workload {} / {entry}", w.fixture),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migrated_and_scaled_workloads_keep_independent_witnesses() {
        let included = [
            "../tests/perf/radial.blot",
            "../tests/perf/work_queue.blot",
            "../tests/perf/bubbles.blot",
            "../tests/perf/composition.blot",
            "../tests/ecs.blot",
            "../tests/app-hooks.blot",
            "../tests/clock.blot",
            "../tests/persist.blot",
            "../tests/ui_boundaries.blot",
            "../tests/input.blot",
            "../tests/migration-bench.blot",
            "../tests/migrated_geometry.blot",
            "../tests/perf/adapters.blot",
            "../tests/perf/presentation.blot",
            "../tests/director.blot",
            "../tests/perf/netcode.blot",
            "../tests/perf/animation_rig.blot",
        ];
        for w in workloads()
            .into_iter()
            .filter(|w| included.contains(&w.fixture.as_str()))
        {
            let path = root().join("tools").join(&w.fixture);
            let mut f = Fixture::new(path.to_str().unwrap());
            for size in &w.sizes {
                let v = witness(&mut f, &w, *size);
                check(&w, *size, &v);
            }
        }
    }
}
