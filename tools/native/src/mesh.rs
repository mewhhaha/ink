//! Independent references for the navigation mesh: polygon Dijkstra, a
//! visibility-graph shortest path through portals, brute-force point location,
//! closest point, segment coverage and grid coverage.
use super::*;

type P = [f64; 3];
struct Mesh {
    pos: Vec<P>,
    polys: Vec<Vec<usize>>,
}
const NONE: f64 = -1.0;

fn encode(m: &Mesh) -> Vec<f64> {
    let mut out = vec![
        m.pos.len() as f64,
        m.polys.len() as f64,
        m.polys.iter().map(Vec::len).sum::<usize>() as f64,
    ];
    for p in &m.pos {
        out.extend(p);
    }
    out.extend(m.polys.iter().map(|p| p.len() as f64));
    for poly in &m.polys {
        out.extend(poly.iter().map(|&i| i as f64));
    }
    out
}
fn cross(a: (f64, f64), b: (f64, f64), c: (f64, f64)) -> f64 {
    (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
}
fn xz(m: &Mesh, v: usize) -> (f64, f64) {
    (m.pos[v][0], m.pos[v][2])
}
fn dist(a: (f64, f64), b: (f64, f64)) -> f64 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}
fn inside(m: &Mesh, p: usize, q: (f64, f64), slack: f64) -> bool {
    let poly = &m.polys[p];
    (0..poly.len()).all(|i| {
        let a = xz(m, poly[i]);
        let b = xz(m, poly[(i + 1) % poly.len()]);
        cross(a, b, q) >= -slack * dist(a, b)
    })
}
fn centre(m: &Mesh, p: usize) -> (f64, f64) {
    let poly = &m.polys[p];
    let a = xz(m, poly[0]);
    let (mut area, mut x, mut z) = (0.0, 0.0, 0.0);
    for i in 1..poly.len() - 1 {
        let (b, c) = (xz(m, poly[i]), xz(m, poly[i + 1]));
        let w = cross(a, b, c);
        area += w;
        x += w * (a.0 + b.0 + c.0);
        z += w * (a.1 + b.1 + c.1);
    }
    (x / (3.0 * area), z / (3.0 * area))
}
/// links[p][i]: polygon across edge i of p.
fn links(m: &Mesh) -> Vec<Vec<Option<usize>>> {
    let mut edges = std::collections::HashMap::new();
    for (p, poly) in m.polys.iter().enumerate() {
        for i in 0..poly.len() {
            edges.insert((poly[i], poly[(i + 1) % poly.len()]), p);
        }
    }
    m.polys
        .iter()
        .map(|poly| {
            (0..poly.len())
                .map(|i| edges.get(&(poly[(i + 1) % poly.len()], poly[i])).copied())
                .collect()
        })
        .collect()
}
/// The portal run from p into q as (right end a, left end b) vertex ids.
fn portal(m: &Mesh, l: &[Vec<Option<usize>>], p: usize, q: usize) -> (usize, usize) {
    let n = m.polys[p].len();
    for i in 0..n {
        if l[p][i] == Some(q) && l[p][(i + n - 1) % n] != Some(q) {
            let mut len = 1;
            while len < n && l[p][(i + len) % n] == Some(q) {
                len += 1;
            }
            return (m.polys[p][i], m.polys[p][(i + len) % n]);
        }
    }
    panic!("no portal")
}
fn step_cost(m: &Mesh, l: &[Vec<Option<usize>>], p: usize, q: usize) -> f64 {
    let (a, b) = portal(m, l, p, q);
    let (pa, pb) = (xz(m, a), xz(m, b));
    let mid = ((pa.0 + pb.0) / 2.0, (pa.1 + pb.1) / 2.0);
    dist(centre(m, p), mid) + dist(mid, centre(m, q))
}
/// Brute-force O(n^2) Dijkstra; None when unreachable.
fn dijkstra(m: &Mesh, s: usize, sp: (f64, f64), g: usize, gp: (f64, f64)) -> Option<f64> {
    if s == g {
        return Some(dist(sp, gp));
    }
    let l = links(m);
    let n = m.polys.len();
    let mut d = vec![f64::INFINITY; n];
    let mut done = vec![false; n];
    d[s] = dist(sp, centre(m, s));
    for _ in 0..n {
        let Some(p) = (0..n)
            .filter(|&i| !done[i] && d[i].is_finite())
            .min_by(|&a, &b| d[a].total_cmp(&d[b]))
        else {
            break;
        };
        done[p] = true;
        for q in l[p]
            .iter()
            .flatten()
            .copied()
            .collect::<std::collections::BTreeSet<_>>()
        {
            d[q] = d[q].min(d[p] + step_cost(m, &l, p, q));
        }
    }
    d[g].is_finite().then(|| d[g] + dist(centre(m, g), gp))
}
fn jittered(seed: u32, columns: usize, rows: usize, hole: f64) -> Mesh {
    let mut r = Random(seed);
    let mut pos = Vec::new();
    for j in 0..=rows {
        for i in 0..=columns {
            pos.push([
                i as f64 + (r.unit() - 0.5) * 0.5,
                r.unit() * 3.0,
                j as f64 + (r.unit() - 0.5) * 0.5,
            ]);
        }
    }
    let at = |i: usize, j: usize| j * (columns + 1) + i;
    let mut polys = Vec::new();
    for j in 0..rows {
        for i in 0..columns {
            if r.unit() < hole {
                continue;
            }
            let (a, b, c, d) = (at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
            match r.word() % 3 {
                0 => polys.push(vec![a, b, c, d]),
                1 => polys.extend([vec![a, b, c], vec![a, c, d]]),
                _ => polys.extend([vec![a, b, d], vec![b, c, d]]),
            }
        }
    }
    Mesh { pos, polys }
}
fn route_input(
    m: &Mesh,
    radius: f64,
    s: (f64, f64),
    g: (f64, f64),
    limit: f64,
    cell: f64,
) -> Vec<f64> {
    let mut v = vec![radius, s.0, s.1, g.0, g.1, limit, cell];
    v.extend(encode(m));
    v
}
struct Routed {
    status: u32,
    cost: f64,
    expanded: u32,
    corridor: Vec<usize>,
    path: Vec<P>,
}
fn routed(r: &[f64]) -> Routed {
    let n = r[3] as usize;
    let corridor = r[4..4 + n].iter().map(|&x| x as usize).collect();
    let k = r[4 + n] as usize;
    let path = r[5 + n..5 + n + k * 3]
        .chunks(3)
        .map(|c| [c[0], c[1], c[2]])
        .collect();
    Routed {
        status: r[0] as u32,
        cost: r[1],
        expanded: r[2] as u32,
        corridor,
        path,
    }
}
fn path_length(path: &[P]) -> f64 {
    path.windows(2)
        .map(|w| dist((w[0][0], w[0][2]), (w[1][0], w[1][2])))
        .sum()
}
fn locate_ref(m: &Mesh, q: (f64, f64)) -> Option<usize> {
    (0..m.polys.len()).find(|&p| inside(m, p, q, 1e-5))
}
/// Shortest path through the portal sequence by visibility-graph dynamic
/// programming over portal endpoints, independent of the funnel.
fn portal_shortest(m: &Mesh, corridor: &[usize], s: (f64, f64), g: (f64, f64)) -> f64 {
    let l = links(m);
    let mut nodes = vec![(s, 0usize)];
    let mut portals = vec![];
    for w in corridor.windows(2) {
        let (a, b) = portal(m, &l, w[0], w[1]);
        portals.push((xz(m, a), xz(m, b)));
        nodes.push((xz(m, a), portals.len()));
        nodes.push((xz(m, b), portals.len()));
    }
    nodes.push((g, portals.len() + 1));
    let mut best = vec![f64::INFINITY; nodes.len()];
    best[0] = 0.0;
    for j in 1..nodes.len() {
        for i in 0..j {
            if nodes[i].1 >= nodes[j].1 || !best[i].is_finite() {
                continue;
            }
            let (p, q) = (nodes[i].0, nodes[j].0);
            let ok = (nodes[i].1 + 1..nodes[j].1).all(|t| {
                let (a, b) = portals[t - 1];
                let (ca, cb) = (cross(p, q, a), cross(p, q, b));
                let e = 1e-6;
                (ca <= e && cb >= -e) || (ca >= -e && cb <= e)
            });
            if ok {
                best[j] = best[j].min(best[i] + dist(p, q));
            }
        }
    }
    *best.last().unwrap()
}
fn midpoint_length(m: &Mesh, corridor: &[usize], s: (f64, f64), g: (f64, f64)) -> f64 {
    let l = links(m);
    let mut points = vec![s];
    for w in corridor.windows(2) {
        let (a, b) = portal(m, &l, w[0], w[1]);
        let (pa, pb) = (xz(m, a), xz(m, b));
        points.push(((pa.0 + pb.0) / 2.0, (pa.1 + pb.1) / 2.0));
    }
    points.push(g);
    points.windows(2).map(|w| dist(w[0], w[1])).sum()
}

#[test]
fn polygon_search_matches_brute_force_dijkstra_and_funnel_is_shortest() {
    let mut f = Fixture::new("tests/navigation_mesh.sq");
    let mut checked = 0;
    let mut unreachable = 0;
    for seed in 1..=60u32 {
        let m = jittered(seed, 7, 6, 0.2);
        let mut r = Random(seed * 77);
        for _ in 0..6 {
            let pick = |r: &mut Random| {
                let p = r.word() as usize % m.polys.len();
                // Random interior point of the polygon (convex combination).
                let poly = &m.polys[p];
                let (u, v) = (r.unit(), r.unit());
                let a = xz(&m, poly[0]);
                let b = xz(&m, poly[1]);
                let c2 = xz(&m, poly[2]);
                let (u, v) = if u + v > 1.0 {
                    (1.0 - u, 1.0 - v)
                } else {
                    (u, v)
                };
                let q = (
                    a.0 + (b.0 - a.0) * u + (c2.0 - a.0) * v,
                    a.1 + (b.1 - a.1) * u + (c2.1 - a.1) * v,
                );
                (p, q)
            };
            let (_, s) = pick(&mut r);
            let (_, g) = pick(&mut r);
            let (Some(ls), Some(lg)) = (locate_ref(&m, s), locate_ref(&m, g)) else {
                continue;
            };
            let out = f.floats("route", route_input(&m, 0.0, s, g, 100000.0, 2.0));
            let got = routed(&out);
            let want = dijkstra(&m, ls, s, lg, g);
            match want {
                None => {
                    assert_eq!(got.status, 1, "seed {seed}");
                    assert!(got.corridor.is_empty() && got.path.is_empty());
                    unreachable += 1;
                }
                Some(cost) => {
                    assert_eq!(got.status, 0, "seed {seed}");
                    near(got.cost, cost, 1e-3 * cost.max(1.0));
                    // The returned corridor is a real chain of linked polygons
                    // whose summed cost is the reported cost.
                    let l = links(&m);
                    let c = &got.corridor;
                    assert_eq!((c[0], *c.last().unwrap()), (ls, lg));
                    let mut sum = if c.len() == 1 {
                        dist(s, g)
                    } else {
                        dist(s, centre(&m, c[0])) + dist(centre(&m, *c.last().unwrap()), g)
                    };
                    for w in c.windows(2) {
                        assert!(l[w[0]].contains(&Some(w[1])));
                        sum += step_cost(&m, &l, w[0], w[1]);
                    }
                    near(sum, got.cost, 1e-3 * sum.max(1.0));
                    // Funnel: equals the visibility shortest path, never longer
                    // than the portal midpoint polyline, and stays in the corridor.
                    let length = path_length(&got.path);
                    let shortest = portal_shortest(&m, c, s, g);
                    if (length - shortest).abs() > 2e-3 * shortest.max(1.0) {
                        let l = links(&m);
                        let portals: Vec<_> = c
                            .windows(2)
                            .map(|w| {
                                let (a, b) = portal(&m, &l, w[0], w[1]);
                                (xz(&m, a), xz(&m, b))
                            })
                            .collect();
                        panic!(
                            "seed {seed} len {length} shortest {shortest} s {s:?} g {g:?} path {:?} portals {portals:?}",
                            got.path
                        );
                    }
                    assert!(length <= midpoint_length(&m, c, s, g) + 1e-3);
                    for w in got.path.windows(2) {
                        for k in 0..=20 {
                            let t = k as f64 / 20.0;
                            let q = (
                                w[0][0] + (w[1][0] - w[0][0]) * t,
                                w[0][2] + (w[1][2] - w[0][2]) * t,
                            );
                            assert!(
                                c.iter().any(|&p| inside(&m, p, q, 2e-3)),
                                "seed {seed} left corridor"
                            );
                        }
                    }
                    near(got.path[0][0], s.0, 1e-5);
                    near(got.path.last().unwrap()[2], g.1, 1e-5);
                    checked += 1;
                }
            }
        }
    }
    assert!(checked > 100 && unreachable > 0, "{checked} {unreachable}");
}

fn squares() -> Mesh {
    let pos = [
        [0., 0., 0.],
        [1., 0., 0.],
        [2., 0., 0.],
        [0., 0., 1.],
        [1., 0., 1.],
        [2., 0., 1.],
        [0., 1., 2.],
        [1., 0., 2.],
    ];
    // Vertex 6 is (0, y=1, z=2): a raised corner of the top square.
    let mut pos = pos.to_vec();
    pos[6] = [0., 1., 2.];
    pos[7] = [1., 0., 2.];
    Mesh {
        pos,
        polys: vec![vec![0, 1, 4, 3], vec![1, 2, 5, 4], vec![3, 4, 7, 6]],
    }
}
fn route(f: &mut Fixture, m: &Mesh, radius: f64, s: (f64, f64), g: (f64, f64)) -> Routed {
    routed(&f.floats("route", route_input(m, radius, s, g, 100.0, 1.0)))
}
#[test]
fn funnel_known_answers_clearance_and_heights() {
    let mut f = Fixture::new("tests/navigation_mesh.sq");
    let m = squares();
    // Around the inner corner (1, 1): start, corner, goal.
    let r = route(&mut f, &m, 0.0, (0.2, 1.9), (1.9, 0.1));
    assert_eq!((r.status, r.corridor.clone()), (0, vec![2, 0, 1]));
    assert_eq!(r.path.len(), 3);
    near_all(&[r.path[1][0], r.path[1][2]], &[1.0, 1.0], 1e-6);
    near(
        path_length(&r.path),
        (0.8f64.powi(2) + 0.9f64.powi(2)).sqrt() + (0.9f64.powi(2) + 0.9f64.powi(2)).sqrt(),
        1e-5,
    );
    // A diagonal through the corner is straight, and height interpolates
    // across the raised square (vertex 6 is one metre up).
    let r = route(&mut f, &m, 0.0, (0.5, 1.5), (1.5, 0.5));
    near(path_length(&r.path), 2f64.sqrt(), 1e-5);
    let r = route(&mut f, &m, 0.0, (0.25, 1.75), (1.5, 0.5));
    near(r.path[0][1], 0.5, 1e-5);
    // Clearance: portals shrink by the radius, so the path wraps (0.75, 1) and
    // (1, 0.75) instead of the wall vertex.
    let r = route(&mut f, &m, 0.25, (0.2, 1.9), (1.9, 0.1));
    assert_eq!(r.path.len(), 4);
    near_all(
        &[r.path[1][0], r.path[1][2], r.path[2][0], r.path[2][2]],
        &[0.75, 1.0, 1.0, 0.75],
        1e-6,
    );
    // A portal narrower than twice the radius collapses to its midpoint.
    let r = route(&mut f, &m, 0.9, (0.2, 1.9), (1.9, 0.1));
    near_all(&[r.path[1][0], r.path[1][2]], &[0.5, 1.0], 1e-6);
    // Same polygon: straight; both endpoints only.
    let r = route(&mut f, &m, 0.3, (0.1, 0.1), (0.9, 0.8));
    assert_eq!((r.status, r.path.len(), r.expanded), (0, 2, 0));
}
#[test]
fn mesh_search_adversarial_inputs() {
    let mut f = Fixture::new("tests/navigation_mesh.sq");
    let m = squares();
    // Outside points snap to the nearest mesh point.
    let r = route(&mut f, &m, 0.0, (-5.0, 0.5), (2.0 + 4.0, 0.5));
    assert_eq!((r.status, r.corridor.clone()), (0, vec![0, 1]));
    near_all(
        &[r.path[0][0], r.path[0][2], r.path.last().unwrap()[0]],
        &[0.0, 0.5, 2.0],
        1e-6,
    );
    // Disconnected islands.
    let mut two = squares();
    two.pos
        .extend([[10., 0., 0.], [11., 0., 0.], [11., 0., 1.], [10., 0., 1.]]);
    two.polys.push(vec![8, 9, 10, 11]);
    let r = route(&mut f, &two, 0.0, (0.5, 0.5), (10.5, 0.5));
    assert_eq!((r.status, r.corridor.len(), r.path.len()), (1, 0, 0));
    // Budget exhaustion versus enough budget.
    let mut line = Mesh {
        pos: vec![],
        polys: vec![],
    };
    for i in 0..=12 {
        line.pos.push([i as f64, 0., 0.]);
        line.pos.push([i as f64, 0., 1.]);
    }
    for i in 0..12 {
        line.polys
            .push(vec![2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1]);
    }
    for (limit, status) in [(1.0, 2), (5.0, 2), (12.0, 0), (13.0, 0), (0.0, 2)] {
        let r = routed(&f.floats(
            "route",
            route_input(&line, 0.0, (0.5, 0.5), (11.5, 0.5), limit, 1.0),
        ));
        assert_eq!(r.status, status, "limit {limit}");
        assert_eq!(r.path.is_empty(), status != 0);
        if status == 0 {
            near(path_length(&r.path), 11.0, 1e-5);
        }
    }
    // NaN endpoints are invalid; infinite ones too.
    for bad in [f64::NAN, f64::INFINITY] {
        let r = route(&mut f, &m, 0.0, (bad, 0.5), (1.5, 0.5));
        assert_eq!(r.status, 3);
        let r = route(&mut f, &m, 0.0, (0.5, 0.5), (1.5, bad));
        assert_eq!(r.status, 3);
    }
    // Rejected meshes: zero area, duplicate vertex id, duplicate position,
    // clockwise, concave, bowtie, shared directed edge, bad index, NaN, tiny ring.
    let bad = |pos: Vec<P>, polys: Vec<Vec<usize>>| Mesh { pos, polys };
    let square = vec![[0., 0., 0.], [1., 0., 0.], [1., 0., 1.], [0., 0., 1.]];
    let cases = vec![
        bad(
            vec![[0., 0., 0.], [1., 0., 0.], [2., 0., 0.]],
            vec![vec![0, 1, 2]],
        ),
        bad(square.clone(), vec![vec![0, 1, 1, 2, 3]]),
        bad(
            vec![
                [0., 0., 0.],
                [1., 0., 0.],
                [1., 0., 0.],
                [1., 0., 1.],
                [0., 0., 1.],
            ],
            vec![vec![0, 1, 2, 3, 4]],
        ),
        bad(square.clone(), vec![vec![0, 3, 2, 1]]),
        bad(
            vec![
                [0., 0., 0.],
                [2., 0., 0.],
                [2., 0., 2.],
                [1., 0., 0.5],
                [0., 0., 2.],
            ],
            vec![vec![0, 1, 2, 3, 4]],
        ),
        bad(square.clone(), vec![vec![0, 2, 1, 3]]),
        bad(square.clone(), vec![vec![0, 1, 2], vec![0, 1, 3]]),
        bad(square.clone(), vec![vec![0, 1, 9, 3]]),
        bad(
            vec![[0., 0., 0.], [1., 0., f64::NAN], [1., 0., 1.]],
            vec![vec![0, 1, 2]],
        ),
        bad(square.clone(), vec![vec![0, 1]]),
        bad(vec![], vec![]),
    ];
    for (k, mesh) in cases.iter().enumerate() {
        assert_eq!(
            f.floats(
                "route",
                route_input(mesh, 0.0, (0.2, 0.2), (0.4, 0.4), 10.0, 1.0)
            ),
            vec![-1.0],
            "case {k}"
        );
    }
    // A pentagram-like self-overlapping ring and collinear corners.
    let star: Vec<P> = (0..5)
        .map(|i| {
            let a = i as f64 * 4.0 * std::f64::consts::PI / 5.0;
            [a.cos(), 0.0, a.sin()]
        })
        .collect();
    let mesh = bad(star, vec![vec![0, 1, 2, 3, 4]]);
    assert_eq!(
        f.floats(
            "route",
            route_input(&mesh, 0.0, (0.0, 0.0), (0.1, 0.1), 10.0, 1.0)
        ),
        vec![-1.0]
    );
    let collinear = bad(
        vec![
            [0., 0., 0.],
            [1., 0., 0.],
            [2., 0., 0.],
            [2., 0., 1.],
            [0., 0., 1.],
        ],
        vec![vec![0, 1, 2, 3, 4]],
    );
    let r = route(&mut f, &collinear, 0.0, (0.2, 0.2), (1.8, 0.8));
    assert_eq!(r.status, 0);
}
#[test]
fn location_closest_point_and_straight_walks_match_brute_force() {
    let mut f = Fixture::new("tests/navigation_mesh.sq");
    for seed in 1..=20u32 {
        let m = jittered(seed, 8, 7, 0.25);
        let mut r = Random(seed * 31);
        let queries: Vec<(f64, f64)> = (0..60)
            .map(|_| (r.unit() * 11.0 - 1.5, r.unit() * 10.0 - 1.5))
            .collect();
        let mut input = vec![[0.7, 1.0, 3.0][seed as usize % 3], queries.len() as f64];
        input.extend(encode(&m));
        input.extend(queries.iter().flat_map(|q| [q.0, q.1]));
        let out = f.floats("queries", input);
        for (k, q) in queries.iter().enumerate() {
            let row = &out[k * 5..k * 5 + 5];
            let located = locate_ref(&m, *q);
            assert_eq!(
                row[0],
                located.map_or(NONE, |p| p as f64),
                "seed {seed} query {k}"
            );
            // Closest: the minimum clamp distance over all polygons.
            let mut best = f64::INFINITY;
            for p in 0..m.polys.len() {
                let poly = &m.polys[p];
                let d = if inside(&m, p, *q, 0.0) {
                    0.0
                } else {
                    (0..poly.len())
                        .map(|i| {
                            let (a, b) = (xz(&m, poly[i]), xz(&m, poly[(i + 1) % poly.len()]));
                            let e = (b.0 - a.0, b.1 - a.1);
                            let t = (((q.0 - a.0) * e.0 + (q.1 - a.1) * e.1)
                                / (e.0 * e.0 + e.1 * e.1))
                                .clamp(0.0, 1.0);
                            dist(*q, (a.0 + e.0 * t, a.1 + e.1 * t))
                        })
                        .fold(f64::INFINITY, f64::min)
                };
                best = best.min(d);
            }
            let found = (row[2], row[4]);
            near(dist(*q, found), best, 1e-4);
            assert!(row[1] >= 0.0 && inside(&m, row[1] as usize, found, 1e-4));
            // Heights interpolate each triangle's vertex heights.
            if let Some(p) = located {
                if m.polys[p].len() == 3 && best == 0.0 {
                    let v: Vec<_> = m.polys[p]
                        .iter()
                        .map(|&i| (xz(&m, i), m.pos[i][1]))
                        .collect();
                    let area = cross(v[0].0, v[1].0, v[2].0);
                    let (a, b, c) = (
                        cross(*q, v[1].0, v[2].0) / area,
                        cross(v[0].0, *q, v[2].0) / area,
                        cross(v[0].0, v[1].0, *q) / area,
                    );
                    near(row[3], a * v[0].1 + b * v[1].1 + c * v[2].1, 1e-4);
                }
            }
        }
        // Straight walks: coverage of the segment by the polygons' clipped
        // intervals, computed per polygon with Cyrus-Beck, bounds the walk.
        let walks: Vec<[f64; 4]> = (0..40)
            .map(|_| {
                let p = r.word() as usize % m.polys.len();
                let c = centre(&m, p);
                [
                    c.0,
                    c.1,
                    c.0 + (r.unit() - 0.5) * 8.0,
                    c.1 + (r.unit() - 0.5) * 8.0,
                ]
            })
            .collect();
        let mut input = vec![1.0, walks.len() as f64];
        input.extend(encode(&m));
        input.extend(walks.iter().flatten());
        let out = f.floats("walks", input);
        for (k, w) in walks.iter().enumerate() {
            let row = &out[k * 4..k * 4 + 4];
            let mut intervals: Vec<(f64, f64)> = Vec::new();
            for poly in 0..m.polys.len() {
                let ring = &m.polys[poly];
                let (mut lo, mut hi) = (0.0f64, 1.0f64);
                let d = (w[2] - w[0], w[3] - w[1]);
                for i in 0..ring.len() {
                    let (a, b) = (xz(&m, ring[i]), xz(&m, ring[(i + 1) % ring.len()]));
                    let e = (b.0 - a.0, b.1 - a.1);
                    let num = e.0 * (w[1] - a.1) - e.1 * (w[0] - a.0);
                    let rate = e.0 * d.1 - e.1 * d.0;
                    if rate.abs() < 1e-12 {
                        if num < 0.0 {
                            hi = -1.0;
                        }
                    } else if rate > 0.0 {
                        lo = lo.max(-num / rate);
                    } else {
                        hi = hi.min(num / -rate);
                    }
                }
                if lo <= hi {
                    intervals.push((lo, hi));
                }
            }
            intervals.sort_by(|a, b| a.0.total_cmp(&b.0));
            let mut reach = 0.0f64;
            for (lo, hi) in intervals {
                if lo <= reach + 1e-6 {
                    reach = reach.max(hi);
                }
            }
            let blocked = reach < 1.0 - 1e-6;
            assert_eq!(row[0] == 1.0, blocked, "seed {seed} walk {k}");
            if blocked {
                near(row[2], reach, 1e-3);
            } else {
                near(row[2], 1.0, 0.0);
            }
        }
    }
}
#[test]
fn grid_mesh_covers_exactly_the_walkable_cells() {
    let mut f = Fixture::new("tests/navigation_mesh.sq");
    for seed in 1..=30u32 {
        let (w, h) = (3 + seed as usize % 9, 2 + seed as usize % 7);
        let mut r = Random(seed);
        let costs: Vec<f64> = (0..w * h)
            .map(|_| match r.word() % 6 {
                0 => 0.0,
                1 => 2.0,
                _ => 1.0,
            })
            .collect();
        let mut input = vec![w as f64, h as f64, -3.0, 5.0, 0.5];
        input.extend(&costs);
        let out = f.floats("grid_mesh", input);
        if costs.iter().all(|&c| c == 0.0) {
            assert_eq!(out, vec![0.0]);
            continue;
        }
        let (nv, np, nc) = (out[1] as usize, out[2] as usize, out[3] as usize);
        let pos: Vec<P> = out[4..4 + nv * 3]
            .chunks(3)
            .map(|c| [c[0], c[1], c[2]])
            .collect();
        let counts: Vec<usize> = out[4 + nv * 3..4 + nv * 3 + np]
            .iter()
            .map(|&c| c as usize)
            .collect();
        let idx: Vec<usize> = out[4 + nv * 3 + np..4 + nv * 3 + np + nc]
            .iter()
            .map(|&c| c as usize)
            .collect();
        let lk: Vec<f64> = out[4 + nv * 3 + np + nc..].to_vec();
        let mut at = 0;
        let polys: Vec<Vec<usize>> = counts
            .iter()
            .map(|&c| {
                at += c;
                idx[at - c..at].to_vec()
            })
            .collect();
        let m = Mesh { pos, polys };
        let walkable = costs.iter().filter(|&&c| c > 0.0).count();
        let mut area = 0.0;
        for p in 0..np {
            let xs: Vec<f64> = m.polys[p].iter().map(|&v| m.pos[v][0]).collect();
            let zs: Vec<f64> = m.polys[p].iter().map(|&v| m.pos[v][2]).collect();
            let (x0, x1) = (
                xs.iter().cloned().fold(f64::MAX, f64::min),
                xs.iter().cloned().fold(f64::MIN, f64::max),
            );
            let (z0, z1) = (
                zs.iter().cloned().fold(f64::MAX, f64::min),
                zs.iter().cloned().fold(f64::MIN, f64::max),
            );
            area += (x1 - x0) * (z1 - z0);
            // Equal cost throughout the rectangle.
            let mut seen = std::collections::BTreeSet::new();
            for j in 0..h {
                for i in 0..w {
                    let c = (-3.0 + (i as f64 + 0.5) * 0.5, 5.0 + (j as f64 + 0.5) * 0.5);
                    if inside(&m, p, c, 0.0) {
                        seen.insert((costs[j * w + i] * 1000.0) as i64);
                    }
                }
            }
            assert_eq!(seen.len(), 1, "seed {seed} polygon {p}");
            assert!(!seen.contains(&0));
        }
        near(area, walkable as f64 * 0.25, 1e-9);
        // Each walkable cell centre is in exactly one polygon; walls in none.
        for j in 0..h {
            for i in 0..w {
                let c = (-3.0 + (i as f64 + 0.5) * 0.5, 5.0 + (j as f64 + 0.5) * 0.5);
                let n = (0..np).filter(|&p| inside(&m, p, c, 0.0)).count();
                assert_eq!(
                    n,
                    (costs[j * w + i] > 0.0) as usize,
                    "seed {seed} cell {i},{j}"
                );
            }
        }
        // Links match the independent directed-edge adjacency.
        let want = links(&m);
        let mut k = 0;
        for p in 0..np {
            for i in 0..counts[p] {
                assert_eq!(lk[k], want[p][i].map_or(NONE, |q| q as f64));
                k += 1;
            }
        }
        // Greedy merging is deterministic and never worse than one polygon per
        // cell.
        assert!(np <= walkable);
    }
}
#[test]
fn navmesh_example_routes_around_the_corner_and_avoids() {
    let mut f = Fixture::new("examples/navmesh.sq");
    let r = f.floats("route", ());
    assert_eq!(r[0], 0.0);
    let points: Vec<_> = r[1..].chunks(3).map(|c| (c[0], c[2])).collect();
    assert_eq!(points.len(), 3);
    near_all(&[points[1].0, points[1].1], &[1.0, 1.0], 1e-6);
    let v = f.floats("avoid", ());
    assert!(v[0] > 0.9 && v[1].abs() > 1e-3);
}
