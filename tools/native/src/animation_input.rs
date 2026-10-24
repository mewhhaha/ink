use super::*;
fn position(times: &[f64], time: f64) -> f64 {
    if times.is_empty() || time < times[0] {
        return 0.0;
    }
    for i in 1..times.len() {
        if time < times[i] {
            return i as f64 - 1.0 + (time - times[i - 1]) / (times[i] - times[i - 1]);
        }
    }
    times.len() as f64 - 1.0
}
fn lanes(keys: &[f64], fresh: &[f64], buttons: &[f64]) -> Vec<f64> {
    [
        vec![1.0, -2.0, 3.0, -4.0, 1.0, fresh.len() as f64],
        fresh.to_vec(),
        vec![keys.len() as f64],
        keys.to_vec(),
        buttons.to_vec(),
    ]
    .concat()
}
#[test]
fn animation_key_search_matches_linear_reference() {
    let mut f = Fixture::new("tests/perf/animation-input.blot");
    for count in [0usize, 1, 2, 16, 128, 1024, 8192] {
        let times: Vec<f64> = (0..count).map(|i| (i / 3) as f64).collect();
        let query = [
            vec![
                f64::NEG_INFINITY,
                -1.0,
                0.0,
                0.25,
                1.0,
                1.75,
                count as f64 / 3.0 - 0.25,
                count as f64,
            ],
            times.iter().take(3).copied().collect(),
            times
                .iter()
                .skip(count.saturating_sub(3))
                .copied()
                .collect(),
            vec![f64::INFINITY, f64::NAN],
        ]
        .concat();
        for time in query {
            let result = f.floats("sample", [vec![time], times.clone()].concat());
            near(result[0], position(&times, f32(time)), 0.001);
            assert_eq!(&result[1..], [0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0]);
        }
    }
    for times in [
        vec![2.0],
        vec![2.0, 2.0, 2.0],
        vec![2.0, 2.0, 4.0, 4.0, 5.0],
        vec![2.0, 3.0, 3.0, 3.0, 8.0],
    ] {
        for time in [-1.0, 2.0, 2.5, 3.0, 4.0, 4.5, 5.0, 8.0, f64::NAN] {
            near(
                f.floats("sample", [vec![time], times.clone()].concat())[0],
                position(&times, time),
                0.001,
            );
        }
    }
    for count in [16, 128, 1024, 8192] {
        let mut expected = 0.0;
        for i in 0..1024 {
            expected = f32(expected + count as f64 - 2.0 + (i % 4) as f64 * 0.25);
        }
        assert_eq!(f.number("late_queries", count), expected);
        assert_eq!(f.number("late_queries", count), expected);
    }
}
#[test]
fn input_restore_preserves_order_and_rejects_malformed_sets() {
    let mut f = Fixture::new("tests/perf/animation-input.blot");
    for count in [0, 1, 64, 128, 256, 512] {
        let keys: Vec<f64> = (0..count).map(|i| (16777215 - i * 11) as f64).collect();
        let values = lanes(&keys, &[9.0, 9.0, 3.0], &[7.0, 0.0, 2.0]);
        assert_eq!(f.floats("restore", values.clone()), values);
        assert_eq!(
            f.words("input_codec", count),
            [count as u32, (count * (count + 1) * (count + 2) / 6) as u32]
        );
        assert_eq!(f.floats("restore", values.clone()), values);
    }
    let keys: Vec<f64> = (0..512).map(|i| i as f64).collect();
    let values = lanes(
        &keys,
        &vec![1.0; 512],
        &[7.0, 6.0, 5.0, 4.0, 3.0, 2.0, 1.0, 0.0],
    );
    assert_eq!(f.floats("restore", values.clone()), values);
    let mut early = keys.clone();
    early[1] = 0.0;
    let mut late = keys;
    late[511] = 0.0;
    let usual = |keys: &[f64]| lanes(keys, &[9.0, 9.0, 3.0], &[7.0, 0.0, 2.0]);
    let mut invalid = vec![
        vec![],
        vec![0.0; 6],
        usual(&early),
        usual(&late),
        usual(&[1.0, 1.0]),
        lanes(&[1.0], &[], &[7.0, 7.0]),
        lanes(&[1.0], &[], &[8.0]),
        usual(&vec![1.0; 513]),
        lanes(&[], &vec![1.0; 513], &[7.0, 0.0, 2.0]),
        lanes(&[], &[], &vec![0.0; 9]),
        lanes(&[], &[], &vec![0.0; 2048]),
        vec![0.0, 0.0, 0.0, 0.0, 0.0, 512.0, 0.0],
        vec![0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 512.0],
        vec![0.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0],
    ];
    for value in [f64::NAN, f64::INFINITY, -1.0, 0.5, 16777216.0] {
        invalid.push(usual(&[value]));
    }
    for values in invalid {
        f.traps("restore", values);
    }
}
#[test]
fn flock_witnesses_ordering_and_memory_plateau() {
    let mut f = Fixture::new("tests/perf/flock.blot");
    for count in [128, 512, 2048] {
        let rows = count / 32;
        let neighbors = 2 * (31 * rows + (rows - 1) * 32);
        assert_eq!(
            f.floats("sparse", count),
            [neighbors as f64, count as f64, count as f64, 0.0]
        );
        let dense = f.floats("dense", count);
        assert_eq!(
            &dense[..3],
            [
                8.0 * count as f64,
                4.5 * count as f64 - 3.5,
                4.5 * count as f64 - 3.5
            ]
        );
        near(dense[3], 32.0 * count as f64, 0.1);
        assert_eq!(f.floats("dense", count), dense);
        assert_eq!(
            f.floats("dense_outputs", count),
            [count as f64, 4.5 * count as f64 - 3.5]
        );
    }
    for most in [0usize, 1, 8, 31, 32, 33, 63, 64, 128] {
        let kept = 63.min(most);
        let x: f64 = (1..=kept).map(|i| (i % 32) as f64 * 0.01).sum();
        let z: f64 = (1..=kept).map(|i| (i / 32) as f64).sum();
        let r = f.floats("row_budget", most);
        assert_eq!(r[0], kept as f64);
        if kept == 0 {
            assert_eq!(r, [0.0; 4]);
        } else {
            near(r[1], (kept + 1) as f64 / 2.0, 1e-5);
            near(r[2], x / kept as f64, 1e-5);
            near(r[3], z / kept as f64, 1e-5);
        }
    }
    let expected = f.floats("dense", 2048);
    let output = f.floats("dense_outputs", 2048);
    f.floats("sparse", 2048);
    let plateau = f.guest.memory_bytes();
    for _ in 0..16 {
        assert_eq!(f.floats("dense", 2048), expected);
        assert_eq!(f.floats("dense_outputs", 2048), output);
        assert_eq!(f.guest.memory_bytes(), plateau);
    }
}
