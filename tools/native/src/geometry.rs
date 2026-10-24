use crate::*;
#[test]
fn redundant_rotated_hulls_keep_topology_and_analytic_distances() {
    let mut f = Fixture::new("tests/perf/geometry.blot");
    for angle in [0f64, 0.17, 0.63, 1.1] {
        let (s, c) = angle.sin_cos();
        let rotate = |v: [f64; 3]| [c * v[0] - s * v[2], v[1], s * v[0] + c * v[2]];
        let normals = [
            [1., 0., 0.],
            [-1., 0., 0.],
            [0., 1., 0.],
            [0., -1., 0.],
            [0., 0., 1.],
            [0., 0., -1.],
        ];
        let points = [[2., 0.1, 0.2], [2., 2., 0.2], [2., 2., 2.], [0.1, 0.9, 0.2]];
        for copies in [1, 2, 8] {
            let faces = copies * 6;
            let mut input = vec![faces as f64];
            for i in 0..faces {
                input.extend(rotate(normals[i % 6]));
                input.push(1.);
            }
            for p in points {
                input.extend(rotate(p));
            }
            let r = f.floats("hull", input);
            assert_eq!(&r[..3], &[8., faces as f64, (copies * 12) as f64]);
            let vertices = r[3..27].chunks(3).collect::<Vec<_>>();
            let mut cursor = 27;
            for _ in 0..faces {
                let plane = &r[cursor..cursor + 4];
                assert_eq!(r[cursor + 4], 4.);
                let ids = &r[cursor + 5..cursor + 9];
                assert_eq!(
                    ids.iter()
                        .map(|x| *x as usize)
                        .collect::<std::collections::BTreeSet<_>>()
                        .len(),
                    4
                );
                let mut area = 0.;
                for i in 0..4 {
                    let a = vertices[ids[i] as usize];
                    let b = vertices[ids[(i + 1) % 4] as usize];
                    near(
                        a.iter().zip(plane).map(|(a, b)| a * b).sum(),
                        plane[3],
                        2e-6,
                    );
                    area += (a[1] * b[2] - a[2] * b[1]) * plane[0]
                        + (a[2] * b[0] - a[0] * b[2]) * plane[1]
                        + (a[0] * b[1] - a[1] * b[0]) * plane[2];
                }
                assert!(area > 0.);
                cursor += 9;
            }
            for p in points {
                let mut closest = p.map(|x| x.clamp(-1., 1.));
                let mut distance = (0..3)
                    .map(|i| (p[i] - closest[i]).powi(2))
                    .sum::<f64>()
                    .sqrt();
                let normal = if distance == 0. {
                    closest = p;
                    closest[1] = 1.;
                    distance = p[1] - 1.;
                    [0., 1., 0.]
                } else {
                    std::array::from_fn(|i| (p[i] - closest[i]) / distance)
                };
                near(r[cursor], distance, 2e-6);
                near_all(
                    &r[cursor + 1..cursor + 7],
                    &[rotate(normal), rotate(closest)].concat(),
                    2e-6,
                );
                cursor += 7;
            }
            assert_eq!(cursor, r.len());
        }
    }
}
#[test]
fn near_parallel_planes_keep_tighter_half_space() {
    let mut f = Fixture::new("tests/perf/geometry.blot");
    let planes = [
        [1., 0., 0., 1.],
        [-1., 0., 0., 1.],
        [0., 1., 0., 1.],
        [0., -1., 0., 1.],
        [0., 0., 1., 1.],
        [0., 0., -1., 1.],
        [1., 0., 0., 0.99],
        [1., 0.0001, 0., 0.99],
    ];
    let r = f.floats(
        "hull",
        [vec![8.], planes.concat(), vec![2., 0.8, 0.]].concat(),
    );
    assert!(!r.is_empty());
    for i in 0..r[0] as usize {
        let x = r[3 + i * 3];
        let y = r[4 + i * 3];
        assert!(x <= 0.990001 && x + 0.0001 * y <= 0.990501);
    }
    near(r[r.len() - 7], 1.01008, 0.0003);
}
