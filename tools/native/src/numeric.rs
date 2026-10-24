use super::*;
#[test]
fn sorting_random_copy_rotation_and_noise() {
    let mut f = Fixture::new("tests/library.blot");
    for n in [0, 1, 7, 8, 9, 16, 17, 31, 100, 1000, 10000] {
        let keys: Vec<f64> = (0..n).map(|i| ((i * 37) % 11) as f64 - 5.0).collect();
        let mut expected: Vec<u32> = (0..n as u32).collect();
        expected.sort_by(|&a, &b| keys[a as usize].total_cmp(&keys[b as usize]));
        assert_eq!(f.words("order", keys), expected);
        let keys: Vec<u32> = (0..n)
            .map(|i| [u32::MAX, 16777217, 16777216, 0, 0x80000000, 16777217][i % 6])
            .collect();
        expected.sort_by_key(|&i| keys[i as usize]);
        // Reset to source order before stable sorting equal keys.
        expected = (0..n as u32).collect();
        expected.sort_by_key(|&i| keys[i as usize]);
        assert_eq!(f.words("order_u32", keys), expected);
    }
    let keys: Vec<u32> = (0u32..10000)
        .map(|i| i.wrapping_mul(2654435761) ^ (i >> 4))
        .collect();
    let mut indices: Vec<u32> = (0..10000).collect();
    indices.sort_by_key(|&i| keys[i as usize]);
    assert_eq!(f.words("order_u32", keys), indices);
    assert_eq!(
        f.floats("copy", [1.0, 2.0, 3.0]),
        [1.0, 2.0, 3.0, 11.0, 2.0, 3.0]
    );
    assert_eq!(f.words("copy_u32", vec![1u32, 2, 3]), [1, 2, 3, 11, 2, 3]);
    assert!(f.floats("copy", []).is_empty());
    for seed in [0u32, 1, 7, 0x80000000, u32::MAX] {
        let mut x = if seed == 0 { 2654435769 } else { seed };
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        assert_eq!(f.number("next", seed), x as f64);
        assert_eq!(f.number("unit", seed), f32((seed >> 8) as f64 / 16777216.0));
    }
    near_all(
        &f.floats("rotation", std::f64::consts::FRAC_PI_2),
        &[-1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0],
        1e-6,
    );
    for (direction, want) in [(-1.0, 3.0), (0.0, -1.0), (1.0, -1.0)] {
        assert_eq!(f.number("plane", [3.0, direction]), want);
    }
    assert_eq!(f.floats("fractal", 0), [0.0, 0.0]);
    let a = f.floats("fractal", 4);
    assert_eq!(a, f.floats("fractal", 4));
    assert!(a.iter().all(|v| v.is_finite() && v.abs() < 1.04));
}
#[test]
fn time_accounting_timers_and_full_width_limits() {
    let mut f = Fixture::new("tests/time.blot");
    let single = f.floats("fixed", [0.125, 20.0, 0.0, 0.9375]);
    let (mut remainder, mut steps) = (0.0, 0.0);
    for delta in [0.0625, 0.25, 0.03125, 0.46875, 0.125] {
        let a = f.floats("fixed", [0.125, 20.0, remainder, delta]);
        assert_eq!(a[0], 1.0);
        steps += a[1];
        remainder = a[2];
        assert_eq!(a[4], 0.0);
    }
    assert_eq!([steps, remainder, single[3]], [single[1], single[2], 0.5]);
    assert_eq!(
        f.floats("fixed", [0.125, 3.0, 0.0625, 10.0]),
        [1.0, 3.0, 0.0625, 0.5, 9.625]
    );
    assert_eq!(
        f.floats("fixed", [0.125, 3.0, 0.0625, 0.0625]),
        [1.0, 1.0, 0.0, 0.0, 0.0]
    );
    assert_eq!(
        f.floats("fixed", [0.125, 0.0, 0.0, 0.5625]),
        [1.0, 0.0, 0.0625, 0.5, 0.5]
    );
    let huge = f32(1e20);
    for limit in [0.0, 2.0] {
        assert_eq!(
            f.floats("fixed", [1.0, limit, 0.0, huge]),
            [1.0, limit, 0.0, 0.0, huge]
        );
    }
    assert_eq!(f.floats("fixed", [1e-30, 2.0, 0.0, huge]), [0.0]);
    for limit in [0u32, 2, 16777217, 16777219, 0xffffff00, u32::MAX] {
        assert_eq!(f.number("huge_steps", limit), limit as f64);
        assert_eq!(
            f.number("near_steps", limit),
            f32(limit as f64).min(limit as f64)
        );
    }
    assert_eq!(f.floats("three_ticks", 0.05), [1.0, 3.0, 0.0, 0.0, 0.0]);
    let step = f32(1.0 / 60.0);
    near(3.0 * step, f32(0.05), 4e-9);
    assert_eq!(
        f.floats("fixed", [step, 8.0, 0.0, 0.0]),
        [1.0, 0.0, 0.0, 0.0, 0.0]
    );
    let fractional = f.floats("fixed", [step, 8.0, 0.0, f32(step * 3.25)]);
    assert_eq!(fractional[1], 3.0);
    near(fractional[2], step * 0.25, 4e-9);
    near(fractional[3], 0.25, 3e-7);
    near(fractional[4], 0.0, 4e-9);
    for value in [1.0 / 60.0, 0.1, 0.007, 0.125] {
        let step = f32(value);
        for ticks in [1, 2, 3, 7, 31, 127] {
            let boundary = (ticks as f64 * step) as f32;
            let ulp = (f32::from_bits(boundary.to_bits() + 1) - boundary) as f64;
            for bits in [
                boundary.to_bits() - 1,
                boundary.to_bits(),
                boundary.to_bits() + 1,
            ] {
                let delta = f32::from_bits(bits) as f64;
                for limit in [0.0, 2.0, 8.0, 200.0] {
                    let a = f.floats("fixed", [step, limit, 0.0, delta]);
                    assert_eq!(a[0], 1.0);
                    assert!(
                        a[1] <= limit && a[2] >= 0.0 && a[2] < step && a[3] >= 0.0 && a[3] < 1.0
                    );
                    near(a[1] * step + a[2] + a[4], delta, ulp * 2.0);
                    if limit >= ticks as f64 {
                        near(a[4], 0.0, ulp);
                    }
                }
            }
        }
    }
    let (mut remainder, mut consumed, mut received) = (0.0, 0.0, 0.0);
    let step = f32(1.0 / 60.0);
    for frame in 0..120 {
        let delta = f32((frame % 7 + 1) as f64 / 1000.0);
        let a = f.floats("fixed", [step, 4.0, remainder, delta]);
        assert_eq!(a[0], 1.0);
        received += delta;
        consumed += a[1] * step + a[4];
        remainder = a[2];
        assert!((0.0..1.0).contains(&a[3]));
    }
    near(consumed + remainder, received, 1e-6);
    assert_eq!(
        f.floats("fixed", [0.125, 3.0, 0.0625, 0.0]),
        [1.0, 0.0, 0.0625, 0.5, 0.0]
    );
    for invalid in [-1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert_eq!(f.floats("fixed", [0.125, 3.0, 0.0, invalid]), [0.0]);
        assert_eq!(f.floats("fixed", [invalid, 3.0, 0.0, 1.0]), [0.0]);
        assert_eq!(f.floats("fixed", [0.125, 3.0, invalid, 1.0]), [0.0]);
        assert_eq!(f.floats("timer", [invalid, 0.1]), [0.0]);
        assert_eq!(f.floats("timer", [1.0, invalid]), [0.0]);
    }
    assert_eq!(f.floats("fixed", [0.0, 3.0, 0.0, 1.0]), [0.0]);
    assert_eq!(f.floats("fixed", [0.125, 3.0, 3e38, 3e38]), [0.0]);
    for (input, expected) in [
        ([0.5, 0.125], [1.0, 0.375, 0.0, 0.0, 0.0]),
        ([0.375, 0.5], [1.0, 0.0, 1.0, 0.125, 1.0]),
        ([0.0, 0.25], [1.0, 0.0, 0.0, 0.25, 1.0]),
        ([0.5, 0.5], [1.0, 0.0, 1.0, 0.0, 1.0]),
        ([0.0, 0.0], [1.0, 0.0, 0.0, 0.0, 1.0]),
        ([0.5, 0.0], [1.0, 0.5, 0.0, 0.0, 0.0]),
    ] {
        assert_eq!(f.floats("timer", input), expected);
    }
}
