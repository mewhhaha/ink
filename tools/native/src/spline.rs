use super::*;
type Point = [f64; 3];
const WINDING: [Point; 6] = [
    [0.0, 0.0, 0.0],
    [4.0, 1.0, 0.0],
    [4.3, 1.0, 0.2],
    [9.0, 0.0, 3.0],
    [9.0, 2.0, -6.0],
    [2.0, 0.0, -5.0],
];
fn query(f: &mut Fixture, closed: bool, distances: &[f64], points: &[Point]) -> Vec<f64> {
    f.floats(
        "query",
        [
            vec![u32::from(closed) as f64, distances.len() as f64],
            distances.to_vec(),
            points.iter().flatten().copied().collect(),
        ]
        .concat(),
    )
}
fn walk(f: &mut Fixture, closed: bool, steps: usize, points: &[Point]) -> (f64, Vec<Point>) {
    let out = f.floats(
        "walk",
        [
            vec![u32::from(closed) as f64, steps as f64],
            points.iter().flatten().copied().collect(),
        ]
        .concat(),
    );
    (
        out[0],
        out[1..]
            .chunks_exact(3)
            .map(|p| p.try_into().unwrap())
            .collect(),
    )
}
fn marks(f: &mut Fixture, closed: bool, points: &[Point]) -> Vec<f64> {
    f.floats(
        "marks",
        [
            vec![u32::from(closed) as f64],
            points.iter().flatten().copied().collect(),
        ]
        .concat(),
    )
}
fn gap(a: &[f64], b: &[f64]) -> f64 {
    a.iter()
        .zip(b)
        .map(|(a, b)| (a - b) * (a - b))
        .sum::<f64>()
        .sqrt()
}
fn circle(count: usize, radius: f64) -> Vec<Point> {
    (0..count)
        .map(|i| {
            let a = i as f64 / count as f64 * std::f64::consts::TAU;
            [radius * a.cos(), 2.0, radius * a.sin()]
        })
        .collect()
}
#[test]
fn spline_chords_marks_circles_and_even_distance() {
    let mut f = Fixture::new("tests/spline.blot");
    let line = [
        [1.0, 2.0, 3.0],
        [2.0, 2.0, 3.0],
        [4.5, 2.0, 3.0],
        [5.0, 2.0, 3.0],
    ];
    let (length, samples) = walk(&mut f, false, 40, &line);
    near(length, 4.0, 1e-5);
    for (i, [x, y, z]) in samples.iter().enumerate() {
        near(*x, 1.0 + i as f64 * 0.1, 1e-5);
        assert_eq!([*y, *z], [2.0, 3.0]);
    }
    near_all(
        &query(&mut f, false, &[1.5], &[[0.0; 3], [0.0, 3.0, 4.0]]),
        &[5.0, 0.0, 0.9, 1.2, 0.0, 0.6, 0.8],
        1e-6,
    );
    for closed in [false, true] {
        let result = marks(&mut f, closed, &WINDING);
        assert_eq!(result.len(), WINDING.len() * 4);
        let m = &result[..WINDING.len()];
        assert_eq!(m[0], 0.0);
        for i in 1..m.len() {
            assert!(m[i] - m[i - 1] >= gap(&WINDING[i], &WINDING[i - 1]) - 1e-4);
        }
        for (i, point) in WINDING.iter().enumerate() {
            assert!(
                gap(
                    &result[WINDING.len() + i * 3..WINDING.len() + i * 3 + 3],
                    point
                ) < 1e-5
            );
        }
    }
    assert_eq!(
        marks(&mut f, false, &WINDING)[WINDING.len() - 1],
        query(&mut f, false, &[], &WINDING)[0]
    );
    for (count, tolerance) in [(8, 0.005), (16, 0.0005)] {
        let points = circle(count, 10.0);
        let length = query(&mut f, true, &[], &points)[0];
        assert!(
            (length - 20.0 * std::f64::consts::PI).abs() < 20.0 * std::f64::consts::PI * tolerance
        );
        let (_, samples) = walk(&mut f, true, 64, &points);
        for [x, y, z] in &samples {
            near(x.hypot(*z), 10.0, 10.0 * tolerance * 4.0);
            assert_eq!(*y, 2.0);
        }
        assert!(gap(&samples[0], &samples[64]) < 1e-4);
    }
    let points = circle(12, 5.0);
    let start = query(&mut f, true, &[0.75], &points);
    let length = start[0];
    for d in [0.75 + length, 0.75 - length, 0.75 + 3.0 * length] {
        near_all(&query(&mut f, true, &[d], &points)[1..], &start[1..], 1e-3);
    }
    near_all(
        &query(&mut f, true, &[length], &points)[1..4],
        &points[0],
        1e-4,
    );
    for (closed, points) in [
        (false, WINDING.to_vec()),
        (true, WINDING.to_vec()),
        (true, circle(5, 3.0)),
    ] {
        let (length, samples) = walk(&mut f, closed, 400, &points);
        let step = length / 400.0;
        let chords: Vec<f64> = samples.windows(2).map(|p| gap(&p[0], &p[1])).collect();
        for chord in &chords {
            assert!(*chord <= step * 1.0002 && *chord >= step * 0.99);
        }
        let hi = chords.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let lo = chords.iter().copied().fold(f64::INFINITY, f64::min);
        assert!(hi - lo < step * 0.01);
    }
}
#[test]
fn spline_tangents_endpoints_repeated_and_invalid_points() {
    let mut f = Fixture::new("tests/spline.blot");
    let distances: Vec<f64> = (0..200).map(|i| i as f64 * 0.15).collect();
    let result = query(&mut f, false, &distances, &WINDING);
    for i in 0..distances.len() {
        let p = &result[1 + i * 6..7 + i * 6];
        near(p[3..].iter().map(|x| x * x).sum::<f64>().sqrt(), 1.0, 1e-5);
        if i + 1 < distances.len() && distances[i + 1] < result[0] {
            let next = &result[7 + i * 6..10 + i * 6];
            let chord = gap(next, &p[..3]);
            let along = (0..3).map(|k| (next[k] - p[k]) * p[3 + k]).sum::<f64>() / chord;
            assert!(along > 0.95);
        }
    }
    let m = marks(&mut f, false, &WINDING);
    for mark in &m[1..WINDING.len() - 1] {
        let a = query(&mut f, false, &[mark - 1e-3, mark + 1e-3], &WINDING);
        assert!(a[4] * a[10] + a[5] * a[11] + a[6] * a[12] > 0.999);
    }
    let r = query(
        &mut f,
        false,
        &[-5.0, 1e9, f64::NAN, f64::INFINITY],
        &WINDING,
    );
    assert!(r[0] > 0.0);
    assert_eq!(&r[1..4], [0.0; 3]);
    near_all(&r[7..10], WINDING.last().unwrap(), 1e-5);
    assert_eq!(&r[13..16], [0.0; 3]);
    assert_eq!(&r[19..22], [0.0; 3]);
    let end = WINDING[5];
    let before = WINDING[4];
    let last: Vec<f64> = (0..3).map(|i| end[i] - before[i]).collect();
    let length = last.iter().map(|x| x * x).sum::<f64>().sqrt();
    near_all(
        &r[10..13],
        &last.iter().map(|x| x / length).collect::<Vec<_>>(),
        1e-5,
    );
    let looped = query(&mut f, true, &[f64::NAN, f64::NEG_INFINITY], &WINDING);
    assert_eq!(&looped[1..4], [0.0; 3]);
    assert_eq!(&looped[7..10], [0.0; 3]);
    let doubled = [
        [0.0; 3],
        [0.0; 3],
        [1.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [3.0, 0.0, 0.0],
    ];
    near(query(&mut f, false, &[], &doubled)[0], 3.0, 1e-5);
    assert_eq!(marks(&mut f, false, &doubled).len(), 12);
    let mut square = vec![[0.0; 3], [2.0, 0.0, 0.0], [2.0, 0.0, 2.0], [0.0, 0.0, 2.0]];
    let closed = query(&mut f, true, &[], &square);
    square.push([0.0; 3]);
    assert_eq!(query(&mut f, true, &[], &square), closed);
    for (closed, points) in [
        (false, vec![]),
        (false, vec![[1.0, 2.0, 3.0]]),
        (false, vec![[1.0, 2.0, 3.0]; 2]),
        (false, vec![[0.0; 3], [f64::NAN, 0.0, 0.0]]),
        (
            false,
            vec![[0.0; 3], [f64::INFINITY, 0.0, 0.0], [1.0, 0.0, 0.0]],
        ),
        (false, vec![[0.0; 3], [3e38, 0.0, 0.0], [-3e38, 0.0, 0.0]]),
        (true, vec![[0.0; 3], [1.0, 0.0, 0.0]]),
        (true, vec![[0.0; 3], [1.0, 0.0, 0.0], [0.0; 3]]),
    ] {
        assert!(query(&mut f, closed, &[], &points).is_empty());
    }
}
