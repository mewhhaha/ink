use crate::*;
type V = [f64; 3];
fn sub(a: &[f64], b: &[f64]) -> V {
    std::array::from_fn(|i| a[i] - b[i])
}
fn add(a: V, b: V) -> V {
    std::array::from_fn(|i| a[i] + b[i])
}
fn norm(v: &[f64]) -> f64 {
    v.iter().map(|x| x * x).sum::<f64>().sqrt()
}
fn unit(v: V) -> V {
    let n = norm(&v);
    v.map(|x| x / n)
}
fn dot(a: V, b: V) -> f64 {
    (0..3).map(|i| a[i] * b[i]).sum()
}
fn forward(q: &[f64]) -> V {
    let (x, y, z, w) = (q[0], q[1], q[2], q[3]);
    [
        -2. * (x * z + w * y),
        -2. * (y * z - w * x),
        -(1. - 2. * (x * x + y * y)),
    ]
}
fn rules(turns: f64, dead: f64, ahead: f64, rate: f64) -> Vec<f64> {
    vec![0., 2., 5., turns, dead, ahead, 8., 1., rate]
}
fn follow(f: &mut Fixture, r: Vec<f64>, dt: f64, steps: &[[f64; 7]]) -> Vec<Vec<f64>> {
    let v = f.floats(
        "following",
        [r, vec![(steps.len() - 1) as f64, dt], steps.concat()].concat(),
    );
    assert_eq!(v[0], 0.);
    assert_eq!((v.len() - 1) % 16, 0);
    v[1..].chunks(16).map(|x| x.to_vec()).collect()
}
#[test]
fn look_at_degenerate_axes_and_exponential_turning() {
    let mut f = Fixture::new("tests/rig.sq");
    near_all(
        &f.floats("look", [0., 0., 0., 0., 0., -5., 0., 1., 0.])[3..7],
        &[0., 0., 0., 1.],
        1e-6,
    );
    let v = f.floats("look", [1., 2., 3., 4., -1., 7., 0., 1., 0.]);
    assert_eq!(&v[..3], &[1., 2., 3.]);
    near_all(&v[7..10], &unit([3., -3., 4.]), 1e-5);
    assert!(v[11] > 0.);
    near(
        v[10..13].iter().zip(&v[7..10]).map(|(a, b)| a * b).sum(),
        0.,
        1e-5,
    );
    assert_eq!(
        &f.floats("look", [1., 1., 1., 1., 1., 1., 0., 1., 0.])[3..7],
        &[0., 0., 0., 1.]
    );
    let v = f.floats("look", [0., 0., 0., 0., 10., 0., 0., 1., 0.]);
    near_all(&v[7..10], &[0., 1., 0.], 1e-5);
    near(norm(&v[3..7]), 1., 1e-5);
    let once = f.floats("turning", [0., 1., 2., 0.5, 1.]);
    for steps in [7., 60.] {
        near_all(&f.floats("turning", [0., 1., 2., 0.5, steps]), &once, 2e-6)
    }
    near(2. * once[1].atan2(once[3]), 1. - (-1f64).exp(), 1e-5);
    for (rate, secs) in [(0., 0.5), (2., 0.), (f64::NAN, 0.5)] {
        assert_eq!(
            f.floats("turning", [0., 1., rate, secs, 1.]),
            vec![0., 0., 0., 1.]
        );
    }
    near_all(
        &f.floats("turning", [0., 1., f64::INFINITY, 0.5, 1.]),
        &[0., 0.5f64.sin(), 0., 0.5f64.cos()],
        1e-6,
    );
}
#[test]
fn followers_dead_zones_lookahead_and_turning() {
    let mut f = Fixture::new("tests/rig.sq");
    let states = follow(
        &mut f,
        rules(1., 0., 0., 6.),
        1. / 60.,
        &[[3., 1., -2., 0., 0., 0., 0.7]; 6],
    );
    let a = &states[0];
    near_all(
        &a[9..12],
        &[3. + 5. * 0.7f64.sin(), 3., -2. + 5. * 0.7f64.cos()],
        1e-5,
    );
    assert_eq!(&a[..3], &[3., 1., -2.]);
    assert_eq!(&a[6..9], &[3., 1., -2.]);
    near_all(
        &forward(&a[12..]),
        &unit(sub(&[3., 1., -2.], &a[9..12])),
        1e-5,
    );
    assert!(states.iter().all(|s| s == a));
    let steps = (0..250)
        .map(|i| {
            [
                if i < 10 { i as f64 * 0.1 } else { 1.5 },
                0.,
                0.,
                0.,
                0.,
                0.,
                0.,
            ]
        })
        .collect::<Vec<_>>();
    let s = follow(&mut f, rules(0., 1., 0., 6.), 1. / 60., &steps);
    assert!(s[..10].iter().all(|x| x == &s[0]));
    for r in &s[10..] {
        near_all(&r[..3], &[0.5, 0., 0.], 1e-6)
    }
    let r = s.last().unwrap();
    near_all(&r[6..9], &[0.5, 0., 0.], 1e-4);
    near_all(&r[9..12], &[0.5, 2., 5.], 1e-4);
    let steps = (0..181)
        .map(|i| [2. * i as f64 / 60., 0., 0., 2., 0., 0., 0.])
        .collect::<Vec<_>>();
    let s = follow(&mut f, rules(0., 0.25, 0.5, 6.), 1. / 60., &steps);
    for (i, r) in s.iter().enumerate() {
        near_all(
            &r[..3],
            &[if i >= 8 { steps[i][0] + 0.75 } else { 1. }, 0., 0.],
            1e-4,
        );
        near_all(&sub(&r[9..12], &r[6..9]), &[0., 2., 5.], 1e-4);
        near_all(&r[12..], &s[0][12..], 1e-5);
    }
    near_all(
        &s.last().unwrap()[6..9],
        &[steps[180][0] + 0.25, 0., 0.],
        1e-4,
    );
    let mut steps = vec![[0.; 7]; 301];
    for s in &mut steps[1..] {
        s[6] = std::f64::consts::FRAC_PI_2;
    }
    let s = follow(&mut f, rules(1., 0., 0., 4.), 1. / 60., &steps);
    let r = s.last().unwrap();
    near_all(&r[9..12], &[5., 2., 0.], 1e-4);
    near_all(&forward(&r[12..]), &unit([-5., -2., 0.]), 1e-4);
    let r = &s[8];
    let d = dot(forward(&r[12..]), unit(sub(&r[6..9], &r[9..12])));
    assert!(d > 0.9 && d < 0.9999);
}
#[test]
fn followers_agree_across_frame_rates_and_reject_invalid_settings() {
    let mut f = Fixture::new("tests/rig.sq");
    let mut last = Vec::new();
    for rate in [30, 120] {
        let steps = (0..=2 * rate)
            .map(|i| {
                let t = i as f64 / rate as f64;
                [
                    3. * t.cos(),
                    0.,
                    3. * t.sin(),
                    -3. * t.sin(),
                    0.,
                    3. * t.cos(),
                    -t,
                ]
            })
            .collect::<Vec<_>>();
        last.push(
            follow(&mut f, rules(1., 0.2, 0.3, 6.), 1. / rate as f64, &steps)
                .pop()
                .unwrap(),
        );
    }
    for range in [6..9, 9..12] {
        assert!(norm(&sub(&last[0][range.clone()], &last[1][range])) < 0.005);
    }
    assert!(dot(forward(&last[0][12..]), forward(&last[1][12..])) > 0.9999);
    for dt in [0., -1., f64::NAN, f64::INFINITY] {
        let s = follow(
            &mut f,
            rules(0., 0., 0., 6.),
            dt,
            &[[0.; 7], [5., 0., 0., 0., 0., 0., 0.]],
        );
        assert_eq!(s[0], s[1]);
    }
    let r = rules(0., 0., 0., 6.);
    assert_eq!(f.number("valid", r.clone()), 1.);
    for (i, x) in [
        (0, f64::NAN),
        (4, -1.),
        (5, -0.5),
        (6, f64::INFINITY),
        (7, -1.),
        (8, f64::NAN),
    ] {
        let mut r = r.clone();
        r[i] = x;
        assert_eq!(f.number("valid", r), 0.);
    }
}
fn framed(f: &mut Fixture, points: &[V], padding: f64, aspect: f64) -> Vec<f64> {
    f.floats(
        "framing",
        [
            vec![
                aspect,
                1. / (std::f64::consts::PI / 6.).tan(),
                padding,
                0.4,
                -0.3,
            ],
            points.concat(),
        ]
        .concat(),
    )
}
#[test]
fn framing_fits_tightly_padding_and_impossible_views() {
    let mut f = Fixture::new("tests/rig.sq");
    let cluster = [
        [0., 0., 0.],
        [3., 1., -2.],
        [-2., 4., 1.],
        [1., -1., 3.],
        [4., 2., 2.],
        [-1., 0., -4.],
    ];
    for aspect in [16. / 9., 0.5] {
        let r = framed(&mut f, &cluster, 0., aspect);
        assert_eq!(r[3], 0.);
        let w = aspect * 1000.;
        let mut slack = f64::INFINITY;
        for p in r[4..].chunks(2) {
            assert!(p[0] >= -0.002 && p[0] <= w + 0.002 && p[1] >= -0.002 && p[1] <= 1000.002);
            slack = slack.min(p[0]).min(w - p[0]).min(p[1]).min(1000. - p[1]);
        }
        assert!(slack < 0.002);
    }
    let aspect = 16. / 9.;
    let w = aspect * 1000.;
    let half_y = std::f64::consts::PI / 6.;
    let half_x = (aspect * half_y.tan()).atan();
    let mx = w / 2. * (1. - (half_x - 0.08).tan() / half_x.tan());
    let my = 500. * (1. - (half_y - 0.08).tan() / half_y.tan());
    let r = framed(&mut f, &cluster, 0.08, aspect);
    let mut slack = f64::INFINITY;
    for p in r[4..].chunks(2) {
        let sx = p[0].min(w - p[0]) - mx;
        let sy = p[1].min(1000. - p[1]) - my;
        assert!(sx > -0.002 && sy > -0.002);
        slack = slack.min(sx).min(sy);
    }
    assert!(slack < 0.002);
    let r = framed(&mut f, &[[2., 3., 4.]], 0., aspect);
    near_all(&r[4..6], &[w / 2., 500.], 0.01);
    let back = [
        -(-0.3f64).cos() * 0.4f64.sin(),
        (-0.3f64).sin(),
        -(-0.3f64).cos() * 0.4f64.cos(),
    ]
    .map(|x| x * -0.1);
    near_all(&r[..3], &add([2., 3., 4.], back), 1e-5);
    assert!(framed(&mut f, &[], 0., aspect).is_empty());
    for padding in [half_y, 0.6, 2., f64::INFINITY, -0.1] {
        assert!(framed(&mut f, &cluster, padding, aspect).is_empty());
    }
    assert!(framed(&mut f, &cluster, 0., 0.).is_empty());
    for points in [
        [[0., 0., 0.], [f64::NAN, 0., 0.]],
        [[-2000., 0., 0.], [2000., 0., 0.]],
    ] {
        assert!(framed(&mut f, &points, 0., aspect).is_empty());
    }
}
#[test]
fn camera_collision_and_spline_dolly() {
    let mut f = Fixture::new("tests/rig.sq");
    assert_eq!(
        f.floats("collision", [0., 0., 0., 0., 0.5, 4., 0.3, 0.]),
        vec![0., 0.5, 4.]
    );
    let r = f.floats("collision", [0., 0., 0., 4., 0., 0., 0.3, 0.]);
    near_all(&r, &[1.2, 0., 0.], 1e-3);
    assert!(r[0] <= f32(1.2));
    let r = f.floats("collision", [0., 0.5, 0., 4., 0.5, 2., 0.3, 0.]);
    near(r[0], 1.2, 1e-3);
    near(r[2], r[0] / 2., 1e-5);
    for variant in [1., 2., 3.] {
        assert_eq!(
            f.floats("collision", [0., 0., 0., 4., 0., 0., 0.3, variant]),
            vec![4., 0., 0.]
        );
    }
    near_all(
        &f.floats("collision", [-3., 1., 0., -3., -3., 0., 0.3, 0.]),
        &[-3., -0.7, 0.],
        1e-3,
    );
    assert_eq!(
        f.floats("collision", [-3., 1., 0., -3., -3., 0., 0.3, 4.]),
        vec![-3., -3., 0.]
    );
    assert_eq!(
        f.floats("collision", [2., 0., 0., -2., 0., 0., 0.3, 0.]),
        vec![2., 0., 0.]
    );
    assert_eq!(
        f.floats("collision", [f64::NAN, 0., 0., 4., 0., 0., 0.3, 0.]),
        vec![4., 0., 0.]
    );
    for d in [0., 2., 5.5, 9., 100.] {
        let r = f.floats("dollying", [0., d]);
        near_all(&r[7..10], &r[13..16], 1e-5);
        assert!(r[11] > 0.);
    }
    assert_eq!(&f.floats("dollying", [0., 0.])[..3], &[0.; 3]);
    let r = f.floats("dollying", [1., 6., 2., 5., 0.]);
    near_all(&r[7..10], &unit(sub(&[2., 5., 0.], &r[..3])), 1e-5);
    let along = f.floats("dollying", [0., 6.]);
    let aimed = f.floats("dollying", [vec![1., 6.], along[..3].to_vec()].concat());
    near_all(&aimed[3..7], &along[3..7], 1e-6);
    let fixed = f.floats("dollying", [2., 3., 0.3, -0.2]);
    near_all(
        &fixed[7..10],
        &[
            -(-0.2f64).cos() * 0.3f64.sin(),
            (-0.2f64).sin(),
            -(-0.2f64).cos() * 0.3f64.cos(),
        ],
        1e-5,
    );
    assert_eq!(&fixed[..3], &f.floats("dollying", [0., 3.])[..3]);
}
