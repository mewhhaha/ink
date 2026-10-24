use super::*;
pub fn turn(axis: [f64; 3], angle: f64) -> [f64; 4] {
    let s = (angle / 2.0).sin() / axis.iter().map(|x| x * x).sum::<f64>().sqrt();
    [axis[0] * s, axis[1] * s, axis[2] * s, (angle / 2.0).cos()]
}
pub fn multiply(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    let [x, y, z, w] = a;
    let [i, j, k, l] = b;
    [
        w * i + x * l + y * k - z * j,
        w * j - x * k + y * l + z * i,
        w * k + x * j - y * i + z * l,
        w * l - x * i - y * j - z * k,
    ]
}
pub fn between(a: [f64; 4], b: [f64; 4]) -> f64 {
    let q = multiply([-a[0], -a[1], -a[2], a[3]], b);
    2.0 * q[..3]
        .iter()
        .map(|x| x * x)
        .sum::<f64>()
        .sqrt()
        .atan2(q[3].abs())
}
fn slerp(f: &mut Fixture, a: [f64; 4], b: [f64; 4], t: f64) -> [f64; 4] {
    f.floats("slerp", [a.to_vec(), b.to_vec(), vec![t]].concat())
        .try_into()
        .unwrap()
}
#[test]
fn easing_endpoints_mirrors_steps_and_rounding() {
    let mut f = Fixture::new("tests/tween.blot");
    let below = f32(1.0 - 2f64.powi(-24));
    for t in [f64::NEG_INFINITY, -1.0, -1e-30, 0.0, f64::NAN] {
        assert_eq!(f.floats("eases", t), vec![0.0; 12]);
    }
    for t in [1.0, 1.5, 2.0, 1e30, f64::INFINITY] {
        assert_eq!(f.floats("eases", t), vec![1.0; 12]);
    }
    let mid = f.floats("eases", 0.5);
    assert_eq!(&mid[..6], [0.5, 0.5, 0.5, 0.125, 0.875, 0.5]);
    near(mid[6], 1.0 + 2.70158 * -0.125 + 1.70158 * 0.25, 1e-6);
    assert_eq!(&mid[7..], [0.0, 0.5, 0.0, 0.0, f32(1.0 / 3.0)]);
    for t in [0.1, 0.25, 0.4, 0.6, 0.9] {
        let a = f.floats("eases", t);
        let b = f.floats("eases", 1.0 - t);
        for (i, j) in [(4, 3), (3, 4), (5, 5), (1, 1), (2, 2)] {
            near(a[i], 1.0 - b[j], 1e-6);
        }
        assert!(a[6] > a[4]);
    }
    assert!(f.floats("eases", 0.25)[6] < 1.0);
    assert!(f.floats("eases", 0.6)[6] > 1.09);
    for t in [0.999, 0.9999, below] {
        let mut values = f.floats("eases", t);
        values.remove(6);
        assert!(values.iter().all(|v| *v < 1.0));
    }
    let out = f.floats("eases", below);
    assert_eq!(&out[1..3], [below, below]);
    assert_eq!(out[4], below);
    assert_eq!(&out[7..], [0.0, 0.75, 0.0, 0.0, f32(2.0 / 3.0)]);
    for i in 0..40 {
        let t = f32(i as f64 / 40.0);
        let a = f.floats("eases", t);
        assert_eq!(a[8], f32(t * 4.0).floor() / 4.0);
        assert_eq!(a[11], f32(f32(t * 3.0).floor() / 3.0));
        assert_eq!([a[7], a[9], a[10]], [0.0; 3]);
    }
}
#[test]
fn tweens_spans_zero_duration_redirection_reversal_and_custom_values() {
    let mut f = Fixture::new("tests/tween.blot");
    for [time, value, progress, done] in [
        [0.0, 2.0, 0.0, 0.0],
        [2.0, 2.0, 0.0, 0.0],
        [3.0, 4.0, 0.25, 0.0],
        [4.0, 6.0, 0.5, 0.0],
        [5.5, 9.0, 0.875, 0.0],
        [6.0, 10.0, 1.0, 1.0],
        [7.0, 10.0, 1.0, 1.0],
    ] {
        assert_eq!(
            f.floats("scalar", [2.0, 4.0, time]),
            [1.0, value, progress, done, 6.0]
        );
    }
    assert_eq!(
        f.floats("scalar", [2.0, 0.0, f32(1.999)]),
        [1.0, 2.0, 0.0, 0.0, 2.0]
    );
    for time in [2.0, 5.0] {
        assert_eq!(
            f.floats("scalar", [2.0, 0.0, time]),
            [1.0, 10.0, 1.0, 1.0, 2.0]
        );
    }
    for [start, duration] in [
        [f64::NAN, 1.0],
        [f64::INFINITY, 1.0],
        [f64::NEG_INFINITY, 1.0],
        [0.0, f64::NAN],
        [0.0, f64::INFINITY],
        [0.0, -1.0],
        [0.0, -1e-30],
        [3e38, 3e38],
    ] {
        assert_eq!(f.floats("scalar", [start, duration, 0.0]), [0.0]);
    }
    assert_eq!(f.floats("scalar", [-5.0, 1e30, -5.0])[0], 1.0);
    assert_eq!(f.floats("scalar", [3e38, 0.0, 3e38])[0], 1.0);
    for at in [0.0, 1.0, 2.5, 4.0, 5.0] {
        let r = f.floats("toward", [at, at]);
        assert_eq!([r[0], r[4], r[5], r[7]], [1.0, at, 2.0, 20.0]);
        assert_eq!(r[2], r[1]);
        assert_eq!(r[6], r[1]);
        near(
            f.floats("toward", [at, at + 1.0])[3],
            r[1] + (20.0 - r[1]) * 0.875,
            1e-5,
        );
        assert_eq!(f.floats("toward", [at, at + 2.0])[3], 20.0);
    }
    assert_eq!(f.floats("toward", [1.0, 1.0])[1], 1.5625);
    assert_eq!(f.floats("toward", [f64::NAN, 0.0]), [0.0]);
    for time in [0.0, 1.0, 1.5, 2.0, 2.75, 3.0, 4.0] {
        let r = f.floats("reversed", [0.0, time]);
        assert_eq!(&r[2..], [10.0, 0.0, 1.0, 2.0]);
        near(r[1], f.floats("reversed", [0.0, 4.0 - time])[0], 1e-5);
        near(r[1], 10.0 - r[0], 1e-5);
        let r = f.floats("reversed", [1.0, time]);
        near(r[1], 10.0 - r[0], 1e-5);
    }
    assert_eq!(&f.floats("reversed", [1.0, 1.5])[..2], [0.15625, 9.84375]);
    for time in [-1.0, 0.0, 0.5, 0.999, f32(1.0 - 2f64.powi(-24))] {
        assert_eq!(f.number("variant", [1.0, time, 0.0]), 0.0);
    }
    for time in [1.0, 2.0] {
        assert_eq!(f.number("variant", [1.0, time, 0.0]), 2.0);
    }
    for (input, want) in [
        ([0.0, -0.001, 0.0], 0.0),
        ([0.0, 0.0, 0.0], 2.0),
        ([1.0, 0.3, 1.0], 0.0),
        ([1.0, 0.5, 1.0], 2.0),
    ] {
        assert_eq!(f.number("variant", input), want);
    }
    for time in [0.0, 1.0, 2.0, 2.9, 2.999, f32(2.99999)] {
        assert_eq!(f.number("count", [1.0, 2.0, time]), 3.0);
    }
    for (input, want) in [
        ([1.0, 2.0, 3.0], 7.0),
        ([1.0, 0.0, 1.0], 7.0),
        ([1.0, 0.0, 0.5], 3.0),
    ] {
        assert_eq!(f.number("count", input), want);
    }
    for (time, want) in [
        (-1.0, [0.0, 0.0, 0.0]),
        (0.5, [0.5, -1.0, 1.5]),
        (1.0, [1.0, -2.0, 3.0]),
        (3.0, [2.0, -4.0, 6.0]),
    ] {
        assert_eq!(f.floats("vector", time), want);
    }
    for (time, want) in [(-1.0, [0.0, 1.0]), (1.0, [4.0, 1.0]), (2.0, [8.0, 1.0])] {
        assert_eq!(f.floats("gauge", time), want);
    }
}
#[test]
fn spherical_interpolation_constant_speed_short_arcs_and_eased_progress() {
    let mut f = Fixture::new("tests/tween.blot");
    let id = [0.0, 0.0, 0.0, 1.0];
    for (a, b) in [
        (id, turn([0.0, 1.0, 0.0], 2.0)),
        (turn([1.0, 2.0, 3.0], 0.7), turn([-2.0, 1.0, 0.5], 2.9)),
        (turn([0.0, 0.0, 1.0], -1.0), turn([0.0, 0.0, 1.0], 1.5)),
    ] {
        let total = between(a, b);
        for t in [0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0] {
            let q = slerp(&mut f, a, b, t);
            near(q.iter().map(|x| x * x).sum::<f64>().sqrt(), 1.0, 1e-6);
            near(between(a, q), total * t, 2e-4);
            near(between(q, b), total * (1.0 - t), 2e-4);
            near_all(&slerp(&mut f, a, b.map(|x| -x), t), &q, 1e-6);
        }
    }
    let far = turn([0.0, 1.0, 0.0], 300.0 * std::f64::consts::PI / 180.0);
    near(
        between(
            slerp(&mut f, id, far, 0.5),
            turn([0.0, 1.0, 0.0], -std::f64::consts::PI / 6.0),
        ),
        0.0,
        2e-4,
    );
    let a = turn([0.0, 1.0, 0.0], 0.3);
    let b = turn([0.0, 1.0, 0.0], 0.31);
    let q = slerp(&mut f, a, b, 0.5);
    near(q.iter().map(|x| x * x).sum::<f64>().sqrt(), 1.0, 1e-6);
    near(between(q, turn([0.0, 1.0, 0.0], 0.305)), 0.0, 1e-3);
    near(between(slerp(&mut f, a, a, 0.4), a), 0.0, 1e-3);
    assert_eq!(slerp(&mut f, id, [0.0, 0.0, 0.0, -1.0], 0.5), id);
    for angle in [0.062, 0.0645] {
        near(
            between(id, slerp(&mut f, id, turn([0.0, 1.0, 0.0], angle), 0.25)),
            angle * 0.25,
            1e-6,
        );
    }
    let target = turn([0.0, 1.0, 0.0], 2.0);
    for t in [0.0, 0.25, 0.5, 1.0] {
        let linear = f.floats("turning", [2.0, 0.0, t]).try_into().unwrap();
        near(between(linear, slerp(&mut f, id, target, t)), 0.0, 1e-3);
        let smooth = f.floats("turning", [2.0, 1.0, t]).try_into().unwrap();
        near(between(id, smooth), 2.0 * t * t * (3.0 - 2.0 * t), 2e-4);
    }
}
