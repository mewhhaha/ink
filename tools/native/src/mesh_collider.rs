//! Independent f64 references for static triangle-mesh colliders.
use super::*;

type V = [f64; 3];

fn packet(vertices: &[V], indices: &[u32], query: &[f64]) -> Vec<f64> {
    let mut out = vec![vertices.len() as f64, indices.len() as f64];
    for v in vertices {
        out.extend(v);
    }
    out.extend(indices.iter().map(|&i| i as f64));
    out.extend(query);
    out
}

/// A flat grid of `n` by `n` quads, each split into two triangles.
fn grid(n: usize, size: f64, height: impl Fn(f64, f64) -> f64) -> (Vec<V>, Vec<u32>) {
    let mut vertices = vec![];
    for j in 0..=n {
        for i in 0..=n {
            let x = (i as f64 / n as f64 - 0.5) * size;
            let z = (j as f64 / n as f64 - 0.5) * size;
            vertices.push([x, height(x, z), z]);
        }
    }
    let mut indices = vec![];
    for j in 0..n {
        for i in 0..n {
            let a = (j * (n + 1) + i) as u32;
            let b = a + 1;
            let c = a + (n + 1) as u32;
            let d = c + 1;
            if (i + j) % 2 == 0 {
                indices.extend([a, c, b, b, c, d]);
            } else {
                indices.extend([a, c, d, a, d, b]);
            }
        }
    }
    (vertices, indices)
}

#[test]
fn mesh_cooks_flat_grid() {
    let mut f = Fixture::new("tests/mesh_collider.sq");
    let (v, i) = grid(2, 4.0, |_, _| 0.0);
    let out = f.floats("cook", packet(&v, &i, &[]));
    println!("{out:?}");
    assert_eq!(out[0], 8.0);
}

// ---- Independent references (f64) -------------------------------------------
fn sub(a: V, b: V) -> V {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn add(a: V, b: V) -> V {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn mul(a: V, k: f64) -> V {
    [a[0] * k, a[1] * k, a[2] * k]
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

fn point_segment(p: V, a: V, b: V) -> f64 {
    let ab = sub(b, a);
    let t = (dot(sub(p, a), ab) / dot(ab, ab)).clamp(0.0, 1.0);
    len(sub(p, add(a, mul(ab, t))))
}
/// Distance from a point to a triangle: the plane projection when it lies
/// inside, else the nearest edge.
fn point_triangle(p: V, t: [V; 3]) -> f64 {
    let n = unit(cross(sub(t[1], t[0]), sub(t[2], t[0])));
    let h = dot(sub(p, t[0]), n);
    let q = sub(p, mul(n, h));
    let inside = (0..3).all(|i| {
        let e = sub(t[(i + 1) % 3], t[i]);
        dot(cross(e, sub(q, t[i])), n) >= -1e-12
    });
    if inside {
        h.abs()
    } else {
        (0..3)
            .map(|i| point_segment(p, t[i], t[(i + 1) % 3]))
            .fold(f64::MAX, f64::min)
    }
}
/// Segment-triangle distance: the point-triangle distance is convex along the
/// segment, so a golden-section search finds its minimum.
fn segment_triangle(a: V, b: V, t: [V; 3]) -> f64 {
    let (mut lo, mut hi) = (0.0f64, 1.0f64);
    let g = 0.5 * (5.0f64.sqrt() - 1.0);
    let at = |s: f64| point_triangle(add(a, mul(sub(b, a), s)), t);
    for _ in 0..200 {
        let m1 = hi - g * (hi - lo);
        let m2 = lo + g * (hi - lo);
        if at(m1) < at(m2) { hi = m2 } else { lo = m1 }
    }
    at(0.5 * (lo + hi)).min(at(0.0)).min(at(1.0))
}
/// Does the open segment cross the triangle's interior?
fn pierces(a: V, b: V, t: [V; 3]) -> Option<(f64, f64)> {
    let n = unit(cross(sub(t[1], t[0]), sub(t[2], t[0])));
    let (da, db) = (dot(sub(a, t[0]), n), dot(sub(b, t[0]), n));
    if da * db >= 0.0 {
        return None;
    }
    let p = add(a, mul(sub(b, a), da / (da - db)));
    let inside = (0..3).all(|i| dot(cross(sub(t[(i + 1) % 3], t[i]), sub(p, t[i])), n) >= 0.0);
    inside.then_some((da, db))
}
fn triangles(v: &[V], i: &[u32]) -> Vec<[V; 3]> {
    i.chunks(3)
        .map(|c| [v[c[0] as usize], v[c[1] as usize], v[c[2] as usize]])
        .collect()
}
/// Signed gap of a segment to a triangle soup, as the library defines it:
/// negative by the least clearing movement when the segment crosses a sheet.
fn soup_gap(a: V, b: V, tris: &[[V; 3]]) -> f64 {
    let mut best = f64::MAX;
    for t in tris {
        let d = match pierces(a, b, *t) {
            Some((da, db)) => -(-da.min(db)).min(da.max(db)),
            None => segment_triangle(a, b, *t),
        };
        best = best.min(d);
    }
    best
}
fn random_soup(seed: u32, count: usize) -> (Vec<V>, Vec<u32>) {
    let mut r = Random(seed);
    let mut v = vec![];
    let mut i = vec![];
    for k in 0..count {
        let c = [r.unit() * 6.0 - 3.0, r.unit() * 2.0, r.unit() * 6.0 - 3.0];
        for _ in 0..3 {
            v.push([
                c[0] + r.unit() * 2.0 - 1.0,
                c[1] + r.unit() * 2.0 - 1.0,
                c[2] + r.unit() * 2.0 - 1.0,
            ]);
        }
        i.extend([3 * k as u32, 3 * k as u32 + 1, 3 * k as u32 + 2]);
    }
    (v, i)
}

#[test]
fn mesh_segment_gaps_match_brute_force() {
    let mut f = Fixture::new("tests/mesh_collider.sq");
    let mut r = Random(7);
    let (mut compared, mut crossed, mut touching) = (0, 0, 0);
    for seed in 0..12 {
        let (v, i) = random_soup(100 + seed, 14);
        let tris = triangles(&v, &i);
        for _ in 0..80 {
            let a = [
                r.unit() * 8.0 - 4.0,
                r.unit() * 3.0 - 0.5,
                r.unit() * 8.0 - 4.0,
            ];
            let b = if r.unit() < 0.3 {
                a
            } else {
                [
                    a[0] + r.unit() * 3.0 - 1.5,
                    a[1] + r.unit() * 3.0 - 1.5,
                    a[2] + r.unit() * 3.0 - 1.5,
                ]
            };
            let got = f.floats("gap", packet(&v, &i, &[a, b].concat()));
            if got.is_empty() {
                continue;
            }
            let want = soup_gap(a, b, &tris);
            near(got[0], want, 2e-3 + 1e-4 * want.abs());
            compared += 1;
            crossed += usize::from(want < 0.0);
            touching += usize::from(want >= 0.0 && want < 0.3);
            // The reported points really are that far apart (or crossing).
            let d = len(sub([got[10], got[11], got[12]], [got[7], got[8], got[9]]));
            if want > 0.0 {
                near(d, want, 3e-3);
            }
        }
    }
    assert!(
        compared >= 700 && crossed >= 20 && touching >= 20,
        "{compared} {crossed} {touching}"
    );
}

fn ray_triangle(o: V, d: V, t: [V; 3]) -> Option<f64> {
    let (e1, e2) = (sub(t[1], t[0]), sub(t[2], t[0]));
    let h = cross(d, e2);
    let det = dot(e1, h);
    if det.abs() < 1e-12 {
        return None;
    }
    let s = sub(o, t[0]);
    let u = dot(s, h) / det;
    let q = cross(s, e1);
    let v = dot(d, q) / det;
    let time = dot(e2, q) / det;
    (u >= 0.0 && v >= 0.0 && u + v <= 1.0 && (0.0..=1.0).contains(&time)).then_some(time)
}

#[test]
fn mesh_rays_match_brute_force() {
    let mut f = Fixture::new("tests/mesh_collider.sq");
    let mut r = Random(3);
    let (mut hits, mut misses) = (0, 0);
    for seed in 0..10 {
        let (v, i) = random_soup(300 + seed, 30);
        let tris = triangles(&v, &i);
        for _ in 0..60 {
            let o = [
                r.unit() * 8.0 - 4.0,
                r.unit() * 4.0 - 1.0,
                r.unit() * 8.0 - 4.0,
            ];
            let d = [
                r.unit() * 8.0 - 4.0,
                r.unit() * 8.0 - 4.0,
                r.unit() * 8.0 - 4.0,
            ];
            let want = tris
                .iter()
                .filter_map(|t| ray_triangle(o, d, *t))
                .fold(f64::MAX, f64::min);
            let got = f.floats("ray", packet(&v, &i, &[o, d].concat()));
            if want == f64::MAX {
                misses += 1;
                assert_eq!(got, [0.0], "false hit");
            } else {
                hits += 1;
                assert_eq!(got[0], 1.0, "missed {want}");
                near(got[1], want, 1e-4);
                let p = add(o, mul(d, want));
                near_all(&got[2..5], &p, 1e-3);
                // Normal faces the origin.
                assert!(dot([got[5], got[6], got[7]], d) < 0.0);
            }
        }
    }
    assert!(hits >= 40 && misses >= 40, "{hits} {misses}");
}

fn contacts_of(f: &mut Fixture, v: &[V], i: &[u32], query: &[f64]) -> Vec<[f64; 7]> {
    let out = f.floats("contacts", packet(v, i, query));
    (0..out[0] as usize)
        .map(|k| out[1 + k * 7..8 + k * 7].try_into().unwrap())
        .collect()
}

#[test]
fn mesh_capsule_contacts_match_reference_in_every_region() {
    let mut f = Fixture::new("tests/mesh_collider.sq");
    let tri: [V; 3] = [[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 0.0, 2.0]];
    let (v, i) = (tri.to_vec(), vec![0u32, 2, 1]);
    // Segments chosen over the face, an edge, a vertex and beyond; spheres
    // and tilted capsules, above and below the sheet.
    let cases: [(V, V, f64); 9] = [
        ([0.5, 0.3, 0.5], [0.5, 0.3, 0.5], 0.4),
        ([1.0, 0.25, 1.0], [1.0, 0.25, 1.0], 0.3),
        ([-0.2, 0.2, 0.5], [-0.2, 0.2, 0.5], 0.3),
        ([-0.2, 0.15, -0.2], [-0.2, 0.15, -0.2], 0.3),
        ([2.2, 0.1, -0.1], [2.2, 0.1, -0.1], 0.3),
        ([0.5, -0.3, 0.5], [0.5, -0.3, 0.5], 0.4),
        ([0.4, 0.5, 0.4], [0.6, 0.2, 0.6], 0.25),
        ([-1.0, 0.2, 0.3], [0.2, 0.2, 0.3], 0.25),
        ([0.3, 0.9, 0.3], [0.3, 0.35, 0.3], 0.3),
    ];
    for (a, b, radius) in cases {
        let found = contacts_of(
            &mut f,
            &v,
            &i,
            &[&[0.0], &a[..], &b[..], &[radius, 0.0, 0.0, 0.0, 0.02]].concat(),
        );
        let d = segment_triangle(a, b, [tri[0], tri[2], tri[1]]);
        let crossing = pierces(a, b, tri).is_some();
        if !crossing && d - radius >= 0.02 {
            assert!(found.is_empty(), "{a:?} {b:?}: spurious {found:?}");
            continue;
        }
        assert!(!found.is_empty(), "{a:?} {b:?}: missing contact (d {d})");
        let deepest = found.iter().map(|c| c[6]).fold(f64::MAX, f64::min);
        if !crossing {
            near(deepest, d - radius, 2e-3);
            // The deepest contact's normal leads from the triangle to the segment.
            let c = found
                .iter()
                .find(|c| (c[6] - deepest).abs() < 1e-6)
                .unwrap();
            let mid = mul(add(a, b), 0.5);
            assert!(
                dot([c[3], c[4], c[5]], sub(mid, [c[0], c[1], c[2]])) > 0.0 || d - radius < 0.0
            );
        } else {
            assert!(deepest < -radius + 1e-3, "{deepest}");
        }
    }
}

#[test]
fn mesh_hull_contacts_match_separating_axis_reference() {
    let mut f = Fixture::new("tests/mesh_collider.sq");
    let mut r = Random(11);
    let (mut touching, mut apart, mut edge_edge) = (0, 0, 0);
    for _ in 0..160 {
        let tri: [V; 3] = std::array::from_fn(|_| [r.unit() * 3.0, r.unit() * 0.6, r.unit() * 3.0]);
        let n = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
        if len(n) < 0.5 {
            continue;
        }
        let half = [
            0.25 + 0.3 * r.unit(),
            0.25 + 0.3 * r.unit(),
            0.25 + 0.3 * r.unit(),
        ];
        let center = [r.unit() * 3.0, 0.2 + r.unit() * 1.2, r.unit() * 3.0];
        let axis = unit([r.unit() - 0.5, r.unit() - 0.5, r.unit() - 0.5 + 0.2]);
        let angle = r.unit() * 3.0;
        let found = contacts_of(
            &mut f,
            &tri.to_vec(),
            &[0, 1, 2],
            &[&[1.0], &center[..], &half[..], &axis[..], &[angle, 0.02]].concat(),
        );
        let (sep, ambiguous, face) = sat(&tri, center, half, axis, angle);
        if sep > 0.03 {
            apart += 1;
            assert!(found.is_empty(), "spurious {found:?} for sep {sep}");
        } else if sep < 0.0 || sep < 0.015 {
            touching += 1;
            if !ambiguous {
                assert!(!found.is_empty(), "missing contact for sep {sep}");
                let deepest = found.iter().map(|c| c[6]).fold(f64::MAX, f64::min);
                assert!(
                    deepest >= sep - 2e-3,
                    "contact {deepest} deeper than axis {sep}"
                );
                if !face {
                    edge_edge += 1;
                    near(deepest, sep, 2e-3);
                }
            }
        }
    }
    assert!(
        touching >= 25 && apart >= 25 && edge_edge >= 3,
        "{touching} {apart} {edge_edge}"
    );
}

/// The separating-axis separation of an oriented box and a triangle over all
/// face and edge axes: (best separation, is the winner ambiguous, face axis).
fn sat(tri: &[V; 3], c: V, h: V, axis: V, angle: f64) -> (f64, bool, bool) {
    let (s, co) = ((angle / 2.0).sin(), (angle / 2.0).cos());
    let q = [axis[0] * s, axis[1] * s, axis[2] * s, co];
    let rot = |v: V| {
        let u = [q[0], q[1], q[2]];
        let t = mul(cross(u, v), 2.0);
        add(add(v, mul(t, q[3])), cross(u, t))
    };
    let dirs = [
        rot([1.0, 0.0, 0.0]),
        rot([0.0, 1.0, 0.0]),
        rot([0.0, 0.0, 1.0]),
    ];
    let verts: Vec<V> = (0..8)
        .map(|k| {
            let mut p = c;
            for a in 0..3 {
                let sign = if k >> a & 1 == 1 { 1.0 } else { -1.0 };
                p = add(p, mul(dirs[a], h[a] * sign));
            }
            p
        })
        .collect();
    let edges = [
        sub(tri[1], tri[0]),
        sub(tri[2], tri[1]),
        sub(tri[0], tri[2]),
    ];
    let mut axes: Vec<(V, bool)> = dirs.iter().map(|d| (*d, true)).collect();
    axes.push((unit(cross(edges[0], sub(tri[2], tri[0]))), true));
    for d in dirs {
        for e in edges {
            let x = cross(d, e);
            if len(x) > 1e-6 {
                axes.push((unit(x), false));
            }
        }
    }
    let mut scored: Vec<(f64, bool)> = axes
        .iter()
        .map(|(n, face)| {
            let (bmin, bmax) = verts
                .iter()
                .map(|p| dot(*p, *n))
                .fold((f64::MAX, f64::MIN), |a, x| (a.0.min(x), a.1.max(x)));
            let (tmin, tmax) = tri
                .iter()
                .map(|p| dot(*p, *n))
                .fold((f64::MAX, f64::MIN), |a, x| (a.0.min(x), a.1.max(x)));
            ((bmin - tmax).max(tmin - bmax), *face)
        })
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    // Face and edge axes within a few millimetres are interchangeable.
    let ambiguous =
        scored.len() > 1 && scored[0].0 - scored[1].0 < 0.004 && scored[0].1 != scored[1].1;
    (scored[0].0, ambiguous, scored[0].1)
}

// ---- Simulation witnesses -----------------------------------------------------

struct BodySpec {
    shape: f64,
    position: V,
    size: V,
    velocity: V,
    friction: f64,
}
fn bx(position: V, velocity: V) -> BodySpec {
    BodySpec {
        shape: 0.0,
        position,
        size: [1.0; 3],
        velocity,
        friction: 0.6,
    }
}
#[derive(Clone, Copy)]
struct Floor {
    kind: f64,
    n: f64,
    size: f64,
    param: f64,
}
struct Trace {
    count: usize,
    ticks: usize,
    data: Vec<f64>,
}
impl Trace {
    fn at(&self, tick: usize, body: usize) -> &[f64] {
        &self.data[(tick * self.count + body) * 6..(tick * self.count + body) * 6 + 6]
    }
    fn asleep(&self, body: usize) -> bool {
        self.data[self.ticks * self.count * 6 + body] == 1.0
    }
}
fn world(
    f: &mut Fixture,
    floor: &Floor,
    ticks: usize,
    fast: bool,
    sleep: bool,
    bodies: &[BodySpec],
) -> Trace {
    let mut a = vec![
        floor.kind,
        floor.n,
        floor.size,
        floor.param,
        ticks as f64,
        fast as u32 as f64,
        bodies.len() as f64,
        sleep as u32 as f64,
    ];
    for b in bodies {
        a.push(b.shape);
        a.extend(b.position);
        a.extend(b.size);
        a.extend(b.velocity);
        a.push(b.friction);
        a.extend([0.0; 3]);
    }
    let data = f.floats("world", a);
    assert_eq!(data.len(), ticks * bodies.len() * 6 + bodies.len());
    assert!(data.iter().all(|x| x.is_finite()), "non-finite state");
    Trace {
        count: bodies.len(),
        ticks,
        data,
    }
}

#[test]
fn box_and_capsule_slide_over_a_tessellated_floor_without_bumps() {
    let mut f = Fixture::new("tests/mesh_collider.sq");
    // A box, a sphere and a capsule sliding at 4 m/s over 144 triangles with
    // alternating diagonals: seams every 0.83 m, crossed at every angle.
    let floor = Floor {
        kind: 0.0,
        n: 12.0,
        size: 10.0,
        param: 0.0,
    };
    let mut slider = bx([-4.0, 0.5, -3.0], [5.0, 0.0, 0.7]);
    slider.friction = 0.05;
    let bodies = [
        slider,
        BodySpec {
            shape: 2.0,
            position: [-4.0, 0.5, 0.0],
            size: [0.5, 0.0, 0.0],
            velocity: [5.0, 0.0, 1.1],
            friction: 0.05,
        },
        BodySpec {
            shape: 3.0,
            position: [-4.0, 0.4, 3.0],
            size: [0.4, 1.6, 0.0],
            velocity: [5.0, 0.0, -0.5],
            friction: 0.05,
        },
    ];
    let t = world(&mut f, &floor, 90, false, false, &bodies);
    let hull = world(
        &mut f,
        &Floor {
            kind: 100.0,
            ..floor
        },
        90,
        false,
        false,
        &bodies,
    );
    for (i, rest) in [(0usize, 0.5), (1, 0.5), (2, 0.4)] {
        let baseline = (20..hull.ticks)
            .map(|k| hull.at(k, i)[4].abs())
            .fold(0.0, f64::max);
        let mut crossed = 0;
        let mut worst = 0.0f64;
        let mut sag = 0.0f64;
        let mut last_x: f64 = -10.0;
        for tick in 20..t.ticks {
            let s = t.at(tick, i);
            worst = worst.max(s[4].abs());
            if rest > 0.0 {
                sag = sag.max((s[1] - rest).abs());
            }
            crossed += usize::from(
                ((s[0] + 5.0) / (10.0 / 12.0)).floor() != ((last_x + 5.0) / (10.0 / 12.0)).floor(),
            );
            last_x = s[0];
        }
        assert!(
            worst < 0.04f64.max(baseline + 0.02),
            "body {i}: vertical speed spiked to {worst} (box floor {baseline})"
        );
        assert!(sag < 0.02, "body {i}: bounced {sag} off its resting height");
        assert!(crossed >= 3, "body {i} crossed only {crossed} seams");
        // It really slid: far from its start, moving forward.
        assert!(
            t.at(t.ticks - 1, i)[0] > -1.5,
            "body {i} stopped at {}",
            t.at(t.ticks - 1, i)[0]
        );
    }
}

fn stack(count: usize, offset: f64) -> Vec<BodySpec> {
    (0..count)
        .map(|i| {
            bx(
                [offset + 0.01 * i as f64, 0.5 + i as f64 * 1.001, 0.0],
                [0.0; 3],
            )
        })
        .collect()
}
fn bits(t: &Trace) -> Vec<u64> {
    t.data.iter().map(|x| x.to_bits()).collect()
}

#[test]
fn stacking_on_a_mesh_floor_matches_a_hull_floor_and_sleeps() {
    let mut f = Fixture::new("tests/mesh_collider.sq");
    let mesh = Floor {
        kind: 0.0,
        n: 6.0,
        size: 10.0,
        param: 0.0,
    };
    let hull = Floor {
        kind: 100.0,
        ..mesh
    };
    let bodies = stack(6, 0.3);
    let on_mesh = world(&mut f, &mesh, 420, false, true, &bodies);
    let on_hull = world(&mut f, &hull, 420, false, true, &bodies);
    for tick in [60, 200, 419] {
        for i in 0..bodies.len() {
            let (a, b) = (on_mesh.at(tick, i), on_hull.at(tick, i));
            for k in 0..3 {
                near(a[k], b[k], 0.03);
            }
        }
    }
    // Standing: heights within 3 cm of the ideal stack and drift small.
    for i in 0..bodies.len() {
        let s = on_mesh.at(419, i);
        near(s[1], 0.5 + i as f64, 0.06);
        assert!(
            (s[0] - 0.3).abs() < 0.2 && s[2].abs() < 0.2,
            "body {i} drifted to {s:?}"
        );
        assert_eq!(
            on_mesh.asleep(i),
            on_hull.asleep(i),
            "body {i} sleeps differently"
        );
    }
    // A tall awake tower stays up as long as it does on the hull floor.
    let tall = stack(12, 0.0);
    let awake = world(&mut f, &mesh, 600, false, false, &tall);
    let base = world(&mut f, &hull, 600, false, false, &tall);
    for i in 0..tall.len() {
        let (a, b) = (awake.at(599, i), base.at(599, i));
        near(a[1], b[1], 0.1);
        assert!((a[0] - b[0]).abs() < 0.15 && (a[2] - b[2]).abs() < 0.15);
    }
}

#[test]
fn mesh_simulation_replays_bit_for_bit_and_prepared_matches_rebuilt() {
    let mut f = Fixture::new("tests/mesh_collider.sq");
    let floors = [
        Floor {
            kind: 0.0,
            n: 6.0,
            size: 24.0,
            param: 0.0,
        },
        Floor {
            kind: 3.0,
            n: 16.0,
            size: 24.0,
            param: 0.15,
        },
        Floor {
            kind: 1.0,
            n: 8.0,
            size: 24.0,
            param: 0.3,
        },
    ];
    let mut r = Random(41);
    let bodies: Vec<BodySpec> = (0..8)
        .map(|i| BodySpec {
            shape: (i % 3) as f64,
            position: [
                r.unit() * 6.0 - 3.0,
                1.0 + r.unit() * 2.0,
                r.unit() * 6.0 - 3.0,
            ],
            size: [0.4 + r.unit() * 0.3, 0.8 + r.unit() * 0.5, 0.6],
            velocity: [r.unit() * 3.0 - 1.5, 0.0, r.unit() * 3.0 - 1.5],
            friction: 0.6,
        })
        .collect();
    for floor in floors {
        let first = world(&mut f, &floor, 240, false, true, &bodies);
        let again = world(&mut f, &floor, 240, false, true, &bodies);
        assert_eq!(
            bits(&first),
            bits(&again),
            "replay differs on floor {}",
            floor.kind
        );
        let fast = world(&mut f, &floor, 240, true, true, &bodies);
        assert_eq!(
            bits(&first),
            bits(&fast),
            "prepared differs from rebuilt on floor {}",
            floor.kind
        );
        // Everything settles above the surface and stays finite.
        for i in 0..bodies.len() {
            let p = first.at(239, i);
            let surface = match floor.kind as u32 {
                1 => floor.param * p[0],
                3 => floor.param * (1.3 * p[0]).sin() * (0.9 * p[2]).cos(),
                _ => 0.0,
            };
            assert!(
                p[1] > surface - 0.1,
                "body {i} fell through floor {}: {p:?}",
                floor.kind
            );
        }
    }
}

#[test]
fn a_box_dropped_on_a_mesh_comes_to_rest_and_sleeps() {
    let mut f = Fixture::new("tests/mesh_collider.sq");
    let floor = Floor {
        kind: 3.0,
        n: 12.0,
        size: 10.0,
        param: 0.0,
    };
    let t = world(
        &mut f,
        &floor,
        240,
        true,
        true,
        &[bx([0.2, 2.0, 0.1], [0.5, 0.0, 0.3])],
    );
    near(t.at(239, 0)[1], 0.5, 0.02);
    assert!(t.asleep(0), "never slept");
    assert!(t.at(239, 0)[3..].iter().all(|v| v.abs() < 1e-3));
}

fn walk(
    f: &mut Fixture,
    floor: &Floor,
    ticks: usize,
    start: V,
    velocity: [f64; 2],
) -> Vec<[f64; 4]> {
    let a = vec![
        floor.kind,
        floor.n,
        floor.size,
        floor.param,
        ticks as f64,
        start[0],
        start[1],
        start[2],
        velocity[0],
        velocity[1],
    ];
    let out = f.floats("walk", a);
    assert_eq!(out.len(), ticks * 4);
    assert!(out.iter().all(|x| x.is_finite()));
    out.chunks(4).map(|c| c.try_into().unwrap()).collect()
}

#[test]
fn character_walks_over_mesh_stairs_and_slopes() {
    let mut f = Fixture::new("tests/mesh_collider.sq");
    // Eight 15 cm steps, 40 cm deep, then a landing.
    let stairs = Floor {
        kind: 2.0,
        n: 8.0,
        size: 8.0,
        param: 0.15,
    };
    let trace = walk(&mut f, &stairs, 240, [-2.0, 0.05, 0.0], [2.0, 0.0]);
    let end = trace[trace.len() - 1];
    near(end[1], 1.2, 0.03);
    assert!(end[0] > 4.0 && end[3] == 1.0, "ended at {end:?}");
    let mut worst_jump = 0.0f64;
    for k in 1..trace.len() {
        worst_jump = worst_jump.max((trace[k][1] - trace[k - 1][1]).abs());
    }
    assert!(worst_jump < 0.2, "popped {worst_jump} in one tick");
    // Grounded almost throughout the climb.
    let airborne = trace.iter().skip(30).filter(|t| t[3] == 0.0).count();
    assert!(airborne <= 12, "{airborne} airborne ticks");
    // A 20 degree slope is climbed, a 60 degree one is not.
    let gentle = Floor {
        kind: 1.0,
        n: 10.0,
        size: 16.0,
        param: 20.0f64.to_radians().tan(),
    };
    let up = walk(
        &mut f,
        &gentle,
        150,
        [-3.0, -3.0 * gentle.param, 0.0],
        [2.5, 0.0],
    );
    let end = up[up.len() - 1];
    assert!(
        end[3] == 1.0 && end[0] > 2.0,
        "stuck on the gentle slope at {end:?}"
    );
    near(end[1], gentle.param * end[0], 0.04);
    let steep = Floor {
        kind: 1.0,
        n: 10.0,
        size: 16.0,
        param: 60.0f64.to_radians().tan(),
    };
    let blocked = walk(
        &mut f,
        &steep,
        150,
        [-0.6, -0.6 * steep.param, 0.0],
        [2.5, 0.0],
    );
    let end = blocked[blocked.len() - 1];
    assert!(end[0] < 0.5, "walked up the steep slope to {end:?}");
    // Walking down keeps the feet on the surface.
    let down = walk(
        &mut f,
        &gentle,
        120,
        [3.0, 3.0 * gentle.param + 0.01, 0.0],
        [-2.5, 0.0],
    );
    let grounded = down.iter().skip(5).filter(|t| t[3] == 1.0).count();
    assert!(grounded >= 105, "only {grounded} grounded ticks going down");
    let end = down[down.len() - 1];
    near(end[1], gentle.param * end[0], 0.05);
}

#[test]
fn updating_a_scene_with_a_mesh_matches_rebuilding_it() {
    let mut f = Fixture::new("tests/mesh_collider.sq");
    for (kind, param) in [(0, 0.0), (1, 0.3), (2, 0.2)] {
        let (v, i) = match kind {
            2 => stairs(5, 6.0, param),
            _ => grid(7, 6.0, |x, _| if kind == 1 { param * x } else { 0.0 }),
        };
        let out = f.floats(
            "update_parity",
            packet(&v, &i, &[[-1.0, 2.0, 0.0], [0.7, 1.4, 0.3]].concat()),
        );
        let half = out.len() / 2;
        assert!(half > 100);
        assert_eq!(
            &out[..half],
            &out[half..],
            "kind {kind}: updated scene differs from a rebuild"
        );
        // The probes see the mesh: some rays hit.
        assert!(out[..half].iter().filter(|x| **x == 1.0).count() > 6);
    }
}

fn stairs(n: usize, size: f64, rise: f64) -> (Vec<V>, Vec<u32>) {
    let half = size / 2.0;
    let mut profile = vec![[-half, 0.0]];
    for k in 0..n {
        profile.push([0.4 * k as f64, rise * k as f64]);
        profile.push([0.4 * k as f64, rise * (k + 1) as f64]);
    }
    profile.push([0.4 * n as f64, rise * n as f64]);
    profile.push([0.4 * n as f64 + half, rise * n as f64]);
    let mut v = vec![];
    for p in &profile {
        v.push([p[0], p[1], -half]);
        v.push([p[0], p[1], half]);
    }
    let mut i = vec![];
    for s in 0..profile.len() - 1 {
        let a = 2 * s as u32;
        i.extend([a, a + 1, a + 2, a + 1, a + 3, a + 2]);
    }
    (v, i)
}

fn cooked(f: &mut Fixture, v: &[V], i: &[u32]) -> f64 {
    f.floats("cooked", packet(v, i, &[]))[0]
}

#[test]
fn degenerate_and_malformed_meshes_are_rejected_or_cleaned() {
    let mut f = Fixture::new("tests/mesh_collider.sq");
    let square: Vec<V> = vec![
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [1.0, 0.0, 1.0],
        [0.0, 0.0, 1.0],
    ];
    assert_eq!(cooked(&mut f, &square, &[0, 2, 1, 0, 3, 2]), 2.0);
    // Empty and malformed: nothing to collide with.
    assert_eq!(cooked(&mut f, &square, &[]), 0.0);
    assert_eq!(cooked(&mut f, &[], &[]), 0.0);
    assert_eq!(cooked(&mut f, &square, &[0, 1]), 0.0);
    assert_eq!(cooked(&mut f, &square, &[0, 1, 4]), 0.0);
    // Non-finite coordinates reject the whole mesh.
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut v = square.clone();
        v[2][1] = bad;
        assert_eq!(cooked(&mut f, &v, &[0, 2, 1, 0, 3, 2]), 0.0, "{bad}");
    }
    // Zero-area, repeated-corner and collinear triangles are dropped.
    let mut v = square.clone();
    v.push([2.0, 0.0, 0.0]);
    v.push([0.5, 0.0, 0.0]);
    assert_eq!(
        cooked(&mut f, &v, &[0, 2, 1, 0, 0, 1, 0, 1, 4, 1, 4, 5]),
        1.0
    );
    assert_eq!(cooked(&mut f, &v, &[0, 0, 0, 1, 1, 1]), 0.0);
    // A sliver thinner than 1e-5 of its length is dropped; a thin one is kept.
    let thin: Vec<V> = vec![
        [0.0, 0.0, 0.0],
        [10.0, 0.0, 0.0],
        [5.0, 0.0, 1e-7],
        [5.0, 0.0, 0.01],
    ];
    assert_eq!(cooked(&mut f, &thin, &[0, 1, 2]), 0.0);
    assert_eq!(cooked(&mut f, &thin, &[0, 1, 3]), 1.0);
    // Duplicate vertices at one position weld, so the shared edge stays smooth.
    let dup: Vec<V> = vec![
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 0.0],
        [1.0, 0.0, 1.0],
        [0.0, 0.0, 1.0],
    ];
    let out = f.floats("cook", packet(&dup, &[0, 2, 1, 3, 4, 5], &[]));
    assert_eq!(out[0], 2.0);
    // Tri 0's second edge is the diagonal both triangles list with separate
    // copies of its endpoints: welded, tri 1 is its neighbour and the seam smooth.
    assert_eq!(
        out[9], 1.0,
        "duplicate vertices must weld into a shared edge"
    );
    assert_eq!((out[7] as u32 >> 2) & 3, 1);
    // Identical triangles listed twice: the shared edges are non-manifold, so
    // all active, and queries still work.
    let twice = f.floats(
        "gap",
        packet(
            &square,
            &[0, 2, 1, 0, 2, 1],
            &[[0.5, 0.3, 0.2], [0.5, 0.3, 0.2]].concat(),
        ),
    );
    near(twice[0], 0.3, 1e-4);
}

#[test]
fn debug_draws_every_mesh_edge_once() {
    let mut f = Fixture::new("tests/mesh_collider.sq");
    for n in [1usize, 3, 5] {
        let (v, i) = grid(n, 4.0, |_, _| 0.0);
        // Horizontal and vertical lattice edges plus one diagonal per cell.
        let edges = 2 * n * (n + 1) + n * n;
        assert_eq!(
            f.floats("debug_lines", packet(&v, &i, &[]))[0],
            edges as f64
        );
    }
}

#[test]
fn non_finite_queries_return_without_hitting_anything() {
    let mut f = Fixture::new("tests/mesh_collider.sq");
    let (v, i) = grid(3, 4.0, |_, _| 0.0);
    let nan = f64::NAN;
    let gap = f.floats(
        "gap",
        packet(&v, &i, &[[nan, 1.0, 0.0], [0.0, 1.0, 0.0]].concat()),
    );
    assert!(gap[0] >= 1e8, "{gap:?}");
    assert_eq!(
        f.floats(
            "ray",
            packet(&v, &i, &[[nan, 1.0, 0.0], [0.0, -2.0, 0.0]].concat())
        ),
        [0.0]
    );
    assert_eq!(
        f.floats(
            "ray",
            packet(&v, &i, &[[0.0, 1.0, 0.0], [nan, -2.0, 0.0]].concat())
        ),
        [0.0]
    );
    let found = contacts_of(
        &mut f,
        &v,
        &i,
        &[
            &[0.0],
            &[nan, 0.3, 0.0][..],
            &[0.0, 0.3, 0.0][..],
            &[0.5, 0.0, 0.0, 0.0, 0.02],
        ]
        .concat(),
    );
    assert!(found.is_empty());
}
