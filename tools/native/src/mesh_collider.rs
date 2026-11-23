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
    let mut f = Fixture::new("tests/mesh_collider.blot");
    let (v, i) = grid(2, 4.0, |_, _| 0.0);
    let out = f.floats("cook", packet(&v, &i, &[]));
    println!("{out:?}");
    assert_eq!(out[0], 8.0);
}

// ---- Independent references (f64) -------------------------------------------
fn sub(a: V, b: V) -> V { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
fn add(a: V, b: V) -> V { [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
fn mul(a: V, k: f64) -> V { [a[0] * k, a[1] * k, a[2] * k] }
fn dot(a: V, b: V) -> f64 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
fn cross(a: V, b: V) -> V { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
fn len(a: V) -> f64 { dot(a, a).sqrt() }
fn unit(a: V) -> V { mul(a, 1.0 / len(a)) }

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
        (0..3).map(|i| point_segment(p, t[i], t[(i + 1) % 3])).fold(f64::MAX, f64::min)
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
    i.chunks(3).map(|c| [v[c[0] as usize], v[c[1] as usize], v[c[2] as usize]]).collect()
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
            v.push([c[0] + r.unit() * 2.0 - 1.0, c[1] + r.unit() * 2.0 - 1.0, c[2] + r.unit() * 2.0 - 1.0]);
        }
        i.extend([3 * k as u32, 3 * k as u32 + 1, 3 * k as u32 + 2]);
    }
    (v, i)
}

#[test]
fn mesh_segment_gaps_match_brute_force() {
    let mut f = Fixture::new("tests/mesh_collider.blot");
    let mut r = Random(7);
    let (mut compared, mut crossed, mut touching) = (0, 0, 0);
    for seed in 0..12 {
        let (v, i) = random_soup(100 + seed, 14);
        let tris = triangles(&v, &i);
        for _ in 0..80 {
            let a = [r.unit() * 8.0 - 4.0, r.unit() * 3.0 - 0.5, r.unit() * 8.0 - 4.0];
            let b = if r.unit() < 0.3 { a } else { [a[0] + r.unit() * 3.0 - 1.5, a[1] + r.unit() * 3.0 - 1.5, a[2] + r.unit() * 3.0 - 1.5] };
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
    assert!(compared >= 700 && crossed >= 20 && touching >= 20, "{compared} {crossed} {touching}");
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
    let mut f = Fixture::new("tests/mesh_collider.blot");
    let mut r = Random(3);
    let (mut hits, mut misses) = (0, 0);
    for seed in 0..10 {
        let (v, i) = random_soup(300 + seed, 30);
        let tris = triangles(&v, &i);
        for _ in 0..60 {
            let o = [r.unit() * 8.0 - 4.0, r.unit() * 4.0 - 1.0, r.unit() * 8.0 - 4.0];
            let d = [r.unit() * 8.0 - 4.0, r.unit() * 8.0 - 4.0, r.unit() * 8.0 - 4.0];
            let want = tris.iter().filter_map(|t| ray_triangle(o, d, *t)).fold(f64::MAX, f64::min);
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
    (0..out[0] as usize).map(|k| out[1 + k * 7..8 + k * 7].try_into().unwrap()).collect()
}

#[test]
fn mesh_capsule_contacts_match_reference_in_every_region() {
    let mut f = Fixture::new("tests/mesh_collider.blot");
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
        let found = contacts_of(&mut f, &v, &i, &[&[0.0], &a[..], &b[..], &[radius, 0.0, 0.0, 0.0, 0.02]].concat());
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
            let c = found.iter().find(|c| (c[6] - deepest).abs() < 1e-6).unwrap();
            let mid = mul(add(a, b), 0.5);
            assert!(dot([c[3], c[4], c[5]], sub(mid, [c[0], c[1], c[2]])) > 0.0 || d - radius < 0.0);
        } else {
            assert!(deepest < -radius + 1e-3, "{deepest}");
        }
    }
}

#[test]
fn mesh_hull_contacts_match_separating_axis_reference() {
    let mut f = Fixture::new("tests/mesh_collider.blot");
    let mut r = Random(11);
    let (mut touching, mut apart, mut edge_edge) = (0, 0, 0);
    for _ in 0..160 {
        let tri: [V; 3] = std::array::from_fn(|_| [r.unit() * 3.0, r.unit() * 0.6, r.unit() * 3.0]);
        let n = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
        if len(n) < 0.5 {
            continue;
        }
        let half = [0.25 + 0.3 * r.unit(), 0.25 + 0.3 * r.unit(), 0.25 + 0.3 * r.unit()];
        let center = [r.unit() * 3.0, 0.2 + r.unit() * 1.2, r.unit() * 3.0];
        let axis = unit([r.unit() - 0.5, r.unit() - 0.5, r.unit() - 0.5 + 0.2]);
        let angle = r.unit() * 3.0;
        let found = contacts_of(&mut f, &tri.to_vec(), &[0, 1, 2], &[&[1.0], &center[..], &half[..], &axis[..], &[angle, 0.02]].concat());
        let (sep, ambiguous, face) = sat(&tri, center, half, axis, angle);
        if sep > 0.03 {
            apart += 1;
            assert!(found.is_empty(), "spurious {found:?} for sep {sep}");
        } else if sep < 0.0 || sep < 0.015 {
            touching += 1;
            if !ambiguous {
                assert!(!found.is_empty(), "missing contact for sep {sep}");
                let deepest = found.iter().map(|c| c[6]).fold(f64::MAX, f64::min);
                assert!(deepest >= sep - 2e-3, "contact {deepest} deeper than axis {sep}");
                if !face {
                    edge_edge += 1;
                    near(deepest, sep, 2e-3);
                }
            }
        }
    }
    assert!(touching >= 25 && apart >= 25 && edge_edge >= 3, "{touching} {apart} {edge_edge}");
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
    let dirs = [rot([1.0, 0.0, 0.0]), rot([0.0, 1.0, 0.0]), rot([0.0, 0.0, 1.0])];
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
    let edges = [sub(tri[1], tri[0]), sub(tri[2], tri[1]), sub(tri[0], tri[2])];
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
            let (bmin, bmax) = verts.iter().map(|p| dot(*p, *n)).fold((f64::MAX, f64::MIN), |a, x| (a.0.min(x), a.1.max(x)));
            let (tmin, tmax) = tri.iter().map(|p| dot(*p, *n)).fold((f64::MAX, f64::MIN), |a, x| (a.0.min(x), a.1.max(x)));
            ((bmin - tmax).max(tmin - bmax), *face)
        })
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    // Face and edge axes within a few millimetres are interchangeable.
    let ambiguous = scored.len() > 1 && scored[0].0 - scored[1].0 < 0.004 && scored[0].1 != scored[1].1;
    (scored[0].0, ambiguous, scored[0].1)
}
