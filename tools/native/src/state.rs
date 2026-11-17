use super::*;
#[test]
fn word_persistence_identity_snapshots_migrations_and_corruption() {
    let mut f = Fixture::new("tests/word-persist.blot");
    for count in [0u32, 1, 3, 256, 1024] {
        let sum = count * (count.saturating_sub(1)) / 2 + count * 10;
        let expected = vec![1, count, 9, 7, sum, 0, u32::MAX];
        assert_eq!(f.words("roundtrip", count), expected);
        assert_eq!(f.words("bridge_roundtrip", count), expected);
        let saved = f.words("save", count);
        assert!(saved.contains(&0x80000000));
        let bytes: Vec<u8> = saved.iter().flat_map(|x| x.to_le_bytes()).collect();
        let restored: Vec<u32> = bytes
            .chunks_exact(4)
            .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
            .collect();
        assert_eq!(f.words("restore", restored), &expected[1..]);
    }
    assert_eq!(f.words("scene_restore", ()), [3, 42, 7, 33, 10, u32::MAX]);
    assert_eq!(f.words("migration", ()), [1, 3, 109, 107, 33, 0, u32::MAX]);
    let saved = f.words("save", 3);
    for end in 0..saved.len() {
        f.traps("restore", saved[..end].to_vec());
    }
    let mut tail = saved.clone();
    tail.push(0);
    f.traps("restore", tail);
    for (at, value) in [(0, 0), (1, 0), (2, u32::MAX), (5, u32::MAX), (6, 2)] {
        let mut bad = saved.clone();
        bad[at] = value;
        f.traps("restore", bad);
    }
    let mut sections = Vec::new();
    let mut cursor = 3;
    for _ in 0..saved[2] {
        sections.push(cursor);
        cursor += 3 + saved[cursor + 2] as usize;
    }
    let mut duplicate = saved.clone();
    duplicate[sections[1]] = 0;
    f.traps("restore", duplicate);
    let column = *sections.iter().find(|&&at| saved[at] == 101).unwrap();
    let entities = *sections.iter().find(|&&at| saved[at] == 0).unwrap();
    let alive_count = saved[entities + 2];
    // Explicit component pools cover only their stored extent. Padding this
    // one-row pool within the alive extent is valid and preserves its value.
    let mut partial = saved.clone();
    partial[column + 3] = 2;
    assert_eq!(f.words("restore", partial), [3, 9, 7, 33, 0, u32::MAX]);
    for (at, value) in [
        (column + 3, alive_count + 1),
        (column + 4, u32::MAX),
        (column + 5, 3),
        (column + 6, u32::MAX),
    ] {
        let mut bad = saved.clone();
        bad[at] = value;
        f.traps("restore", bad);
    }
}
#[test]
fn behavior_traces_replay_budgets_and_corruption() {
    let mut f = Fixture::new("tests/behavior.blot");
    for deltas in [
        vec![0.0, 0.25, 0.25, 0.25, 0.25],
        vec![2.0],
        vec![0.125, 0.0, 0.375, 0.5, 1.0],
    ] {
        let result = f.words("replay", deltas.clone());
        assert_eq!(&result[..2], [3, 3]);
        assert_eq!(result[2], result[3]);
        let n = result[2] as usize;
        assert_eq!(&result[4..4 + n], &result[4 + n..]);
        let mut trace = Vec::new();
        let mut elapsed = 0.0;
        let mut done = false;
        for dt in deltas {
            if !done {
                trace.push(10);
                elapsed += dt;
                if elapsed >= 1.0 {
                    trace.extend([20, 30, 40, 30, 40, 30, 40, 50]);
                    done = true;
                }
            }
        }
        assert_eq!(&result[4..4 + n], trace);
    }
    for (entry, want) in [
        ("budget", vec![7, 7, 1, 100]),
        ("interruption", vec![3, 1003, 1003, 1003, 0]),
        ("conditions", vec![3, 0, 3, 4, 0]),
        ("boundaries", vec![3, 3, 10, 20, 30, 40, 30, 40, 30, 40, 50]),
        ("version_migration", vec![1, 10, 200, 7]),
        ("stack_limit", vec![1, 0, 2, 1]),
    ] {
        assert_eq!(f.words(entry, ()), want);
    }
    assert_eq!(f.words("delivery", 0), [4, 0, 0, 4, 20, 30, 40]);
    assert_eq!(f.words("delivery", 1), [0, 4, 1, 4, 20, 30]);
    for n in [1u32, 64, 256, 1024] {
        assert_eq!(f.words("workload", n), [3 * n, 8 * n]);
        assert_eq!(f.words("workload", n), f.words("reference", n));
    }
    for dt in [-1.0, f64::NAN, f64::INFINITY] {
        assert_eq!(f.number("invalid_time", dt), 0.0);
    }
    for dt in [0.0, 1e30] {
        assert_eq!(f.number("invalid_time", dt), 1.0);
    }
    let saved = f.words("saved", ());
    assert_eq!(f.number("read", saved.clone()), 1.0);
    for end in 0..saved.len() {
        assert_eq!(f.number("read", saved[..end].to_vec()), 0.0);
    }
    for (at, value) in [
        (0, 2),
        (1, 2),
        (2, 999),
        (3, 0x7f800000),
        (4, 4),
        (4, 3),
        (5, 1),
        (6, 99),
        (7, 99),
    ] {
        let mut bad = saved.clone();
        bad[at] = value;
        assert_eq!(f.number("read", bad), 0.0);
    }
}
#[test]
fn application_event_order_and_observation_callbacks() {
    let mut f = Fixture::new("tests/app-hooks.blot");
    assert_eq!(
        f.floats("pause_events", ()),
        [
            11.0, 2.0, 0.0, 0.5, 0.0, 1.0, 2.0, 1.0, 2.0, 1.0, 2.0, 3.0, 4.0, 4.0, 5.0, 6.0
        ]
    );
    assert_eq!(
        f.floats("paused_frame", ()),
        [11.0, 0.0, 0.0, 0.5, 1.0, 2.0, 5.0, 6.0]
    );
    assert_eq!(f.words("named_plugins", ()), [50, 77, 101]);
    let calls = Arc::new(Mutex::new(Vec::new()));
    let recorded = calls.clone();
    let actual = f
        .guest
        .call(
            "observed_calls",
            blot_host::Argument::Callback(Box::new(move |v| {
                let Value::U32(x) = v else {
                    panic!("callback argument")
                };
                recorded.lock().unwrap().push(x);
                Ok(Value::U32(0))
            })),
        )
        .unwrap();
    let Value::ArrayF32(actual) = actual else {
        panic!("callback result")
    };
    assert_eq!(actual, [11.0, 1.0, 2.0, 3.0, 4.0, 4.0, 5.0, 6.0]);
    assert_eq!(
        *calls.lock().unwrap(),
        [
            4, 5, 100, 101, 206, 207, 308, 309, 410, 411, 414, 415, 410, 411, 414, 415, 512, 513,
            602, 603
        ]
    );
    calls.lock().unwrap().clear();
    let recorded = calls.clone();
    let failed = f.guest.call(
        "observed_calls",
        blot_host::Argument::Callback(Box::new(move |value| {
            let Value::U32(code) = value else {
                panic!("callback argument")
            };
            recorded.lock().unwrap().push(code);
            if code == 414 {
                anyhow::bail!("disabled update observation failed");
            }
            Ok(Value::U32(0))
        })),
    );
    assert!(failed.is_err());
    assert_eq!(
        *calls.lock().unwrap(),
        [4, 5, 100, 101, 206, 207, 308, 309, 410, 411, 414]
    );
}
#[test]
fn compiled_behavior_matches_interpreter_at_all_boundaries() {
    let mut f = Fixture::new("tests/compiled-behavior.blot");
    for budget in [0, 1, 2, 7, 64] {
        for frames in [0, 1, 2, 4] {
            for local in [0, 1, 100] {
                for restore in [0, 1] {
                    for deltas in [
                        vec![1.0f32],
                        vec![0.125; 32],
                        vec![0.0, 0.25, 0.0, 0.5, 1.0],
                    ] {
                        let mut input = vec![0u32, budget, frames, local, restore, 10];
                        input.extend(deltas.iter().map(|x| x.to_bits()));
                        let expected = f.words("replay", input.clone());
                        input[0] = 1;
                        assert_eq!(f.words("replay", input), expected);
                    }
                }
            }
        }
    }
    for step in [45, 60, 70, 95, 999] {
        let mut input = vec![0, 64, 4, 0, 0, step, 1.0f32.to_bits()];
        let expected = f.words("replay", input.clone());
        input[0] = 1;
        assert_eq!(f.words("replay", input), expected);
    }
    for n in [0u32, 1, 64, 1024] {
        assert_eq!(f.words("compiled", n), [6 * n, 24 * n, 25 * n]);
        assert_eq!(f.words("compiled", n), f.words("interpreted", n));
    }
}
#[test]
fn contact_cache_keeps_full_width_ids() {
    let mut f = Fixture::new("tests/cache.blot");
    for ids in [
        [1u32, 16777216, 16777217, 16777218],
        [u32::MAX, 0x80000000, 0x80000001, 0x80000002],
    ] {
        let out = f.words("ids", ids.to_vec());
        let count = out[0] as usize;
        assert!(count > 0);
        let mut expected = vec![[ids[0], ids[1]], [ids[0], ids[2]]];
        for pair in &mut expected {
            pair.sort();
        }
        expected.sort();
        let mut pairs: Vec<[u32; 2]> = out[1..1 + count * 2]
            .chunks_exact(2)
            .map(|x| [x[0], x[1]])
            .collect();
        pairs.dedup();
        assert_eq!(pairs, expected);
        assert_eq!(&out[1 + count * 2..], [1, 1, 0, 0, ids[2]]);
        let sleep = f.words("sleeping", vec![ids[0], ids[1], ids[3]]);
        assert!(sleep[0] > 0);
        assert_eq!(sleep[1], sleep[0]);
        assert_eq!(sleep[2], 0);
        assert_eq!(&sleep[3..], expected[0]);
    }
    for dt in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        assert_eq!(f.floats("unchanged", dt), [10.0, 0.0]);
    }
}
