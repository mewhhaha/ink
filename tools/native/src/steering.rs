use crate::*;
#[test]
fn seek_separate_perceive_and_local_crowds() {
    let mut f = Fixture::new("tests/steering.blot");
    let r = f.floats("motion", [0., 0., 0., 3., 0., 4., 10., 10., 0.]);
    for (i, v) in [(0, 6.), (2, 8.), (3, 3.), (5, 4.), (6, 3.)] {
        near(r[i], v, 1e-5)
    }
    assert_eq!(
        f.floats("motion", [0., 0., 0., 0., 0., 0., 10., 10., 0.]),
        vec![0.; 7]
    );
    assert_eq!(
        f.floats("separation", [-1., 0., 0., 1., 0., 0., 0., 0., 0.]),
        vec![0.; 3]
    );
    near(f.floats("separation", [0.01, 0., 0.])[0], -5., 1e-5);
    for (x, w) in [
        ([1., 0., 1., 3., 0.7], 1.),
        ([-1., 0., 0., 3., 0.7], 0.),
        ([4., 0., 0., 3., 0.7], 0.),
    ] {
        assert_eq!(f.number("cone", x), w)
    }
    for (x, w) in [(0, 1.), (1, 0.), (2, 1.)] {
        assert_eq!(f.number("perception", x), w)
    }
    for x in [
        [400., 7., 30., 2.5, 2.5],
        [400., 9., 30., 2.5, 0.7],
        [300., 11., 200., 6., 1.],
        [50., 13., 1., 2., 0.],
    ] {
        let r = f.floats("grid_query", x);
        assert_eq!(r[0], 0.);
        assert!(r[1] >= x[0] - 1.);
        assert!(r[2] <= (x[0] - 1.) * 4. + 64.);
        assert_eq!(r[3], x[0] - 1.);
    }
    for (name, n) in [("crowd", 1000), ("flock_step", 10000)] {
        if name == "flock_step" {
            f.number(name, 1000);
        }
        let start = std::time::Instant::now();
        let r = f.number(name, n);
        assert!(r.is_finite() && r > 0.);
        assert!(start.elapsed().as_secs_f64() < 1.);
    }
}
#[test]
fn flock_rules_limits_and_replay() {
    let mut f = Fixture::new("tests/steering.blot");
    near_all(
        &f.floats("rules", 0),
        &[1.5, 0., 0., 3. / 2f64.sqrt(), 3. / 2f64.sqrt(), 0.],
        1e-5,
    );
    let r = f.floats("neighbours", 16);
    near_all(&r[..7], &[2., 0.5, 1.5, 1., 1., -2., 4.], 1e-5);
    assert_eq!(r[8], 0.);
    assert_eq!(f.floats("neighbours", 1)[0], 1.);
    for i in [0, 1, 3413, 3414, 4095, 4096, 10007] {
        let r = f.floats("stacked", i);
        assert!(r.iter().all(|x| x.is_finite()));
        near(r[..3].iter().map(|x| x * x).sum::<f64>().sqrt(), 4., 1e-4);
        assert_eq!(&r[6..], &[0., 0., 0.]);
    }
    let free = f.floats("limited", [2., 100., 100., 100., 4., 0.1]);
    near(free[0], 0.8, 1e-5);
    near(free[2], 0.4, 1e-5);
    let r = f.floats("limited", [2., 1., 100., 100., 4., 0.1]);
    near((r[0] - 1.).hypot(r[2]), 0.1, 1e-5);
    let r = f.floats("limited", [100., 1000., 100., 0.5, 4., 0.1]);
    near(r[2].atan2(r[0]), 0.05, 1e-4);
    let r = f.floats("limited", [0.1, 100., 100., 100., 0.3, 0.1]);
    near(r[0].atan2(r[2]), 0.3, 1e-4);
    let r = f.floats("limited", [2., 100., 0.25, 100., 4., 0.1]);
    near(r[0].hypot(r[2]), 0.25, 1e-5);
    let args = [150., 150., 5., 0.3, 3., 0.2, 1.5];
    let r = f.floats("boids", args);
    assert!(r[0].abs() < 0.2 && r[1] > 0.8 && r[2] >= 0. && r[3] > 0.3);
    assert_eq!(f.floats("boids", args), r);
    assert!(f.floats("boids", [150., 150., 5., 0.3, 0., 0., 0.])[1] < 0.3);
}
#[test]
fn obstacle_avoidance_slides_filters_and_stays_finite() {
    let mut f = Fixture::new("tests/steering.blot");
    for x in [
        [0., 0., 0., 0., 0., 1., 0.5, 1., 0.],
        [0., 0., 0., 1., 0., 0., 0.3, 0.5, 0.],
        [0., 0., 10., 2., 0., 0., 0.5, 1., 4.],
    ] {
        assert_eq!(f.floats("avoidance", x), vec![0.; 3]);
    }
    assert!(f.floats("avoidance", [0., 0., 10., 0., -2., 0., 0.5, 1., 4.])[1] > 0.);
    for variant in 1..=3 {
        assert_eq!(
            f.floats(
                "avoidance",
                [0., 0., 0., 2., 0., 0., 0.5, 2., variant as f64]
            ),
            vec![0.; 3]
        );
    }
    let x = [0., 0., 0., 2., 0., 0., 0.5, 2., 0.];
    let r = f.floats("avoidance", x);
    near_all(&r, &[-3., 0., 1.5], 1e-5);
    assert_eq!(f.floats("avoidance", x), r);
    let r = f.floats("avoidance", [-6., 0., 0., 0., 0., -2., 0.5, 2., 0.]);
    near(r[0], 1., 1e-5);
    near(r[2], 2., 1e-5);
    assert!(
        f.floats(
            "avoidance",
            [0., 0., 0., 2., 0., 0., 0.5, 2., 0., 2., 0., -0.5]
        )[2] < 0.
    );
    assert!(
        f.floats(
            "avoidance",
            [0., 0., 0., 2., 0., 0.5, 0.5, 2., 0., 2., 0., -0.5]
        )[2] > 0.
    );
    let a = f.floats("avoidance", [0., 0., 0., 1., 0., 1., 0.5, 2., 0.]);
    assert!(1. + a[0] <= 0. && 1. + a[2] > 1.);
    let b = f.floats("avoidance", [-0.5, 0., 0., 1., 0., 1., 0.5, 2., 0.]);
    near(b[0], a[0] / 2., 1e-5);
    near(b[2], a[2] / 2., 1e-5);
    assert!(1. + f.floats("avoidance", [1.6, 0., 0., 1., 0., 0., 0.3, 1., 0.])[0] < 0.);
    assert_eq!(
        f.floats("avoidance", [1.6, 0., 0., -1., 0., 0., 0.3, 1., 0.]),
        vec![-1., 0., 0.]
    );
    let n = f64::NAN;
    for x in [
        vec![0., 0., 0., n, 0., 0., 0.5, 1., 0.],
        vec![f64::INFINITY, 0., 0., 1., 0., 0., 0.5, 1., 0.],
        vec![0., 0., 0., 1., 0., 0., 0.5, n, 0.],
        vec![0., 0., 0., 1., 0., 0., n, 1., 0.],
        vec![0., 0., 0., 2., 0., 0., 0.5, 2., 0., n, 0., 0.],
        vec![0., 0., 0., 3e38, 3e38, 0., 0.5, 1., 0.],
        vec![1.6, 0., 0., 0., 0., 0., 0.5, 1., 0.],
    ] {
        assert_eq!(f.floats("avoidance", x), vec![0.; 3]);
    }
    let x = [240., 0., 0.8, -5., 0.];
    let a = f.floats("detour", x);
    let b = f.floats("detour", [240., 0., 0.8, -5., -0.4, -5.6, 0., -5., 0.4]);
    for r in [&a, &b] {
        assert!(r[0] > 0.3 && r[1] < 0.6)
    }
    assert_eq!(f.floats("detour", x), a);
    assert!(f.floats("detour", [240., 0., 0., -5., 0.])[0] < 0.);
}
