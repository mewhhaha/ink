use crate::tween::{multiply, turn};
use crate::*;
fn between(w: f64) -> Vec<f64> {
    let mut v = vec![4. * w, 2. * w, -8. * w];
    v.extend(turn([0., 1., 0.], std::f64::consts::FRAC_PI_2 * w));
    v.push(4f64.powf(w));
    v
}
fn flagged(flag: f64, v: Vec<f64>) -> Vec<f64> {
    std::iter::once(flag).chain(v).collect()
}
#[test]
fn cuts_blends_interruptions_and_live_shots() {
    let mut f = Fixture::new("tests/director.blot");
    let shots = (1..=3).map(|i| f.floats("shot", i)).collect::<Vec<_>>();
    assert_eq!(f.floats("cut", ()), flagged(0., shots[2].clone()));
    for (x, flag, s) in [
        ([0., 2., 0., 0.], 1., 0),
        ([0., 2., 1., 1.], 0., 1),
        ([0., 2., 1.5, 1.5], 0., 1),
    ] {
        assert_eq!(f.floats("blended", x), flagged(flag, shots[s].clone()));
    }
    near_all(
        &f.floats("blended", [0., 2., 1.9375, 0.]),
        &flagged(1., between(1.9375 / 2.)),
        2e-6,
    );
    let half = f.floats("blended", [0., 2., 1., 0.]);
    near_all(&half, &flagged(1., between(0.5)), 2e-6);
    assert_eq!(f.floats("blended", [0., 2., 0.5, 0.5]), half);
    near_all(
        &f.floats("blended", [0., 2., 0.25, 0.25])[1..],
        &between(0.25),
        2e-6,
    );
    let u = -0.75f64;
    for (kind, w) in [
        0.25,
        0.15625,
        0.103515625,
        0.015625,
        0.578125,
        0.0625,
        1. + 2.70158 * u.powi(3) + 1.70158 * u * u,
        0.,
        0.25,
    ]
    .into_iter()
    .enumerate()
    {
        near_all(
            &f.floats("blended", [kind as f64, 2., 0.5, 0.]),
            &flagged(1., between(w)),
            2e-6,
        )
    }
    assert_eq!(
        f.floats("blended", [7., 2., 1.5, 0.]),
        flagged(1., shots[0].clone())
    );
    for first in [0.25, 0.5, 1., 1.75, 1.9990234375] {
        let r = f.floats("interrupted", [first, 0.]);
        assert_eq!(&r[8..16], &r[..8]);
        assert_eq!(&r[16..24], &r[..8]);
        assert_eq!(&r[24..], &[2., 1.]);
        let x = first / 2.;
        near_all(&r[..3], &between(x * x * (3. - 2. * x))[..3], 2e-6);
        near_all(
            &f.floats("interrupted", [first, 0.001])[16..24],
            &r[..8],
            1e-5,
        );
        assert_eq!(
            &f.floats("interrupted", [first, 1.])[16..],
            &[shots[2].clone(), vec![2., 0.]].concat()
        );
    }
    for (input, p, angle, zoom) in [
        ([0.5, 10.], [4.5, 1., -4.], std::f64::consts::FRAC_PI_4, 2.),
        (
            [0.25, -4.],
            [0.25, 0.5, -2.],
            std::f64::consts::PI / 8.,
            2f64.sqrt(),
        ),
    ] {
        near_all(
            &f.floats("live", input),
            &[p.to_vec(), turn([0., 1., 0.], angle).to_vec(), vec![zoom]].concat(),
            2e-6,
        )
    }
    for x in [[0., 0.], [2., 0.5]] {
        assert_eq!(f.floats("accepted", x), vec![1., 1.]);
    }
    for x in [-1., f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert_eq!(f.floats("accepted", [x, 0.]), vec![0., 1.]);
        assert_eq!(f.floats("accepted", [1., x]), vec![1., 0.]);
    }
    let r = f.floats("unchanged", ());
    assert_eq!(&r[16..32], &r[..16]);
    assert_eq!(&r[32..], &flagged(0., shots[2].clone()));
}
#[test]
fn director_save_validation_and_full_width_shot_ids() {
    let mut f = Fixture::new("tests/director.blot");
    let r = f.floats("saved", ());
    assert_eq!(&r[..48], &r[48..]);
    let settled = vec![
        7., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0.,
    ];
    let live = vec![
        9., 0., 1., 7., 0., 0., 0., 0., 0., 0., 0., 0.25, 1.5, 8., 5., 0.,
    ];
    assert_eq!(&r[..16], &settled);
    assert_eq!(&r[16..32], &live);
    let frozen = r[32..48].to_vec();
    assert_eq!(&frozen[..3], &[3., 0., 2.]);
    assert_eq!(&frozen[11..], &[0., 3., 5., 0., 0.]);
    near_all(
        &frozen[3..11],
        &between(1. + 2.70158 * (-0.75f64).powi(3) + 1.70158 * 0.75f64.powi(2)),
        4e-6,
    );
    for id in [1u32, 65535, 65536, 16777217, 0xfffffffe, 0xffffffff] {
        assert_eq!(f.number("saved_shot", id), id as f64)
    }
    for v in [&live, &settled, &frozen] {
        assert_eq!(f.number("decode", v.as_slice()), v[11]);
    }
    f.traps("decode", live[..15].to_vec());
    f.traps("decode", [live.clone(), vec![0.]].concat());
    for (v, i, x) in [
        (&live, 0, 65536.),
        (&live, 2, 3.),
        (&live, 5, 1.),
        (&live, 11, 1.5),
        (&live, 11, -0.25),
        (&live, 12, f64::NAN),
        (&live, 13, 9.),
        (&live, 13, 0.),
        (&settled, 11, 0.5),
        (&settled, 12, 1.),
        (&settled, 4, 1.),
        (&settled, 14, 2.),
        (&frozen, 10, 0.),
        (&frozen, 9, 0.5),
        (&frozen, 3, f64::INFINITY),
    ] {
        let mut v = v.clone();
        v[i] = x;
        f.traps("decode", v);
    }
}
#[test]
fn camera_space_shake_tweens_zoom_and_lens() {
    let mut f = Fixture::new("tests/director.blot");
    let still = f.floats("shot", 2);
    assert_eq!(f.floats("shaken", [0.; 6]), still);
    assert_eq!(&f.floats("settled_shake", 0.)[6..], &still);
    assert_eq!(
        f.floats("shaken", [1., 0., 0., 0., 0., 0.]),
        [vec![4., 2., -9.], still[3..].to_vec()].concat()
    );
    near_all(
        &f.floats("shaken", [0., 0., 0., 0., 0.1, 0.]),
        &[
            vec![4., 2., -8.],
            turn([0., 1., 0.], std::f64::consts::FRAC_PI_2 + 0.1).to_vec(),
            vec![4.],
        ]
        .concat(),
        2e-6,
    );
    let r = f.floats("settled_shake", 0.05);
    let angle = r[3..6].iter().map(|x| x * x).sum::<f64>().sqrt();
    assert!(angle > 0.001 && r[..3].iter().map(|x| x * x).sum::<f64>().sqrt() > 0.01);
    let q: [f64; 4] = still[3..7].try_into().unwrap();
    let p = multiply(
        multiply(q, [r[0], r[1], r[2], 0.]),
        [-q[0], -q[1], -q[2], q[3]],
    );
    near_all(
        &r[6..],
        &[
            vec![4. + p[0], 2. + p[1], -8. + p[2]],
            multiply(q, turn(r[3..6].try_into().unwrap(), angle)).to_vec(),
            vec![4.],
        ]
        .concat(),
        2e-6,
    );
    let half = f.floats("tweened", 2);
    assert_eq!(&half[..8], &half[8..]);
    for i in [0, 1] {
        assert_eq!(&f.floats("tweened", i)[..8], &f.floats("shot", 1));
    }
    assert_eq!(&f.floats("tweened", 3)[..8], &f.floats("shot", 3));
    near_all(&half[..3], &[-1., 3., 1.], 2e-6);
    near(half[7], 2f64.sqrt(), 2e-6);
    for (a, b, t, expected, tol) in [
        (1., 4., 0.5, 2., 2e-6),
        (4., 1., 0.5, 2., 2e-6),
        (2., 8., 0.25, 2. * 2f64.sqrt(), 4e-6),
        (20., 1., 1.1, 20. * 0.05f64.powf(1.1), 1e-5),
        (1., 20., 1.1, 20f64.powf(1.1), 1e-4),
        (1., 20., -0.1, 20f64.powf(-0.1), 1e-6),
        (4., 1., 0., 4., 0.),
        (4., 1., 1., 1., 0.),
        (-1., 2., 0.5, 0.5, 0.),
        (0., 2., 0.25, 0.5, 0.),
    ] {
        near(f.number("zoom", [a, b, t]), expected, tol)
    }
    let r = f.floats("lens", ());
    assert_eq!(&r[..3], &[4., 0.25, 500.]);
    assert_eq!(&r[3..7], &r[7..11]);
    assert_eq!(&r[3..5], &[2., 4.]);
    assert_eq!(r[11], 4.);
    near_all(&r[12..], &[-8., -2., -4.], 2e-6);
}
