use super::*;
const ID2: [f64; 6] = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
const ID3: [f64; 12] = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
pub fn vector(basis: &[f64], v: &[f64], d: usize) -> Vec<f64> {
    (0..d)
        .map(|r| (0..d).map(|c| basis[d + c * d + r] * v[c]).sum())
        .collect()
}
pub fn point(basis: &[f64], v: &[f64], d: usize) -> Vec<f64> {
    vector(basis, v, d)
        .iter()
        .enumerate()
        .map(|(i, x)| x + basis[i])
        .collect()
}
pub fn compose(parent: &[f64], child: &[f64], d: usize) -> Vec<f64> {
    let mut out = point(parent, &child[..d], d);
    for c in 0..d {
        out.extend(vector(parent, &child[d + c * d..d + c * d + d], d));
    }
    out
}
fn pose2(v: &[f64]) -> Vec<f64> {
    let [x, y, a, sx, sy]: [f64; 5] = v.try_into().unwrap();
    vec![
        x,
        y,
        a.cos() * sx,
        a.sin() * sx,
        -a.sin() * sy,
        a.cos() * sy,
    ]
}
fn pose3(v: &[f64]) -> Vec<f64> {
    let [px, py, pz, x, y, z, w, sx, sy, sz]: [f64; 10] = v.try_into().unwrap();
    vec![
        px,
        py,
        pz,
        (1.0 - 2.0 * (y * y + z * z)) * sx,
        2.0 * (x * y + z * w) * sx,
        2.0 * (x * z - y * w) * sx,
        2.0 * (x * y - z * w) * sy,
        (1.0 - 2.0 * (x * x + z * z)) * sy,
        2.0 * (y * z + x * w) * sy,
        2.0 * (x * z + y * w) * sz,
        2.0 * (y * z - x * w) * sz,
        (1.0 - 2.0 * (x * x + y * y)) * sz,
    ]
}
fn args(parts: &[&[f64]]) -> Vec<f64> {
    parts.concat()
}
#[test]
fn affine_transforms_preserve_shear_reflection_and_inverses() {
    let mut f = Fixture::new("tests/transform.blot");
    near_all(&f.floats("identity", [0.0]), &args(&[&ID2, &ID3]), 1e-5);
    near_all(
        &f.floats("affine2", args(&[&ID2, &ID2, &[3.0, -4.0]]))[6..10],
        &[3.0, -4.0, 3.0, -4.0],
        1e-5,
    );
    near_all(
        &f.floats("affine3", args(&[&ID3, &ID3, &[3.0, -4.0, 5.0]]))[12..18],
        &[3.0, -4.0, 5.0, 3.0, -4.0, 5.0],
        1e-5,
    );
    let pi = std::f64::consts::PI;
    let half = std::f64::consts::FRAC_1_SQRT_2;
    for (parent_pose, child_pose, p, d) in [
        (
            vec![10.0, 20.0, pi / 2.0, 2.0, 3.0],
            vec![1.0, 2.0, pi / 4.0, 4.0, 1.0],
            vec![2.0, -3.0],
            2,
        ),
        (
            vec![10.0, -3.0, 7.0, 0.0, 0.0, half, half, 2.0, 3.0, 4.0],
            vec![
                1.0,
                2.0,
                -1.0,
                0.0,
                (pi / 8.0).sin(),
                0.0,
                (pi / 8.0).cos(),
                1.0,
                2.0,
                3.0,
            ],
            vec![2.0, -3.0, 4.0],
            3,
        ),
    ] {
        let entry = format!("interpolate{d}");
        let parent = f.floats(&entry, args(&[&parent_pose, &parent_pose, &[0.0]]))
            [parent_pose.len()..]
            .to_vec();
        let child = f.floats(&entry, args(&[&child_pose, &child_pose, &[0.0]]))[child_pose.len()..]
            .to_vec();
        let p_ref = if d == 2 {
            pose2(&parent_pose)
        } else {
            pose3(&parent_pose)
        };
        let c_ref = if d == 2 {
            pose2(&child_pose)
        } else {
            pose3(&child_pose)
        };
        near_all(&parent, &p_ref, 1e-5);
        near_all(&child, &c_ref, 1e-5);
        let out = f.floats(&format!("affine{d}"), args(&[&parent, &child, &p]));
        let n = d + d * d;
        near_all(&out[..n], &compose(&p_ref, &c_ref, d), 2e-5);
        near_all(
            &out[n..n + d],
            &point(&parent, &point(&child, &p, d), d),
            2e-5,
        );
        near_all(
            &out[n + d..n + 2 * d],
            &vector(&parent, &vector(&child, &p, d), d),
            2e-5,
        );
        let shear: f64 = (0..d).map(|r| out[d + r] * out[d + d * (d - 1) + r]).sum();
        assert!(shear.abs() > 1.0);
        assert_eq!(out[n + 2 * d], 1.0);
        near_all(&point(&out[n + 2 * d + 1..], &out[n..n + d], d), &p, 2e-5);
    }
    for i in 0..40 {
        let a = i as f64 / 13.0;
        for (basis, id, p, d) in [
            (
                vec![a, -a, 2.0 + a, 0.25, 0.75, -3.0 - a],
                ID2.to_vec(),
                vec![3.0 - a, a + 2.0],
                2,
            ),
            (
                vec![
                    a,
                    -a,
                    a * 2.0,
                    3.0 + a,
                    0.25,
                    0.5,
                    1.0,
                    -4.0 - a,
                    0.75,
                    -0.5,
                    0.25,
                    2.0 + a,
                ],
                ID3.to_vec(),
                vec![2.0, a - 1.0, 3.0 + a],
                3,
            ),
        ] {
            let out = f.floats(&format!("affine{d}"), args(&[&basis, &id, &p]));
            let n = d + d * d;
            assert_eq!(out[n + 2 * d], 1.0);
            near_all(&point(&out[n + 2 * d + 1..], &out[n..n + d], d), &p, 1e-5);
            near_all(&compose(&basis, &out[n + 2 * d + 1..], d), &id, 1e-5);
        }
    }
    assert_eq!(
        f.floats(
            "affine2",
            args(&[&[0.0, 0.0, 1e-6, 0.0, 0.0, 1e-6], &ID2, &[1.0, 2.0]])
        )[10],
        1.0
    );
    assert_eq!(
        f.floats(
            "affine3",
            args(&[
                &[
                    0.0, 0.0, 0.0, 1e-6, 0.0, 0.0, 0.0, 1e-6, 0.0, 0.0, 0.0, 1e-6
                ],
                &ID3,
                &[1.0, 2.0, 3.0]
            ])
        )[18],
        1.0
    );
    for basis in [
        [0.0, 0.0, 1.0, 2.0, 2.0, 4.0],
        [0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
        [0.0, 0.0, f64::INFINITY, 0.0, 0.0, 1.0],
    ] {
        assert_eq!(
            f.floats("affine2", args(&[&basis, &ID2, &[1.0, 2.0]]))[10],
            0.0
        );
    }
    for basis in [
        [0.0, 0.0, 0.0, 1.0, 2.0, 3.0, 2.0, 4.0, 6.0, 0.0, 0.0, 1.0],
        [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0],
        [
            0.0,
            0.0,
            0.0,
            f64::NAN,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            0.0,
            1.0,
        ],
    ] {
        assert_eq!(
            f.floats("affine3", args(&[&basis, &ID3, &[1.0, 2.0, 3.0]]))[18],
            0.0
        );
    }
    near_all(
        &f.floats(
            "affine2",
            args(&[&[10.0, -20.0, -2.0, 0.0, 0.0, 3.0], &ID2, &[1.0, 2.0]]),
        )[6..10],
        &[8.0, -14.0, -2.0, 6.0],
        1e-5,
    );
    near_all(
        &f.floats(
            "affine3",
            args(&[
                &[
                    10.0, -20.0, 30.0, -2.0, 0.0, 0.0, 0.0, 3.0, 0.0, 0.0, 0.0, 4.0,
                ],
                &ID3,
                &[1.0, 2.0, -3.0],
            ]),
        )[12..18],
        &[8.0, -14.0, 18.0, -2.0, 6.0, -12.0],
        1e-5,
    );
}
#[test]
fn pose_interpolation_endpoints_short_arcs_and_antipodal_quaternions() {
    let mut f = Fixture::new("tests/transform.blot");
    let pi = std::f64::consts::PI;
    let a = [1.0, 2.0, 170.0 * pi / 180.0, 2.0, 3.0];
    let b = [5.0, -2.0, -170.0 * pi / 180.0, 4.0, 1.0];
    for (t, want) in [(0.0, pose2(&a)), (1.0, pose2(&b))] {
        near_all(
            &f.floats("interpolate2", args(&[&a, &b, &[t]]))[5..],
            &want,
            1e-5,
        );
    }
    let mid = f.floats("interpolate2", args(&[&a, &b, &[0.5]]));
    near_all(&mid[..5], &[3.0, 0.0, pi, 3.0, 2.0], 1e-5);
    near_all(&mid[5..], &[3.0, 0.0, -3.0, 0.0, 0.0, -2.0], 1e-5);
    let h = std::f64::consts::FRAC_1_SQRT_2;
    let a = [1.0, 2.0, 3.0, 0.0, 0.0, 0.0, 1.0, 2.0, 3.0, 4.0];
    let b = [5.0, -2.0, 1.0, 0.0, h, 0.0, h, 4.0, 1.0, 2.0];
    for (t, want) in [(0.0, pose3(&a)), (1.0, pose3(&b))] {
        near_all(
            &f.floats("interpolate3", args(&[&a, &b, &[t]]))[10..],
            &want,
            1e-5,
        );
    }
    let mid = f.floats("interpolate3", args(&[&a, &b, &[0.5]]));
    near_all(&mid[..3], &[3.0, 0.0, 2.0], 1e-5);
    near_all(&mid[7..10], &[3.0, 2.0, 3.0], 1e-5);
    near_all(
        &mid[3..7],
        &[0.0, (pi / 8.0).sin(), 0.0, (pi / 8.0).cos()],
        1e-5,
    );
    let mut opposite = b;
    for x in &mut opposite[3..7] {
        *x = -*x;
    }
    for t in [0.0, 0.25, 0.5, 0.75, 1.0] {
        near_all(
            &f.floats("interpolate3", args(&[&b, &opposite, &[t]]))[10..],
            &pose3(&b),
            1e-5,
        );
    }
}
