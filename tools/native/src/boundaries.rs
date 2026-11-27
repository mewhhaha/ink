use super::*;
fn norm(xs: &[f64]) -> f64 {
    xs.iter().map(|x| x * x).sum::<f64>().sqrt()
}
#[test]
fn numeric_boundaries_reject_nonfinite_and_keep_extreme_inputs_bounded() {
    let mut f = Fixture::new("tests/numeric-boundaries.sq");
    assert!(f.floats("quaternion", [0.0, 0.0, 0.0, 0.0]).is_empty());
    assert!(f.floats("normalize_vector", [0.0, 0.0, 0.0]).is_empty());
    for scale in [1e-30, 1.0, 1e30] {
        let q = f.floats("quaternion", [scale, 0.0, 0.0, scale]);
        near(q[0], std::f64::consts::FRAC_1_SQRT_2, 1e-6);
        near(q[3], std::f64::consts::FRAC_1_SQRT_2, 1e-6);
        let v = f.floats("normalize_vector", [scale, scale, 0.0]);
        near(v[0], std::f64::consts::FRAC_1_SQRT_2, 1e-6);
        near(norm(&v), 1.0, 1e-6);
    }
    assert_eq!(
        f.floats("directions", [0.0, 0.0, 0.0]),
        [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
    );
    for y in [-1.0, 1.0] {
        let q = f.floats("directions", [0.0, y, 0.0]);
        near(norm(&q[..4]), 1.0, 1e-6);
        near(-2.0 * (q[1] * q[2] - q[0] * q[3]), y, 1e-6);
    }
    for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert!(f.floats("quaternion", [invalid, 0.0, 0.0, 1.0]).is_empty());
        assert!(f.floats("normalize_vector", [invalid, 0.0, 0.0]).is_empty());
        assert!(f.floats("pick", invalid).is_empty());
        assert!(f.floats("unproject", invalid).is_empty());
        for i in 0..4 {
            let mut a = [0.0, 1.0, 1.0, -4.0];
            a[i] = invalid;
            assert!(f.floats("project", a).is_empty());
        }
        for i in 0..6 {
            let mut a = [3.0, -2.0, 1.0, 5.0, 0.3, 0.2];
            a[i] = invalid;
            assert!(f.floats("spring", a).is_empty());
        }
        for i in 0..3 {
            let mut a = [1.0, 6.0, 1.0];
            a[i] = invalid;
            assert!(f.floats("sound", a).is_empty());
        }
        assert_eq!(f.floats("window", [1.0, 0.0, invalid]), [0.0, 0.0]);
    }
    near(norm(&f.floats("pick", 1e30)), 1.0, 1e-6);
    assert!(f.floats("project", [0.0, 1.0, 1.0, 0.0]).is_empty());
    assert!(
        f.floats("project", [0.0, 0.0, 1.0, -4.0])
            .iter()
            .all(|x| x.is_finite())
    );
    for invalid in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert!(f.floats("logarithm", invalid).is_empty());
        assert!(f.number("unchecked_log", invalid).is_finite());
    }
    for value in [1e-38, 0.125, 1.0, 2.0, 1e38] {
        near(
            f.floats("logarithm", value)[0],
            f32(value).max(1.17549435e-38).log2(),
            2e-5,
        );
    }
    for value in [1e10, 1e20, 1e38] {
        assert_eq!(f.number("tone", value), 1.0);
    }
    assert_eq!(
        f.floats("spring", [3.0, -2.0, 1.0, 5.0, 0.3, 0.0]),
        [3.0, -2.0]
    );
    assert!(
        f.floats("spring", [3.0, -2.0, 1.0, 10000.0, 0.3, 1.0])
            .is_empty()
    );
    assert!(
        f.floats("spring", [3.0, -2.0, 1.0, -5.0, 0.3, 0.2])
            .is_empty()
    );
    assert_eq!(f.floats("validate_clip", [1.0, 0.5, 0.5]), [0.0]);
    assert_eq!(
        f.floats(
            "validate_clip",
            [1.0, 0.5, 0.5, 0.0, 0.0, 0.5, 2.0, 0.5, 4.0, 1.0, 10.0]
        ),
        [4.0]
    );
    assert!(
        f.floats("validate_clip", [1.0, 0.5, 0.5, 0.7, 7.0, 0.5, 5.0])
            .is_empty()
    );
    for invalid in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        assert!(f.floats("validate_clip", [invalid, 0.0, 0.0]).is_empty());
    }
    for invalid in [-0.1, 1.0, f64::NAN, f64::INFINITY] {
        assert!(f.floats("validate_clip", [1.0, invalid, 0.0]).is_empty());
    }
    assert!(
        f.floats("validate_clip", [1.0, 0.0, 0.0, 0.0, f64::INFINITY])
            .is_empty()
    );
    for (parents, want) in [
        (vec![u32::MAX, 0, 1], true),
        (vec![u32::MAX, 1], false),
        (vec![1, u32::MAX], false),
    ] {
        assert!(matches!(f.call("parents",parents).unwrap(),Value::Bool(value) if value==want));
    }
    for (input, want) in [
        ([1.0, 0.8, 2.2], [14.0, 2.0]),
        ([1.0, 2.2, 0.8], [-14.0, 0.0]),
        ([1.0, 0.0, 4096.0], [40960.0, 0.0]),
        ([1.0, 0.0, 1e30], [0.0, 0.0]),
        ([1e-38, 0.0, 1.0], [0.0, 0.0]),
    ] {
        assert_eq!(f.floats("window", input), want);
    }
    assert_eq!(f.floats("sound", [1.0, 0.0, 1.0]), [1.0, 0.0, 1.0, 20000.0]);
    assert!(f.floats("sound", [0.0, 6.0, 1.0]).is_empty());
    assert!(f.floats("sound", [1.0, 6.0, -1.0]).is_empty());
}
#[test]
fn formatters_round_padding_nonfinite_scientific_and_text_bounds() {
    let mut f = Fixture::new("tests/formatters.sq");
    fn text(f: &mut Fixture, name: &str, value: impl Into<Input>) -> String {
        f.words(name, value)
            .into_iter()
            .map(|x| char::from_u32(x).unwrap())
            .collect()
    }
    for (value, decimal, fixed, shown) in [
        (0.0, "0", "0.00", "0"),
        (-0.0, "0", "0.00", "0"),
        (2.4, "2.4", "2.40", "2.4"),
        (-12.125, "-12.125", "-12.13", "-12.125"),
        (0.0625, "0.0625", "0.06", "0.0625"),
        (9.999, "9.999", "10.00", "9.999"),
    ] {
        assert_eq!(text(&mut f, "decimal", value), decimal);
        assert_eq!(text(&mut f, "fixed", value), fixed);
        assert_eq!(text(&mut f, "shown", value), shown);
    }
    assert_eq!(text(&mut f, "decimal_precision", u32::MAX), "1.25");
    assert_eq!(text(&mut f, "fixed_precision", u32::MAX), "1.250000");
    assert_eq!(text(&mut f, "fixed_precision", 0), "1");
    assert_eq!(f.number("power", 0), 1.0);
    assert_eq!(f.number("power", 6), 1e6);
    assert!(f.number("power", 38).is_finite());
    assert_eq!(f.number("power", 39), f64::INFINITY);
    assert_eq!(f.number("power", u32::MAX), f64::INFINITY);
    for entry in ["decimal", "fixed", "shown"] {
        for (value, want) in [
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
        ] {
            assert_eq!(text(&mut f, entry, value), want);
        }
    }
    assert_eq!(text(&mut f, "fixed", 1e8), "100000000.00");
    assert_eq!(text(&mut f, "decimal", 4e9), "4e9");
    assert_eq!(text(&mut f, "fixed", 4e9), "4.00e9");
    for value in [1e20, -1e20, f32::MAX as f64] {
        for entry in ["decimal", "fixed_six", "shown"] {
            let out = text(&mut f, entry, value);
            assert!(out.len() <= 16 && out.contains('e'));
            assert!((out.parse::<f64>().unwrap() / f32(value) - 1.0).abs() < 2e-6);
        }
    }
    for (at, want) in [(0u32, "ABC"), (1, "BC"), (3, ""), (4, ""), (u32::MAX, "")] {
        assert_eq!(text(&mut f, "rest", at), want);
    }
}
#[test]
fn authored_shader_noise_and_spline_weights() {
    let mut f = Fixture::new("tests/noise_authored.sq");
    for (input, want) in [
        ([0.1031, 33.33, 0.0, 0.0, 0.0], [0.0, -0.5]),
        (
            [0.1031, 33.33, 1.0, 2.0, 0.25],
            [0.93890380859375, 0.43890380859375],
        ),
        (
            [0.1031, 33.33, -3.75, 2.25, 0.5],
            [0.69140625, 0.2106461524963379],
        ),
        (
            [0.137, 17.5, 0.625, -1.25, 0.75],
            [0.231201171875, -0.388034850358963],
        ),
        (
            [0.137, 17.5, 123.125, 98.875, 1.0],
            [0.9384765625, 0.07835984230041504],
        ),
    ] {
        let out = f.floats("authored", input);
        assert_eq!(&out[..2], want);
        assert!(out[2..].iter().all(|x| *x >= 0.0));
        near(out[2..].iter().sum(), 1.0, 1e-7);
    }
    for sample in 0..=100 {
        let t = sample as f64 / 100.0;
        let a = f.floats("authored", [0.1031, 33.33, 0.0, 0.0, t]);
        let b = f.floats("authored", [0.1031, 33.33, 0.0, 0.0, 1.0 - t]);
        for i in 0..4 {
            near(a[2 + i], b[5 - i], 1e-7);
        }
    }
}
#[test]
fn rigid_optimizations_preserve_every_output_bit() {
    let mut f = Fixture::new("tests/perf/rigid-costs.sq");
    for count in [0, 1, 31, 128, 512, 2048] {
        for (a, b) in [
            ("accelerated", "original"),
            ("vector", "original"),
            ("bounce_fixed", "bounce_original"),
        ] {
            let bits = |xs: Vec<f64>| {
                xs.into_iter()
                    .map(|x| (x as f32).to_bits())
                    .collect::<Vec<_>>()
            };
            let left = bits(f.floats(a, count));
            let right = bits(f.floats(b, count));
            assert_eq!(left, right, "{a}, {count}");
        }
    }
}
