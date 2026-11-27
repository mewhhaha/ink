//! Independent f64 references for IK, blend spaces, the state machine and
//! foot placement. They restate each contract with different formulas (law of
//! cosines by angles, area-coordinate barycentrics, closed-form eases) and
//! compare against the Squid fixture within documented F32 tolerances.
use super::*;
type V = [f64; 3];
type Q = [f64; 4];
const FIXTURE: &str = "tests/animation_reference.sq";

fn sub(a: V, b: V) -> V {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn add(a: V, b: V) -> V {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn mul(a: V, s: f64) -> V {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn dot(a: V, b: V) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V, b: V) -> V {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn len(a: V) -> f64 {
    dot(a, a).sqrt()
}
fn unit(a: V) -> V {
    mul(a, 1.0 / len(a))
}
fn v3(s: &[f64]) -> V {
    [s[0], s[1], s[2]]
}
fn rotate(q: Q, v: V) -> V {
    let u = [q[0], q[1], q[2]];
    let t = mul(cross(u, v), 2.0);
    add(add(v, mul(t, q[3])), cross(u, t))
}
fn direction(r: &mut Random) -> V {
    let z = r.unit() * 2.0 - 1.0;
    let a = r.unit() * std::f64::consts::TAU;
    let s = (1.0 - z * z).sqrt();
    [s * a.cos(), z, s * a.sin()]
}
fn between_range(r: &mut Random, low: f64, high: f64) -> f64 {
    low + (high - low) * r.unit()
}
fn quat(r: &mut Random) -> Q {
    let axis = direction(r);
    crate::tween::turn(axis, r.unit() * 6.0 - 3.0)
}
fn lanes(parts: &[&[f64]]) -> Vec<f64> {
    parts.concat()
}
fn two_bone_args(c: [V; 5], soft: f64, weight: f64) -> Vec<f64> {
    let mut v: Vec<f64> = c.iter().flatten().copied().collect();
    v.push(soft);
    v.push(weight);
    v
}
fn rational_reach(low: f64, high: f64, soft: f64, d: f64) -> f64 {
    let start = low.max(high - soft.clamp(0.0, 1.0) * high);
    if d <= start {
        return low.max(d);
    }
    if start >= high {
        return high;
    }
    let range = high - start;
    let x = (d - start) / range;
    high.min(start + range * x / (1.0 + x))
}
/// The classical solution: the root angle from the law of cosines, bent in the
/// plane of the reach axis and the pole.
fn reference_two_bone(c: [V; 5], soft: f64) -> (V, V) {
    let [root, mid, end, target, pole] = c;
    let (l1, l2) = (len(sub(mid, root)), len(sub(end, mid)));
    let d = len(sub(target, root));
    let reach = rational_reach((l1 - l2).abs(), l1 + l2, soft, d);
    let u = unit(sub(target, root));
    let n = unit(sub(pole, mul(u, dot(pole, u))));
    let cos_a = ((l1 * l1 + reach * reach - l2 * l2) / (2.0 * l1 * reach)).clamp(-1.0, 1.0);
    let sin_a = (1.0 - cos_a * cos_a).sqrt();
    let knee = add(root, mul(add(mul(u, cos_a), mul(n, sin_a)), l1));
    (knee, add(root, mul(u, reach)))
}
fn configuration(r: &mut Random, margin: f64) -> ([V; 5], f64, f64, f64) {
    let l1 = between_range(r, 0.3, 1.5);
    let l2 = between_range(r, 0.3, 1.5);
    let root = mul(direction(r), 2.0);
    let first = direction(r);
    let bend = direction(r);
    let side = unit(sub(bend, mul(first, dot(bend, first))));
    let mid = add(root, mul(first, l1));
    let end = add(mid, mul(side, l2));
    let d = between_range(r, (l1 - l2).abs() + margin, l1 + l2 - margin);
    let target = add(root, mul(direction(r), d));
    ([root, mid, end, target, direction(r)], l1, l2, d)
}
fn f32v(c: [V; 5]) -> [V; 5] {
    c.map(|v| v.map(f32))
}
fn run_two_bone(f: &mut Fixture, c: [V; 5], soft: f64, weight: f64) -> Option<Vec<f64>> {
    let out = f.floats("two_bone", two_bone_args(c, soft, weight));
    (out[0] == 1.0).then_some(out)
}

#[test]
fn two_bone_matches_the_law_of_cosines_and_keeps_bone_lengths() {
    let mut f = Fixture::new(FIXTURE);
    let mut r = Random(0xA11CE);
    for _ in 0..400 {
        let (c, l1, l2, d) = configuration(&mut r, 0.1);
        let c = f32v(c);
        let out = run_two_bone(&mut f, c, 0.0, 1.0).unwrap();
        let (mid, end) = reference_two_bone(c, 0.0);
        near_all(&out[1..4], &mid, 3e-4);
        near_all(&out[4..7], &end, 3e-4);
        // The measured contract: lengths to 1e-5, the end on the target.
        near(len(sub(v3(&out[1..4]), c[0])), len(sub(c[1], c[0])), 2e-5);
        near(
            len(sub(v3(&out[4..7]), v3(&out[1..4]))),
            len(sub(c[2], c[1])),
            2e-5,
        );
        near(len(sub(v3(&out[4..7]), c[3])), 0.0, 2e-4);
        assert!(l1 > 0.0 && l2 > 0.0 && d > 0.0);
        // The pole lies in the bend plane, on the knee's side.
        let axis = unit(sub(c[3], c[0]));
        let knee = sub(v3(&out[1..4]), c[0]);
        let plane = dot(cross(axis, knee), cross(axis, c[4]));
        assert!(plane >= -1e-6, "{plane}");
        let normal = unit(cross(axis, c[4]));
        near(dot(knee, normal), 0.0, 3e-4);
        // Rotation deltas carry old bones onto new bones.
        let q1: Q = out[7..11].try_into().unwrap();
        let q2: Q = out[11..15].try_into().unwrap();
        let old1 = unit(sub(c[1], c[0]));
        let old2 = unit(sub(c[2], c[1]));
        near_all(&rotate(q1, old1), &unit(sub(v3(&out[1..4]), c[0])), 2e-5);
        near_all(
            &rotate(crate::tween::multiply(q2, q1), old2),
            &unit(sub(v3(&out[4..7]), v3(&out[1..4]))),
            2e-5,
        );
    }
}

#[test]
fn two_bone_soft_limit_unreachable_folded_and_weighted_targets() {
    let mut f = Fixture::new(FIXTURE);
    let mut r = Random(77);
    for _ in 0..200 {
        let (mut c, l1, l2, _) = configuration(&mut r, 0.05);
        // Far targets extend toward the target.
        let u = direction(&mut r);
        c[3] = add(c[0], mul(u, (l1 + l2) * between_range(&mut r, 1.02, 5.0)));
        let c = f32v(c);
        let out = run_two_bone(&mut f, c, 0.0, 1.0).unwrap();
        let towards = unit(sub(c[3], c[0]));
        let want = add(
            c[0],
            mul(towards, len(sub(c[1], c[0])) + len(sub(c[2], c[1]))),
        );
        near_all(&out[4..7], &want, 3e-5);
        near_all(&unit(sub(v3(&out[1..4]), c[0])), &towards, 3e-4);
        // Soft limits: the end stays inside the hard reach and before the target.
        let soft = r.unit();
        let softened = run_two_bone(&mut f, c, soft, 1.0).unwrap();
        let reach = len(sub(v3(&softened[4..7]), c[0]));
        assert!(reach <= l1 + l2 + 1e-5, "{reach}");
        near(
            reach,
            rational_reach((l1 - l2).abs(), l1 + l2, soft, len(sub(c[3], c[0]))),
            1e-4,
        );
        // Targets nearer than |l1-l2| fold the chain to that distance.
        let mut near_root = c;
        near_root[3] = add(c[0], mul(u, (l1 - l2).abs() * 0.4));
        let near_root = f32v(near_root);
        let folded = run_two_bone(&mut f, near_root, 0.0, 1.0).unwrap();
        near(len(sub(v3(&folded[4..7]), c[0])), (l1 - l2).abs(), 2e-5);
        // Every weight keeps both lengths and moves monotonically toward the goal.
        let mut previous = len(sub(c[2], v3(&out[4..7])));
        for k in 0..=10 {
            let w = k as f64 / 10.0;
            let blended = run_two_bone(&mut f, c, 0.0, w).unwrap();
            near(
                len(sub(v3(&blended[1..4]), c[0])),
                len(sub(c[1], c[0])),
                2e-5,
            );
            near(
                len(sub(v3(&blended[4..7]), v3(&blended[1..4]))),
                len(sub(c[2], c[1])),
                2e-5,
            );
            let remaining = len(sub(v3(&blended[4..7]), v3(&out[4..7])));
            assert!(
                remaining <= previous + 1e-3 || k == 0,
                "{remaining} {previous}"
            );
            previous = remaining;
        }
    }
    for (low, high, soft) in [
        (0.0, 2.0, 0.25),
        (0.2, 2.0, 0.5),
        (0.5, 1.0, 1.0),
        (0.0, 1.0, 0.0),
    ] {
        let mut previous = low;
        for step in 0..600 {
            let d = step as f64 * 0.01;
            let got = f.number("soft_reach", [low, high, soft, d]);
            near(got, rational_reach(low, high, soft, d), 3e-6);
            assert!(got >= previous - 1e-6 && got <= high + 1e-6);
            previous = got;
        }
    }
}

#[test]
fn two_bone_adversarial_inputs() {
    let mut f = Fixture::new(FIXTURE);
    let root = [0.0, 1.0, 0.0];
    let tip = [0.0, 3.0, 0.0];
    let bone = [0.0, 2.0, 0.0];
    let target = [0.5, 2.0, 0.5];
    for (mid, end) in [(root, tip), (bone, bone), (root, root)] {
        let out =
            run_two_bone(&mut f, [root, mid, end, target, [0.0, 1.0, 0.0]], 0.0, 1.0).unwrap();
        assert!(out.iter().all(|x| x.is_finite()));
        near(len(sub(v3(&out[1..4]), root)), len(sub(mid, root)), 1e-6);
        near(
            len(sub(v3(&out[4..7]), v3(&out[1..4]))),
            len(sub(end, mid)),
            1e-6,
        );
    }
    // Target at the root: equal bones fold flat.
    let out = run_two_bone(&mut f, [root, bone, tip, root, [1.0, 0.0, 0.0]], 0.0, 1.0).unwrap();
    near_all(&out[4..7], &root, 1e-5);
    // Poles parallel and antiparallel to the reach axis, and a zero pole.
    for pole in [
        [0.0, 4.0, 0.0],
        [0.0, -4.0, 0.0],
        [0.0, 0.0, 0.0],
        [1e-30, 1.0, 0.0],
    ] {
        let c = [
            root,
            [0.3, 2.0, 0.0],
            [0.0, 3.0, 0.1],
            [0.0, 2.5, 0.0],
            pole,
        ];
        let out = run_two_bone(&mut f, c, 0.0, 1.0).unwrap();
        assert!(out.iter().all(|x| x.is_finite()));
        near(len(sub(v3(&out[1..4]), root)), len(sub(c[1], root)), 3e-6);
        near(len(sub(v3(&out[4..7]), c[3])), 0.0, 3e-4);
    }
    // Large and tiny scales keep the relations.
    for scale in [1e-3, 1.0, 1e3] {
        let c = [root, bone, tip, target, [0.0, 0.0, 1.0]].map(|v| mul(v, scale));
        let c = f32v(c);
        let out = run_two_bone(&mut f, c, 0.0, 1.0).unwrap();
        near(
            len(sub(v3(&out[1..4]), c[0])) / scale,
            len(sub(c[1], c[0])) / scale,
            2e-5,
        );
    }
    // Every lane of every input rejects NaN and infinity.
    let base = two_bone_args([root, bone, tip, target, [0.0, 0.0, 1.0]], 0.2, 0.5);
    for lane in 0..base.len() {
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let mut v = base.clone();
            v[lane] = bad;
            assert_eq!(f.floats("two_bone", v), [0.0], "lane {lane} {bad}");
        }
    }
    // Weight zero is exact identity; out-of-range weights clamp.
    let c = [root, bone, tip, target, [0.0, 0.0, 1.0]];
    let zero = run_two_bone(&mut f, c, 0.0, 0.0).unwrap();
    assert_eq!(&zero[1..7], &[0.0, 2.0, 0.0, 0.0, 3.0, 0.0]);
    assert_eq!(run_two_bone(&mut f, c, 0.0, -4.0).unwrap(), zero,);
    assert_eq!(
        run_two_bone(&mut f, c, 0.0, 9.0).unwrap(),
        run_two_bone(&mut f, c, 0.0, 1.0).unwrap()
    );
}

fn angle(a: Q, b: Q) -> f64 {
    crate::tween::between(a, b)
}
fn aim_args(q: Q, fwd: V, up: V, dir: V, world_up: V, limit: f64, weight: f64) -> Vec<f64> {
    lanes(&[&q, &fwd, &up, &dir, &world_up, &[limit, weight]])
}
#[test]
fn aim_points_forward_aligns_up_and_honours_limit_and_weight() {
    let mut f = Fixture::new(FIXTURE);
    let mut r = Random(4242);
    for _ in 0..300 {
        let q = quat(&mut r).map(f32);
        let fwd = unit(direction(&mut r));
        let mut up = direction(&mut r);
        up = unit(sub(up, mul(fwd, dot(up, fwd))));
        let dir = mul(direction(&mut r), between_range(&mut r, 0.1, 10.0));
        let world_up = direction(&mut r);
        let out = f.floats("aim", aim_args(q, fwd, up, dir, world_up, 10.0, 1.0));
        assert_eq!(out[0], 1.0);
        let result: Q = out[1..5].try_into().unwrap();
        near(result.iter().map(|x| x * x).sum::<f64>(), 1.0, 2e-6);
        near_all(&rotate(result, fwd), &unit(dir), 3e-5);
        // The local up axis lands on the world-up side of the aim axis.
        let wanted = unit(sub(world_up, mul(unit(dir), dot(world_up, unit(dir)))));
        let got = rotate(result, up);
        if dot(wanted, wanted).is_finite()
            && len(sub(world_up, mul(unit(dir), dot(world_up, unit(dir))))) > 0.05
        {
            near_all(&got, &wanted, 2e-3);
        }
        // Swing-only aiming: the weight scales the angle exactly.
        let full = f.floats("aim", aim_args(q, fwd, [0.0; 3], dir, [0.0; 3], 10.0, 1.0));
        let total = angle(q, full[1..5].try_into().unwrap());
        for w in [0.25, 0.5, 0.9] {
            let part = f.floats("aim", aim_args(q, fwd, [0.0; 3], dir, [0.0; 3], 10.0, w));
            near(angle(q, part[1..5].try_into().unwrap()), total * w, 2e-4);
        }
        // Limits clamp the turn to exactly the limit, once it is binding.
        for limit in [0.05, 0.4] {
            let capped = f.floats("aim", aim_args(q, fwd, [0.0; 3], dir, [0.0; 3], limit, 1.0));
            near(
                angle(q, capped[1..5].try_into().unwrap()),
                total.min(limit),
                3e-4,
            );
            let twisted = f.floats("aim", aim_args(q, fwd, up, dir, world_up, limit, 1.0));
            assert!(angle(q, twisted[1..5].try_into().unwrap()) <= limit + 3e-4);
        }
        // Weight zero and a zero direction keep the rotation.
        let kept = f.floats("aim", aim_args(q, fwd, up, dir, world_up, 10.0, 0.0));
        near_all(&kept[1..5], &q, 2e-6);
        let still = f.floats("aim", aim_args(q, fwd, up, [0.0; 3], world_up, 10.0, 1.0));
        near_all(&still[1..5], &q, 2e-6);
        // Opposite directions stay finite.
        let behind = f.floats(
            "aim",
            aim_args(
                q,
                fwd,
                [0.0; 3],
                mul(rotate(q, fwd), -1.0),
                [0.0; 3],
                10.0,
                1.0,
            ),
        );
        near(
            angle(q, behind[1..5].try_into().unwrap()),
            std::f64::consts::PI,
            2e-3,
        );
    }
    // NaN and infinity reject.
    let base = aim_args(
        [0.0, 0.0, 0.0, 1.0],
        [0.0, 0.0, -1.0],
        [0.0, 1.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        1.0,
        1.0,
    );
    for lane in 0..base.len() {
        for bad in [f64::NAN, f64::INFINITY] {
            let mut v = base.clone();
            v[lane] = bad;
            assert_eq!(f.floats("aim", v), [0.0], "lane {lane}");
        }
    }
}

type Weights = Vec<(u32, f64)>;
fn decode(out: &[f64]) -> Weights {
    assert_eq!(out[0], 1.0);
    let n = out[1] as usize;
    (0..n)
        .map(|i| (out[2 + 2 * i] as u32, out[3 + 2 * i]))
        .collect()
}
fn weight(w: &Weights, clip: u32) -> f64 {
    w.iter().filter(|(c, _)| *c == clip).map(|(_, x)| x).sum()
}
fn valid(w: &Weights) {
    assert!(!w.is_empty() && w.len() <= 3);
    near(w.iter().map(|(_, x)| x).sum(), 1.0, 2e-6);
    assert!(w.iter().all(|(_, x)| *x > 0.0));
}

#[test]
fn blend1_matches_linear_interpolation_and_clamps() {
    let mut f = Fixture::new(FIXTURE);
    let mut r = Random(9);
    for case in 0..200 {
        let n = 1 + (case % 7);
        let mut positions: Vec<f64> = (0..n)
            .map(|_| f32(between_range(&mut r, -3.0, 5.0)))
            .collect();
        if case % 3 == 0 && n > 2 {
            positions[1] = positions[0];
        }
        positions.sort_by(f64::total_cmp);
        let samples: Vec<f64> = positions
            .iter()
            .enumerate()
            .flat_map(|(i, p)| [*p, 10.0 + i as f64])
            .collect();
        let mut values: Vec<f64> = (0..20)
            .map(|_| f32(between_range(&mut r, -4.0, 6.0)))
            .collect();
        values.extend(positions.iter().copied());
        for value in values {
            let out = f.floats("blend1", [vec![value], samples.clone()].concat());
            let got = decode(&out);
            valid(&got);
            // Reference: the later of equal positions wins at and beyond them.
            let mut want: Weights = vec![];
            let upper = positions.iter().position(|p| *p > value);
            match upper {
                None => want.push((10 + n as u32 - 1, 1.0)),
                Some(0) => want.push((10, 1.0)),
                Some(i) => {
                    let t = (value - positions[i - 1]) / (positions[i] - positions[i - 1]);
                    if t > 0.0 {
                        want.push((10 + i as u32 - 1, 1.0 - t));
                        want.push((10 + i as u32, t));
                    } else {
                        want.push((10 + i as u32 - 1, 1.0));
                    }
                }
            }
            for clip in 10..10 + n as u32 {
                near(weight(&got, clip), weight(&want, clip), 3e-6);
            }
        }
    }
    // Invalid pools and values.
    assert_eq!(f.floats("blend1", [0.5, 1.0, 0.0, 0.0, 1.0]), [0.0]);
    assert_eq!(f.floats("blend1", [0.5]), [0.0]);
    assert_eq!(f.floats("blend1", [f64::NAN, 0.0, 1.0]), [0.0]);
    assert_eq!(f.floats("blend1", [0.5, f64::NAN, 1.0]), [0.0]);
    assert_eq!(
        f.floats("blend1", [0.5, 0.0, 1.0, f64::INFINITY, 2.0]),
        [0.0]
    );
}

fn bary(p: [f64; 2], a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> [f64; 3] {
    let area = |p: [f64; 2], q: [f64; 2], s: [f64; 2]| {
        (q[0] - p[0]) * (s[1] - p[1]) - (q[1] - p[1]) * (s[0] - p[0])
    };
    let total = area(a, b, c);
    [
        area(p, b, c) / total,
        area(a, p, c) / total,
        area(a, b, p) / total,
    ]
}
fn nearest_on_triangle(p: [f64; 2], t: [[f64; 2]; 3]) -> [f64; 2] {
    let [a, b, c] = t;
    let w = bary(p, a, b, c);
    if w.iter().all(|x| *x >= 0.0) {
        return p;
    }
    let mut best = (f64::INFINITY, a);
    for (s, e) in [(a, b), (b, c), (c, a)] {
        let d = [e[0] - s[0], e[1] - s[1]];
        let k = (((p[0] - s[0]) * d[0] + (p[1] - s[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1]))
            .clamp(0.0, 1.0);
        let q = [s[0] + k * d[0], s[1] + k * d[1]];
        let dist = (p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2);
        if dist < best.0 {
            best = (dist, q);
        }
    }
    best.1
}
fn blend2_args(x: f64, y: f64, samples: &[[f64; 2]], triangles: &[[u32; 3]]) -> Vec<f64> {
    let mut v = vec![x, y, samples.len() as f64];
    for (i, s) in samples.iter().enumerate() {
        v.extend([s[0], s[1], i as f64]);
    }
    for t in triangles {
        v.extend(t.map(f64::from));
    }
    v
}
/// 3x3 jittered grid, two triangles per cell.
fn grid(r: &mut Random) -> (Vec<[f64; 2]>, Vec<[u32; 3]>) {
    let mut samples = vec![];
    for j in 0..3 {
        for i in 0..3 {
            samples.push([
                f32(i as f64 + between_range(r, -0.2, 0.2)),
                f32(j as f64 + between_range(r, -0.2, 0.2)),
            ]);
        }
    }
    let mut triangles = vec![];
    for j in 0..2u32 {
        for i in 0..2u32 {
            let a = j * 3 + i;
            triangles.push([a, a + 1, a + 4]);
            triangles.push([a, a + 4, a + 3]);
        }
    }
    (samples, triangles)
}
#[test]
fn blend2_matches_barycentric_reference_and_is_exact_normalised_continuous() {
    let mut f = Fixture::new(FIXTURE);
    let mut r = Random(31337);
    for _ in 0..30 {
        let (samples, triangles) = grid(&mut r);
        let eval = |f: &mut Fixture, x: f64, y: f64| {
            decode(&f.floats("blend2", blend2_args(x, y, &samples, &triangles)))
        };
        // Exact at every sample.
        for (i, s) in samples.iter().enumerate() {
            let w = eval(&mut f, s[0], s[1]);
            assert_eq!(w, vec![(i as u32, 1.0)]);
        }
        for _ in 0..60 {
            let (x, y) = (
                f32(between_range(&mut r, -1.0, 3.0)),
                f32(between_range(&mut r, -1.0, 3.0)),
            );
            let got = eval(&mut f, x, y);
            valid(&got);
            // Reference: nearest triangle point, then area coordinates.
            let mut best: (f64, usize, [f64; 2]) = (f64::INFINITY, 0, [0.0; 2]);
            for (k, t) in triangles.iter().enumerate() {
                let tri = t.map(|i| samples[i as usize]);
                let q = nearest_on_triangle([x, y], tri);
                let d = (q[0] - x).powi(2) + (q[1] - y).powi(2);
                if d < best.0 - 1e-12 {
                    best = (d, k, q);
                }
            }
            let t = triangles[best.1];
            let w = bary(
                best.2,
                samples[t[0] as usize],
                samples[t[1] as usize],
                samples[t[2] as usize],
            );
            for (i, clip) in t.iter().enumerate() {
                near(weight(&got, *clip), w[i].max(0.0), 3e-4);
            }
        }
        // Continuity: small steps never jump, including across triangle edges.
        for _ in 0..5 {
            // Inside the mesh: nearest-point clamping outside a nonconvex
            // boundary may jump where two boundary points tie.
            let (x0, y0) = (
                between_range(&mut r, 0.6, 1.4),
                between_range(&mut r, 0.6, 1.4),
            );
            let angle = r.unit() * std::f64::consts::TAU;
            let step = 0.0006;
            let mut previous = eval(&mut f, f32(x0), f32(y0));
            for k in 1..600 {
                let x = f32(x0 + angle.cos() * step * k as f64);
                let y = f32(y0 + angle.sin() * step * k as f64);
                let next = eval(&mut f, x, y);
                for clip in 0..9 {
                    assert!(
                        (weight(&next, clip) - weight(&previous, clip)).abs() <= 0.02,
                        "clip {clip} at {x},{y}"
                    );
                }
                previous = next;
            }
        }
    }
}

#[test]
fn blend2_degenerate_triangles_and_rejections() {
    let mut f = Fixture::new(FIXTURE);
    let square = [
        [0.0, 0.0],
        [1.0, 0.0],
        [1.0, 1.0],
        [0.0, 1.0],
        [5.0, 5.0],
        [6.0, 6.0],
        [7.0, 7.0],
    ];
    // Collinear and sliver triangles are never selected.
    let tri = [[0, 1, 2], [4, 5, 6]];
    let got = decode(&f.floats("blend2", blend2_args(6.5, 6.4, &square, &tri)));
    valid(&got);
    let only_flat = decode(&f.floats("blend2", blend2_args(5.9, 6.1, &square, &[[4, 5, 6]])));
    assert_eq!(only_flat, vec![(5, 1.0)]);
    let sliver = [[0.0, 0.0], [1.0, 0.0], [0.5, 1e-9], [3.0, 3.0]];
    let sliver_out = decode(&f.floats("blend2", blend2_args(0.5, 0.3, &sliver, &[[0, 1, 2]])));
    assert_eq!(sliver_out, vec![(2, 1.0)]);
    // No triangles: nearest sample, earlier on ties.
    assert_eq!(
        decode(&f.floats("blend2", blend2_args(0.5, 5.0, &square[..4], &[]))),
        vec![(2u32, 1.0)]
    );
    // Rejections: repeated or out-of-range corners, NaN samples and points.
    assert_eq!(
        f.floats("blend2", blend2_args(0.5, 0.5, &square, &[[0, 0, 1]])),
        [0.0]
    );
    assert_eq!(
        f.floats("blend2", blend2_args(0.5, 0.5, &square, &[[0, 1, 9]])),
        [0.0]
    );
    assert_eq!(
        f.floats("blend2", blend2_args(f64::NAN, 0.5, &square, &[[0, 1, 2]])),
        [0.0]
    );
    assert_eq!(
        f.floats(
            "blend2",
            blend2_args(0.5, f64::INFINITY, &square, &[[0, 1, 2]])
        ),
        [0.0]
    );
    let mut nan = square;
    nan[1][0] = f64::NAN;
    assert_eq!(
        f.floats("blend2", blend2_args(0.5, 0.5, &nan, &[[0, 1, 2]])),
        [0.0]
    );
    assert_eq!(f.floats("blend2", blend2_args(0.5, 0.5, &[], &[])), [0.0]);
}

fn ease(code: u32, x: f64) -> f64 {
    let x = x.clamp(0.0, 1.0);
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    match code {
        0 => x,
        1 => x * x * (3.0 - 2.0 * x),
        2 => x * x * x,
        3 => 1.0 - (1.0 - x).powi(3),
        4 => x * x * x * (x * (x * 6.0 - 15.0) + 10.0),
        5 => {
            if x < 0.5 {
                4.0 * x.powi(3)
            } else {
                1.0 - 4.0 * (1.0 - x).powi(3)
            }
        }
        6 => (1.0 + 2.70158 * (x - 1.0).powi(3) + 1.70158 * (x - 1.0).powi(2)).clamp(0.0, 1.0),
        n => ((x * (n - 6) as f64).floor() / (n - 6) as f64).min(1.0),
    }
}
#[test]
fn crossfade_weights_follow_closed_form_eases_monotone_and_normalised() {
    let mut f = Fixture::new(FIXTURE);
    for code in [0u32, 1, 2, 3, 4, 5, 6, 9] {
        for (dt, duration) in [
            (0.1, 0.5),
            (1.0 / 60.0, 0.4),
            (0.3, 0.2),
            (0.25, 1.0),
            (0.01, 2.0),
        ] {
            let count = 400;
            let log = f.floats("fade", [dt, count as f64, code as f64, duration]);
            let rows: Vec<&[f64]> = log.chunks(5).collect();
            let mut previous = 0.0;
            let mut elapsed = 0.0;
            for (k, row) in rows.iter().enumerate() {
                assert_eq!(row[0], 1.0);
                near(row[3], 1.0, 2e-6);
                // Step 0 starts the fade; later steps accumulate dt in F32.
                if k > 0 {
                    elapsed = f32(elapsed + f32(dt));
                }
                let want = if elapsed >= f32(duration) {
                    1.0
                } else {
                    ease(code, f32(elapsed / f32(duration)))
                };
                near(row[2], want, 2e-5);
                near(row[1], 1.0 - want, 2e-5);
                assert!(
                    row[2] >= previous && row[1] >= 0.0 && row[2] <= 1.0,
                    "{code} {k}"
                );
                previous = row[2];
            }
            let last = rows[rows.len() - 1];
            assert_eq!((last[1], last[2]), (0.0, 1.0));
            // The walk phase starts at the idle phase after step zero, then
            // advances at its own duration (2 s) per dt.
            near(rows[0][4], f32(dt), 1e-6);
            let after = 1;
            near(rows[after][4], dt + dt / 2.0, 2e-6);
        }
    }
    // Zero duration cuts at once; zero dt never advances the fade.
    let cut = f.floats("fade", [0.1, 3.0, 0.0, 0.0]);
    near_all(&cut[..5], &[1.0, 0.0, 1.0, 1.0, 0.1], 1e-6);
    let held = f.floats("fade", [0.0, 10.0, 0.0, 0.5]);
    for row in held.chunks(5) {
        assert_eq!(row, &[1.0, 1.0, 0.0, 1.0, 0.0][..]);
    }
    // Runs are deterministic.
    let a = f.floats("fade", [0.07, 50.0, 1.0, 0.9]);
    assert_eq!(a, f.floats("fade", [0.07, 50.0, 1.0, 0.9]));
    // Invalid dt keeps the machine in place (ok lane zero for the step).
    let bad = f.floats("fade", [f64::NAN, 2.0, 0.0, 0.5]);
    assert_eq!(bad[0], 0.0);
    assert_eq!(f.floats("fade", [-0.1, 1.0, 0.0, 0.5])[0], 0.0);
}

fn feet_args(settings: [f64; 8], dt: f64, steps: f64, rows: &[[f64; 13]]) -> Vec<f64> {
    let mut v = settings.to_vec();
    v.extend([dt, steps]);
    for r in rows {
        v.extend(r);
    }
    v
}
fn from_to_up(n: V) -> (V, f64) {
    let axis = cross([0.0, 1.0, 0.0], n);
    let angle = len(axis).atan2(n[1]);
    (
        if len(axis) > 0.0 {
            unit(axis)
        } else {
            [1.0, 0.0, 0.0]
        },
        angle,
    )
}
/// Independent model of `feet.place`: exponential smoothing, pelvis from the
/// lowest planted ground, clamped feet and tilt-to-normal.
fn reference_feet(s: [f64; 8], dt: f64, steps: u32, rows: &[[f64; 13]]) -> (f64, Vec<[f64; 11]>) {
    let alpha = |rate: f64| {
        let k = rate * dt;
        if k <= 0.0 {
            0.0
        } else if k >= 64.0 {
            1.0
        } else {
            1.0 - (-k).exp()
        }
    };
    let (drop, raise) = (s[3], s[4]);
    let mut pelvis = 0.0;
    let mut state = vec![(0.0, [0.0, 0.0, 0.0, 1.0]); rows.len()];
    let mut out = vec![[0.0; 11]; rows.len()];
    for _ in 0..steps {
        let mut target: Option<f64> = None;
        for r in rows {
            if r[8] != 0.0 && r[7] > 0.0 {
                let v = r[7] * (r[9] - r[1]).clamp(-drop, raise);
                target = Some(target.map_or(v, |t: f64| t.min(v)));
            }
        }
        pelvis = (pelvis + (target.unwrap_or(0.0) - pelvis) * alpha(s[5])).clamp(-drop, raise);
        let b = alpha(s[6]);
        for (i, r) in rows.iter().enumerate() {
            let base = r[1] + pelvis;
            let (mut want, mut tilt) = (0.0, [0.0, 0.0, 0.0, 1.0]);
            if r[8] != 0.0 {
                let plant = r[7].clamp(0.0, 1.0);
                want = plant * (r[9] - base).clamp(-drop, raise);
                let (axis, a) = from_to_up(unit(v3(&r[10..13])));
                tilt = crate::tween::turn(axis, a.min(s[7]) * plant);
            }
            let old = state[i];
            let lift = old.0 + (want - old.0) * b;
            let sign = if old.1.iter().zip(tilt).map(|(p, q)| p * q).sum::<f64>() < 0.0 {
                -1.0
            } else {
                1.0
            };
            let mut turn: Q = std::array::from_fn(|k| old.1[k] + (tilt[k] * sign - old.1[k]) * b);
            let n = turn.iter().map(|x| x * x).sum::<f64>().sqrt();
            turn = turn.map(|x| x / n);
            let mut y = base + lift;
            if r[8] != 0.0 {
                y = y.max(r[9]);
            }
            let rotation = crate::tween::multiply(turn, r[3..7].try_into().unwrap());
            let sole = [r[0], y, r[2]];
            let ankle = add(sole, rotate(rotation, v3(&s[0..3])));
            state[i] = (lift, turn);
            out[i] = [
                sole[0],
                sole[1],
                sole[2],
                ankle[0],
                ankle[1],
                ankle[2],
                rotation[0],
                rotation[1],
                rotation[2],
                rotation[3],
                lift,
            ];
        }
    }
    (pelvis, out)
}
fn foot(x: f64, y: f64, plant: f64, hit: bool, height: f64, normal: V) -> [f64; 13] {
    [
        x,
        y,
        0.0,
        0.0,
        0.0,
        0.0,
        1.0,
        plant,
        hit as u32 as f64,
        height,
        normal[0],
        normal[1],
        normal[2],
    ]
}
#[test]
fn feet_match_the_smoothing_model_and_never_sink_below_ground() {
    let mut f = Fixture::new(FIXTURE);
    let settings = [0.0, 0.1, 0.02, 0.4, 0.6, 9.0, 14.0, 0.5];
    let mut r = Random(555);
    for case in 0..40 {
        let rows: Vec<[f64; 13]> = (0..2 + case % 3)
            .map(|i| {
                let n = unit([
                    between_range(&mut r, -0.4, 0.4),
                    1.0,
                    between_range(&mut r, -0.4, 0.4),
                ]);
                foot(
                    i as f64 * 0.4,
                    f32(between_range(&mut r, -0.05, 0.05)),
                    [1.0, 0.0, 0.5, 1.0][(case + i) % 4],
                    (case + i) % 5 != 4,
                    f32(between_range(&mut r, -0.45, 0.45)),
                    n.map(f32),
                )
            })
            .collect();
        for (dt, steps) in [(1.0 / 60.0, 1), (1.0 / 60.0, 30), (0.05, 100), (0.0, 5)] {
            let out = f.floats("feet_run", feet_args(settings, dt, steps as f64, &rows));
            assert_eq!(out[0], 1.0);
            let (pelvis, want) = reference_feet(settings, f32(dt), steps, &rows);
            near(out[1], pelvis, 3e-5);
            for (i, row) in want.iter().enumerate() {
                let got = &out[2 + 11 * i..13 + 11 * i];
                if dt == 0.0 {
                    assert_eq!(got[10], 0.0);
                }
                near_all(&got[..6], &row[..6], 1e-4);
                // Rotation sign is arbitrary: compare orientation.
                near(
                    angle(
                        got[6..10].try_into().unwrap(),
                        row[6..10].try_into().unwrap(),
                    ),
                    0.0,
                    2e-3,
                );
                near(got[10], row[10], 1e-4);
                // Never below the ground it touched.
                if rows[i][8] != 0.0 {
                    assert!(
                        got[1] >= rows[i][9],
                        "foot {i}: {} < {}",
                        got[1],
                        rows[i][9]
                    );
                }
            }
        }
    }
    // The aligned foot's up axis reaches the surface normal within the limit.
    let n = unit([0.2, 1.0, 0.1]);
    let out = f.floats(
        "feet_run",
        feet_args(settings, 0.05, 400.0, &[foot(0.0, 0.0, 1.0, true, 0.0, n)]),
    );
    let up = rotate(out[8..12].try_into().unwrap(), [0.0, 1.0, 0.0]);
    near_all(&up, &n, 2e-4);
    // Pelvis settles on the lowest planted ground (here two feet).
    let out = f.floats(
        "feet_run",
        feet_args(
            settings,
            0.05,
            400.0,
            &[
                foot(0.0, 0.0, 1.0, true, -0.1, [0.0, 1.0, 0.0]),
                foot(0.4, 0.0, 1.0, true, -0.3, [0.0, 1.0, 0.0]),
            ],
        ),
    );
    near(out[1], -0.3, 1e-4);
    near(out[3], -0.1, 1e-5 + 1e-4);
    // Invalid input reports failure without panicking.
    for bad in [
        feet_args(
            settings,
            f64::NAN,
            1.0,
            &[foot(0.0, 0.0, 1.0, true, 0.0, [0.0, 1.0, 0.0])],
        ),
        feet_args(
            settings,
            0.1,
            1.0,
            &[foot(0.0, 0.0, 1.0, true, f64::INFINITY, [0.0, 1.0, 0.0])],
        ),
        feet_args(
            settings,
            0.1,
            1.0,
            &[foot(0.0, 0.0, 1.0, true, 0.0, [0.0, 0.0, 0.0])],
        ),
        feet_args(
            settings,
            -0.1,
            1.0,
            &[foot(0.0, 0.0, 1.0, false, 0.0, [0.0, 1.0, 0.0])],
        ),
    ] {
        assert_eq!(f.floats("feet_run", bad)[0], 0.0);
    }
}

#[test]
fn additive_layer_of_the_reference_pose_is_identity() {
    let mut f = Fixture::new(FIXTURE);
    let mut r = Random(2024);
    let pose = |r: &mut Random| -> Vec<f64> {
        lanes(&[
            &mul(direction(r), 3.0).map(f32),
            &quat(r).map(f32),
            &[
                between_range(r, 0.5, 2.0),
                between_range(r, 0.5, 2.0),
                between_range(r, 0.5, 2.0),
            ]
            .map(f32),
        ])
    };
    for _ in 0..200 {
        let base = pose(&mut r);
        let reference = pose(&mut r);
        let weight = f32(r.unit() * 1.2);
        // Layer equal to its reference: the base returns bit for bit.
        let out = f.floats(
            "additive",
            lanes(&[&base, &reference, &reference, &[weight]]),
        );
        assert_eq!(out, base, "weight {weight}");
        // Position and scale deltas are linear; rotation composes the fractional delta.
        let layer = pose(&mut r);
        let out = f.floats("additive", lanes(&[&base, &layer, &reference, &[weight]]));
        for k in 0..3 {
            near(out[k], base[k] + weight * (layer[k] - reference[k]), 2e-5);
            near(
                out[7 + k],
                base[7 + k] + weight * (layer[7 + k] - reference[7 + k]),
                2e-5,
            );
        }
        let conj = |q: Q| [-q[0], -q[1], -q[2], q[3]];
        let delta = crate::tween::multiply(
            conj(reference[3..7].try_into().unwrap()),
            layer[3..7].try_into().unwrap(),
        );
        let (axis, a) = {
            let s = (delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2]).sqrt();
            let sign = if delta[3] < 0.0 { -1.0 } else { 1.0 };
            (
                [
                    delta[0] * sign / s,
                    delta[1] * sign / s,
                    delta[2] * sign / s,
                ],
                2.0 * s.atan2(delta[3].abs()),
            )
        };
        let part = crate::tween::turn(axis, a * weight);
        let want = crate::tween::multiply(base[3..7].try_into().unwrap(), part);
        near(angle(out[3..7].try_into().unwrap(), want), 0.0, 3e-4);
        // Weight zero changes nothing.
        let zero = f.floats("additive", lanes(&[&base, &layer, &reference, &[0.0]]));
        assert_eq!(zero, base);
    }
}

#[test]
fn benchmark_workloads_keep_their_independent_witnesses() {
    for w in crate::workloads::workloads()
        .into_iter()
        .filter(|w| w.fixture == "../tests/perf/animation_rig.sq")
    {
        let path = root().join("tools").join(&w.fixture);
        let mut f = Fixture::new(path.to_str().unwrap());
        for size in &w.sizes {
            let v = crate::workloads::witness(&mut f, &w, *size);
            crate::workloads::check(&w, *size, &v);
        }
    }
}
