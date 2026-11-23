use super::*;
fn next(mut x: u32) -> u32 {
    if x == 0 {
        x = 2654435769;
    }
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    x
}
fn choose(f: &mut Fixture, weights: &[f64], seed: u32) -> Vec<u32> {
    f.words(
        "choose",
        [
            vec![(seed & 65535) as f64, (seed >> 16) as f64],
            weights.to_vec(),
        ]
        .concat(),
    )
}
fn reference(weights: &[f64], seed: u32) -> Vec<u32> {
    let weights: Vec<f32> = weights.iter().map(|x| *x as f32).collect();
    if weights.is_empty() || weights.iter().any(|v| !v.is_finite() || *v < 0.0) {
        return vec![];
    }
    let largest = weights.iter().copied().fold(0.0, f32::max);
    if largest == 0.0 {
        return vec![];
    }
    let scaled: Vec<f32> = weights.iter().map(|v| v / largest).collect();
    let total: f32 = scaled.iter().sum();
    let state = next(seed);
    let target = ((state >> 8) as f64 / 16777216.0 * total as f64) as f32;
    let mut cumulative = 0.0f32;
    let mut last = 0;
    for (i, weight) in weights.iter().enumerate() {
        if *weight > 0.0 {
            last = i;
            cumulative += scaled[i];
            if target < cumulative {
                return vec![i as u32, state];
            }
        }
    }
    vec![last as u32, state]
}
#[test]
fn weighted_choices_preserve_full_random_state_proportions_and_replay() {
    let mut f = Fixture::new("tests/placement_choice.blot");
    for weights in [
        vec![0.0, 1.0, 2.0, 7.0],
        vec![1.0, 1.0, 1.0],
        vec![0.0, 0.0, 3.0, 0.0],
        vec![1e-30, 1e30, 2e30],
        vec![2e38, 3e38, 0.0],
    ] {
        for seed in [0, 1, 123, 0x80000001, u32::MAX] {
            assert_eq!(choose(&mut f, &weights, seed), reference(&weights, seed));
        }
    }
    for weights in [
        vec![],
        vec![0.0],
        vec![0.0, 0.0, 0.0],
        vec![-1.0, 2.0],
        vec![1.0, f64::NAN],
        vec![1.0, f64::INFINITY],
        vec![1.0, f64::NEG_INFINITY],
    ] {
        assert!(choose(&mut f, &weights, 123).is_empty());
    }
    for seed in [0, 1, 123, u32::MAX] {
        assert_eq!(choose(&mut f, &[0.0, 0.0, 5.0, 0.0], seed), [2, next(seed)]);
    }
    let mut seed = 0x80000001;
    for _ in 0..1000 {
        let a = choose(&mut f, &[0.0, 1.0, 2.0, 7.0], seed);
        assert_eq!(choose(&mut f, &[0.0, 10.0, 20.0, 70.0], seed), a);
        assert_eq!(choose(&mut f, &[0.0, 1.0, 2.0, 7.0], seed), a);
        seed = a[1];
    }
    let counts = f.words("distribution", 0xf1234567u32);
    assert_eq!(counts[..4].iter().sum::<u32>(), 10000);
    assert_eq!(counts[0], 0);
    for (i, want) in [(1, 1000u32), (2, 2000), (3, 7000)] {
        assert!(counts[i].abs_diff(want) < 150);
    }
    let mut seed = 0xf1234567;
    for _ in 0..10000 {
        seed = next(seed);
    }
    assert_eq!(counts[4], seed);
}
#[test]
fn indexed_ground_matches_linear_queries_and_extent_cells() {
    let mut f = Fixture::new("tests/navigation_ground.blot");
    for mode in [0, 1, 2] {
        for count in [1, 3, 4, 8, 64, 512] {
            for seed in 1..=3 {
                let input = vec![seed, count, mode, 800];
                let result = f.words("compare", input.clone());
                assert_eq!(&result[..5], [0, 0, 0, 0, 0]);
                assert_eq!(f.words("compare", input), result);
                assert!(
                    result[5] > 0
                        && result[5] < 800
                        && result[6] > 0
                        && result[6] < 800
                        && result[7] > 0
                        && result[8] > 0
                );
            }
        }
    }
    assert_eq!(
        f.words("validation", ()),
        [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    );
    assert_eq!(f.words("closed", ()), [1, 0, 0, 1]);
    let expected = [0, 1, 1, 0, 1, 0, 1, 1, 0, 1];
    assert_eq!(
        f.words("edges", false),
        [expected.to_vec(), vec![1]].concat()
    );
    let grid = f.words("edges", true);
    assert_eq!(&grid[..grid.len() - 1], expected);
    assert!(*grid.last().unwrap() > 1);
    for seed in 1..=3 {
        for count in [0, 1, 5, 50, 400] {
            for size in [0, 1, 8, 400] {
                let r = f.words("areas", vec![seed, count, size]);
                assert_eq!(&r[..2], [0, 0]);
                assert!(r[3] <= r[2] * 4 + 64 && r[4] <= r[2] * 8 + 64 && r[4] >= r[2]);
            }
        }
    }
}
#[test]
fn retained_packets_keep_id_words_and_only_dirty_draws() {
    let mut f = Fixture::new("tests/pen-instances.blot");
    assert_eq!(
        f.floats("unchanged_retained", ()),
        f.floats("unchanged_host", ())
    );
    let a = f.floats("adapted", ());
    assert_eq!(&a[176..181], [1.0, 1.0, 0.0, 1.0, 0.0]);
    assert_eq!(
        &a[a.len() - 26..a.len() - 21],
        [65535.0, 65535.0, 0.0, 0.0, 0.0]
    );
    let p = f.floats("packet", 2);
    assert_eq!(&p[176..181], [1.0, 1.0, 0.0, 2.0, 1.0]);
    assert_eq!(p.len(), 181 + 2 * 26 + 2);
    assert_eq!(&p[181..186], [65535.0, 65535.0, 0.0, 0.0, 0.0]);
    assert_eq!(&p[207..212], [65534.0, 65535.0, 1.0, 0.0, 0.0]);
    assert_eq!(&p[p.len() - 2..], [1.0, 256.0]);
    assert!(matches!(
        f.call("unsupported", ()).unwrap(),
        Value::Bool(false)
    ));
    for count in [1, 256, 4096] {
        let r = f.floats("retained", count);
        let i = f.floats("immediate", count);
        assert_eq!(r[0], (16 * 181 + 26 * (count + 15 * (count / 100))) as f64);
        assert_eq!(i[0], (16 * (181 + 24 * count)) as f64);
        assert_eq!(r[1], i[1]);
    }
}
