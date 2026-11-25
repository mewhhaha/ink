//! A Rust port of RVO2's `Agent::computeNewVelocity` and its linear programs,
//! used as an independent reference for `lib/ai/avoidance.blot`, plus direct
//! half-plane checks, a circle-swap simulation and adversarial inputs.
use super::*;

const EPS: f32 = 0.00001;
#[derive(Clone, Copy, Default, Debug, PartialEq)]
struct V(f32, f32);
impl std::ops::Add for V {
    type Output = V;
    fn add(self, o: V) -> V {
        V(self.0 + o.0, self.1 + o.1)
    }
}
impl std::ops::Sub for V {
    type Output = V;
    fn sub(self, o: V) -> V {
        V(self.0 - o.0, self.1 - o.1)
    }
}
impl std::ops::Neg for V {
    type Output = V;
    fn neg(self) -> V {
        V(-self.0, -self.1)
    }
}
impl std::ops::Mul<f32> for V {
    type Output = V;
    fn mul(self, s: f32) -> V {
        V(self.0 * s, self.1 * s)
    }
}
impl std::ops::Mul<V> for V {
    type Output = f32;
    fn mul(self, o: V) -> f32 {
        self.0 * o.0 + self.1 * o.1
    }
}
impl std::ops::Div<f32> for V {
    type Output = V;
    fn div(self, s: f32) -> V {
        V(self.0 / s, self.1 / s)
    }
}
fn det(a: V, b: V) -> f32 {
    a.0 * b.1 - a.1 * b.0
}
fn abs_sq(a: V) -> f32 {
    a * a
}
fn norm(a: V) -> V {
    a / abs_sq(a).sqrt()
}
fn left_of(a: V, b: V, c: V) -> f32 {
    det(a - c, b - a)
}
#[derive(Clone, Copy)]
struct Line {
    point: V,
    direction: V,
}
#[derive(Clone)]
struct Obstacle {
    point: V,
    prev: usize,
    next: usize,
    unit_dir: V,
    convex: bool,
}
fn obstacles(polygons: &[Vec<V>]) -> Vec<Obstacle> {
    let mut all = Vec::new();
    for poly in polygons {
        let base = all.len();
        let n = poly.len();
        for i in 0..n {
            let (p, nx) = ((i + n - 1) % n, (i + 1) % n);
            all.push(Obstacle {
                point: poly[i],
                prev: base + p,
                next: base + nx,
                unit_dir: norm(poly[nx] - poly[i]),
                convex: n == 2 || left_of(poly[p], poly[i], poly[nx]) >= 0.0,
            });
        }
    }
    all
}
fn lp1(
    lines: &[Line],
    line_no: usize,
    radius: f32,
    opt: V,
    direction_opt: bool,
    result: &mut V,
) -> bool {
    let dot = lines[line_no].point * lines[line_no].direction;
    let discriminant = dot * dot + radius * radius - abs_sq(lines[line_no].point);
    if discriminant < 0.0 {
        return false;
    }
    let root = discriminant.sqrt();
    let (mut left, mut right) = (-dot - root, -dot + root);
    for i in 0..line_no {
        let denominator = det(lines[line_no].direction, lines[i].direction);
        let numerator = det(lines[i].direction, lines[line_no].point - lines[i].point);
        if denominator.abs() <= EPS {
            if numerator < 0.0 {
                return false;
            }
            continue;
        }
        let t = numerator / denominator;
        if denominator >= 0.0 {
            right = right.min(t);
        } else {
            left = left.max(t);
        }
        if left > right {
            return false;
        }
    }
    let l = lines[line_no];
    if direction_opt {
        *result = if opt * l.direction > 0.0 {
            l.point + l.direction * right
        } else {
            l.point + l.direction * left
        };
    } else {
        let t = l.direction * (opt - l.point);
        *result = if t < left {
            l.point + l.direction * left
        } else if t > right {
            l.point + l.direction * right
        } else {
            l.point + l.direction * t
        };
    }
    true
}
fn lp2(lines: &[Line], radius: f32, opt: V, direction_opt: bool, result: &mut V) -> usize {
    if direction_opt {
        *result = opt * radius;
    } else if abs_sq(opt) > radius * radius {
        *result = norm(opt) * radius;
    } else {
        *result = opt;
    }
    for i in 0..lines.len() {
        if det(lines[i].direction, lines[i].point - *result) > 0.0 {
            let temp = *result;
            if !lp1(lines, i, radius, opt, direction_opt, result) {
                *result = temp;
                return i;
            }
        }
    }
    lines.len()
}
fn lp3(lines: &[Line], obstacle_lines: usize, begin: usize, radius: f32, result: &mut V) {
    let mut distance = 0.0f32;
    for i in begin..lines.len() {
        if det(lines[i].direction, lines[i].point - *result) > distance {
            let mut projected: Vec<Line> = lines[..obstacle_lines].to_vec();
            for j in obstacle_lines..i {
                let determinant = det(lines[i].direction, lines[j].direction);
                let point = if determinant.abs() <= EPS {
                    if lines[i].direction * lines[j].direction > 0.0 {
                        continue;
                    }
                    (lines[i].point + lines[j].point) * 0.5
                } else {
                    lines[i].point
                        + lines[i].direction
                            * (det(lines[j].direction, lines[i].point - lines[j].point)
                                / determinant)
                };
                projected.push(Line {
                    point,
                    direction: norm(lines[j].direction - lines[i].direction),
                });
            }
            let temp = *result;
            if lp2(
                &projected,
                radius,
                V(-lines[i].direction.1, lines[i].direction.0),
                true,
                result,
            ) < projected.len()
            {
                *result = temp;
            }
            distance = det(lines[i].direction, lines[i].point - *result);
        }
    }
}
#[derive(Clone, Copy)]
struct Agent {
    p: V,
    v: V,
    r: f32,
}
struct Config {
    horizon: f32,
    obstacle_horizon: f32,
    step: f32,
    max_speed: f32,
    max_neighbours: usize,
}
/// (velocity, obstacle line count, all lines, relaxed)
fn rvo2(
    agents: &[Agent],
    index: usize,
    neighbours: &[usize],
    obs: &[Obstacle],
    edges: &[usize],
    preferred: V,
    c: &Config,
) -> (V, usize, Vec<Line>, bool) {
    let me = agents[index];
    let (position, velocity, radius) = (me.p, me.v, me.r);
    let mut lines: Vec<Line> = Vec::new();
    let inv_obstacle = 1.0 / c.obstacle_horizon;
    let mut seen: Vec<(f32, usize)> = edges
        .iter()
        .filter(|&&e| left_of(obs[e].point, obs[obs[e].next].point, position) < 0.0)
        .map(|&e| {
            let (a, b) = (obs[e].point, obs[obs[e].next].point);
            let r = (((position - a) * (b - a)) / abs_sq(b - a)).clamp(0.0, 1.0);
            (abs_sq(position - (a + (b - a) * r)), e)
        })
        .collect();
    seen.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    for &(_, e) in &seen {
        let (mut o1, mut o2) = (e, obs[e].next);
        let rp1 = obs[o1].point - position;
        let rp2 = obs[o2].point - position;
        let covered = lines.iter().any(|l| {
            det(rp1 * inv_obstacle - l.point, l.direction) - inv_obstacle * radius >= -EPS
                && det(rp2 * inv_obstacle - l.point, l.direction) - inv_obstacle * radius >= -EPS
        });
        if covered {
            continue;
        }
        let (d1, d2) = (abs_sq(rp1), abs_sq(rp2));
        let rsq = radius * radius;
        let ov = obs[o2].point - obs[o1].point;
        let s = (-rp1 * ov) / abs_sq(ov);
        let dline = abs_sq(-rp1 - ov * s);
        if s < 0.0 && d1 <= rsq {
            if obs[o1].convex {
                lines.push(Line {
                    point: V(0.0, 0.0),
                    direction: norm(V(-rp1.1, rp1.0)),
                });
            }
            continue;
        } else if s > 1.0 && d2 <= rsq {
            if obs[o2].convex && det(rp2, obs[o2].unit_dir) >= 0.0 {
                lines.push(Line {
                    point: V(0.0, 0.0),
                    direction: norm(V(-rp2.1, rp2.0)),
                });
            }
            continue;
        } else if (0.0..=1.0).contains(&s) && dline <= rsq {
            lines.push(Line {
                point: V(0.0, 0.0),
                direction: -obs[o1].unit_dir,
            });
            continue;
        }
        if inv_obstacle <= 0.0 {
            continue;
        }
        let (mut left_leg, mut right_leg);
        if s < 0.0 && dline <= rsq {
            if !obs[o1].convex {
                continue;
            }
            o2 = o1;
            let leg = (d1 - rsq).sqrt();
            left_leg = V(rp1.0 * leg - rp1.1 * radius, rp1.0 * radius + rp1.1 * leg) / d1;
            right_leg = V(rp1.0 * leg + rp1.1 * radius, -rp1.0 * radius + rp1.1 * leg) / d1;
        } else if s > 1.0 && dline <= rsq {
            if !obs[o2].convex {
                continue;
            }
            o1 = o2;
            let leg = (d2 - rsq).sqrt();
            left_leg = V(rp2.0 * leg - rp2.1 * radius, rp2.0 * radius + rp2.1 * leg) / d2;
            right_leg = V(rp2.0 * leg + rp2.1 * radius, -rp2.0 * radius + rp2.1 * leg) / d2;
        } else {
            if obs[o1].convex {
                let leg = (d1 - rsq).sqrt();
                left_leg = V(rp1.0 * leg - rp1.1 * radius, rp1.0 * radius + rp1.1 * leg) / d1;
            } else {
                left_leg = -obs[o1].unit_dir;
            }
            if obs[o2].convex {
                let leg = (d2 - rsq).sqrt();
                right_leg = V(rp2.0 * leg + rp2.1 * radius, -rp2.0 * radius + rp2.1 * leg) / d2;
            } else {
                right_leg = obs[o1].unit_dir;
            }
        }
        let left_neighbour = obs[o1].prev;
        let (mut left_foreign, mut right_foreign) = (false, false);
        if obs[o1].convex && det(left_leg, -obs[left_neighbour].unit_dir) >= 0.0 {
            left_leg = -obs[left_neighbour].unit_dir;
            left_foreign = true;
        }
        if obs[o2].convex && det(right_leg, obs[o2].unit_dir) <= 0.0 {
            right_leg = obs[o2].unit_dir;
            right_foreign = true;
        }
        let lc = (obs[o1].point - position) * inv_obstacle;
        let rc = (obs[o2].point - position) * inv_obstacle;
        let cut = rc - lc;
        let t = if o1 == o2 {
            0.5
        } else {
            ((velocity - lc) * cut) / abs_sq(cut)
        };
        let t_left = (velocity - lc) * left_leg;
        let t_right = (velocity - rc) * right_leg;
        if (t < 0.0 && t_left < 0.0) || (o1 == o2 && t_left < 0.0 && t_right < 0.0) {
            let u = norm(velocity - lc);
            lines.push(Line {
                direction: V(u.1, -u.0),
                point: lc + u * (radius * inv_obstacle),
            });
            continue;
        } else if t > 1.0 && t_right < 0.0 {
            let u = norm(velocity - rc);
            lines.push(Line {
                direction: V(u.1, -u.0),
                point: rc + u * (radius * inv_obstacle),
            });
            continue;
        }
        let inf = f32::INFINITY;
        let d_cut = if t < 0.0 || t > 1.0 || o1 == o2 {
            inf
        } else {
            abs_sq(velocity - (lc + cut * t))
        };
        let d_left = if t_left < 0.0 {
            inf
        } else {
            abs_sq(velocity - (lc + left_leg * t_left))
        };
        let d_right = if t_right < 0.0 {
            inf
        } else {
            abs_sq(velocity - (rc + right_leg * t_right))
        };
        if d_cut <= d_left && d_cut <= d_right {
            let direction = -obs[o1].unit_dir;
            lines.push(Line {
                direction,
                point: lc + V(-direction.1, direction.0) * (radius * inv_obstacle),
            });
        } else if d_left <= d_right {
            if left_foreign {
                continue;
            }
            lines.push(Line {
                direction: left_leg,
                point: lc + V(-left_leg.1, left_leg.0) * (radius * inv_obstacle),
            });
        } else {
            if right_foreign {
                continue;
            }
            let direction = -right_leg;
            lines.push(Line {
                direction,
                point: rc + V(-direction.1, direction.0) * (radius * inv_obstacle),
            });
        }
    }
    let obstacle_lines = lines.len();
    let inv = 1.0 / c.horizon;
    let mut near: Vec<(f32, usize)> = neighbours
        .iter()
        .filter(|&&o| o != index)
        .map(|&o| (abs_sq(agents[o].p - position), o))
        .collect();
    near.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    near.truncate(c.max_neighbours);
    for &(_, o) in &near {
        let other = agents[o];
        let rp = other.p - position;
        let rv = velocity - other.v;
        let dsq = abs_sq(rp);
        let combined = radius + other.r;
        let csq = combined * combined;
        let (direction, u);
        if dsq > csq {
            let w = rv - rp * inv;
            let wsq = abs_sq(w);
            let dot1 = w * rp;
            if dot1 < 0.0 && dot1 * dot1 > csq * wsq {
                let wl = wsq.sqrt();
                let uw = w / wl;
                direction = V(uw.1, -uw.0);
                u = uw * (combined * inv - wl);
            } else {
                let leg = (dsq - csq).sqrt();
                direction = if det(rp, w) > 0.0 {
                    V(rp.0 * leg - rp.1 * combined, rp.0 * combined + rp.1 * leg) / dsq
                } else {
                    -V(rp.0 * leg + rp.1 * combined, -rp.0 * combined + rp.1 * leg) / dsq
                };
                u = direction * (rv * direction) - rv;
            }
        } else {
            let inv_step = 1.0 / c.step;
            let w = rv - rp * inv_step;
            let wl = abs_sq(w).sqrt();
            let uw = w / wl;
            direction = V(uw.1, -uw.0);
            u = uw * (combined * inv_step - wl);
        }
        lines.push(Line {
            direction,
            point: velocity + u * 0.5,
        });
    }
    let mut result = V(0.0, 0.0);
    let failed = lp2(&lines, c.max_speed, preferred, false, &mut result);
    let relaxed = failed < lines.len();
    if relaxed {
        lp3(&lines, obstacle_lines, failed, c.max_speed, &mut result);
    }
    (result, obstacle_lines, lines, relaxed)
}

struct Scene {
    agents: Vec<Agent>,
    polygons: Vec<Vec<V>>,
}
fn packet(
    s: &Scene,
    index: usize,
    neighbours: &[usize],
    edges: &[usize],
    preferred: V,
    c: &Config,
) -> Vec<f64> {
    let vertices: usize = s.polygons.iter().map(Vec::len).sum();
    let mut v = vec![
        index as f64,
        s.agents.len() as f64,
        c.horizon as f64,
        c.obstacle_horizon as f64,
        c.step as f64,
        c.max_speed as f64,
        c.max_neighbours as f64,
        preferred.0 as f64,
        preferred.1 as f64,
        neighbours.len() as f64,
        s.polygons.len() as f64,
        vertices as f64,
        edges.len() as f64,
    ];
    for a in &s.agents {
        v.extend([a.p.0, a.p.1, a.v.0, a.v.1, a.r].map(f64::from));
    }
    v.extend(neighbours.iter().map(|&n| n as f64));
    v.extend(s.polygons.iter().map(|p| p.len() as f64));
    for p in &s.polygons {
        for q in p {
            v.extend([q.0 as f64, q.1 as f64]);
        }
    }
    v.extend(edges.iter().map(|&e| e as f64));
    v
}
fn random_scene(r: &mut Random, agents: usize, with_obstacles: bool) -> Scene {
    let mut unit = |lo: f64, hi: f64| (lo + r.unit() * (hi - lo)) as f32;
    let agent_rows = (0..agents)
        .map(|_| Agent {
            p: V(unit(-4.0, 4.0), unit(-4.0, 4.0)),
            v: V(unit(-1.5, 1.5), unit(-1.5, 1.5)),
            r: unit(0.25, 0.6),
        })
        .collect();
    let mut polygons = Vec::new();
    if with_obstacles {
        for _ in 0..3 {
            // Counter-clockwise convex obstacle: a rotated box or triangle.
            let (cx, cy, size, turn) = (
                unit(-4.0, 4.0),
                unit(-4.0, 4.0),
                unit(0.4, 1.2),
                unit(0.0, 6.28),
            );
            let sides = if unit(0.0, 1.0) < 0.5 { 3 } else { 4 };
            let poly: Vec<V> = (0..sides)
                .map(|k| {
                    let a = turn + k as f32 * std::f32::consts::TAU / sides as f32;
                    V(cx + size * a.cos(), cy + size * a.sin())
                })
                .collect();
            polygons.push(poly);
        }
        polygons.push(vec![
            V(unit(-5.0, -3.0), unit(-5.0, 5.0)),
            V(unit(3.0, 5.0), unit(-5.0, 5.0)),
        ]);
    }
    Scene {
        agents: agent_rows,
        polygons,
    }
}
fn lines_of(out: &[f64]) -> Vec<Line> {
    out[5..]
        .chunks(4)
        .map(|c| Line {
            point: V(c[0] as f32, c[1] as f32),
            direction: V(c[2] as f32, c[3] as f32),
        })
        .collect()
}

#[test]
fn orca_matches_rvo2_port_and_satisfies_constraints() {
    let mut f = Fixture::new("tests/avoidance.blot");
    let (mut relaxed, mut obstacle_lines, mut compared) = (0, 0, 0);
    for seed in 1..=120u32 {
        let mut r = Random(seed);
        let scene = random_scene(&mut r, 4 + seed as usize % 8, seed % 4 != 0);
        let obs = obstacles(&scene.polygons);
        let edges: Vec<usize> = (0..obs.len()).collect();
        let c = Config {
            horizon: [2.0, 5.0, 10.0][seed as usize % 3],
            obstacle_horizon: [1.5, 3.0][seed as usize % 2],
            step: 0.1,
            max_speed: [1.0, 2.0, 4.0][seed as usize % 3],
            max_neighbours: [3, 6, 20][seed as usize % 3],
        };
        for index in 0..scene.agents.len() {
            let neighbours: Vec<usize> = (0..scene.agents.len()).collect();
            let preferred = V((r.unit() * 6.0 - 3.0) as f32, (r.unit() * 6.0 - 3.0) as f32);
            let (want, want_obstacle_lines, want_lines, want_relaxed) = rvo2(
                &scene.agents,
                index,
                &neighbours,
                &obs,
                &edges,
                preferred,
                &c,
            );
            let out = f.floats(
                "orca",
                packet(&scene, index, &neighbours, &edges, preferred, &c),
            );
            assert_eq!(
                out[2], want_relaxed as u8 as f64,
                "seed {seed} agent {index} status"
            );
            assert_eq!(
                out[3] as usize, want_obstacle_lines,
                "seed {seed} agent {index} obstacle lines"
            );
            assert_eq!(
                out[4] as usize,
                want_lines.len(),
                "seed {seed} agent {index} lines"
            );
            let got = V(out[0] as f32, out[1] as f32);
            assert!(
                (got - want).0.abs() < 2e-3 && (got - want).1.abs() < 2e-3,
                "seed {seed} agent {index}: {got:?} vs {want:?}"
            );
            // Independent half-plane check on the lines the solver used.
            let lines = lines_of(&out);
            assert!(abs_sq(got) <= (c.max_speed * c.max_speed) * 1.0001 + 1e-6);
            if !want_relaxed {
                for (k, l) in lines.iter().enumerate() {
                    assert!(
                        det(l.direction, l.point - got) <= 1e-3,
                        "seed {seed} agent {index} line {k} violated"
                    );
                }
                // And optimality: no sampled feasible velocity is closer to the
                // preferred one than the answer.
                let best = abs_sq(got - preferred);
                for k in 0..200 {
                    let a = k as f32 * 0.0314159;
                    for s in [0.2f32, 0.6, 1.0] {
                        let q = V(a.cos(), a.sin()) * (c.max_speed * s);
                        if lines.iter().all(|l| det(l.direction, l.point - q) <= 0.0) {
                            assert!(
                                abs_sq(q - preferred) >= best - 1e-3,
                                "seed {seed}: {q:?} beats {got:?}"
                            );
                        }
                    }
                }
            }
            relaxed += want_relaxed as u32;
            obstacle_lines += want_obstacle_lines;
            compared += 1;
        }
    }
    assert!(
        compared > 700 && relaxed > 5 && obstacle_lines > 100,
        "{compared} {relaxed} {obstacle_lines}"
    );
}
#[test]
fn agents_swapping_places_on_a_circle_do_not_collide() {
    let mut f = Fixture::new("tests/avoidance.blot");
    for (count, ring, horizon) in [
        (2, 3.0, 6.0),
        (4, 8.0, 5.0),
        (5, 16.0, 6.0),
        (6, 12.0, 5.0),
        (8, 16.0, 6.0),
        (12, 20.0, 10.0),
    ] {
        let out = f.floats(
            "circle",
            vec![count as f64, ring, 0.4, 1.5, 0.05, horizon, 1500.0],
        );
        // Touching is allowed; overlap is not.
        assert!(out[0] >= -1e-4, "{count} agents overlapped by {}", -out[0]);
        assert!(out[1] < 1500.0, "{count} agents never arrived: {out:?}");
        for i in 0..count {
            let angle = i as f64 * std::f64::consts::TAU / count as f64;
            let (gx, gy) = (-ring * angle.cos(), -ring * angle.sin());
            let d = ((out[2 + 2 * i] - gx).powi(2) + (out[3 + 2 * i] - gy).powi(2)).sqrt();
            assert!(d < 0.1, "agent {i} stopped {d} from its goal");
        }
    }
}
fn simple(
    f: &mut Fixture,
    agents: Vec<Agent>,
    polygons: Vec<Vec<V>>,
    index: usize,
    neighbours: &[usize],
    preferred: V,
    c: Config,
) -> Vec<f64> {
    let obs = obstacles(&polygons);
    let edges: Vec<usize> = (0..obs.len()).collect();
    f.floats(
        "orca",
        packet(
            &Scene { agents, polygons },
            index,
            neighbours,
            &edges,
            preferred,
            &c,
        ),
    )
}
fn config() -> Config {
    Config {
        horizon: 4.0,
        obstacle_horizon: 4.0,
        step: 0.1,
        max_speed: 2.0,
        max_neighbours: 10,
    }
}
fn agent(x: f32, y: f32, vx: f32, vy: f32) -> Agent {
    Agent {
        p: V(x, y),
        v: V(vx, vy),
        r: 0.5,
    }
}
#[test]
fn orca_adversarial_inputs() {
    let mut f = Fixture::new("tests/avoidance.blot");
    // Lone agent: preferred velocity, clamped to the speed limit.
    let out = simple(
        &mut f,
        vec![agent(0., 0., 0., 0.)],
        vec![],
        0,
        &[],
        V(3.0, 4.0),
        config(),
    );
    near_all(&out[..3], &[1.2, 1.6, 0.0], 1e-5);
    // Head-on pair: each yields half and passes beside the other.
    let pair = vec![agent(-3., 0., 1., 0.), agent(3., 0., -1., 0.)];
    let a = simple(&mut f, pair.clone(), vec![], 0, &[1], V(1., 0.), config());
    let b = simple(&mut f, pair, vec![], 1, &[0], V(-1., 0.), config());
    assert!(
        a[1].abs() > 1e-4 && (a[1] + b[1]).abs() < 1e-5,
        "reciprocal sidesteps mirror"
    );
    // Coincident agents separate along opposite directions by index; the
    // result is finite.
    let same = vec![agent(1., 1., 0., 0.), agent(1., 1., 0., 0.)];
    let a = simple(&mut f, same.clone(), vec![], 0, &[1], V(0., 0.), config());
    let b = simple(&mut f, same, vec![], 1, &[0], V(0., 0.), config());
    // The separation line needs more than the speed limit, so the relaxed
    // program answers at full speed in opposite directions.
    assert!(
        (a[0], b[0]) == (2.0, -2.0) && a.iter().all(|x| x.is_finite()),
        "{a:?} {b:?}"
    );
    // Zero time horizon: distant neighbours impose nothing; overlap still does.
    let mut zero = config();
    zero.horizon = 0.0;
    zero.obstacle_horizon = 0.0;
    let far = vec![agent(0., 0., 0., 0.), agent(2., 0., -1., 0.)];
    let out = simple(&mut f, far, vec![], 0, &[1], V(1., 0.), zero);
    near_all(&out[..2], &[1.0, 0.0], 1e-6);
    let mut zero = config();
    zero.horizon = 0.0;
    zero.obstacle_horizon = 0.0;
    let touching = vec![agent(0., 0., 0., 0.), agent(0.5, 0., 0., 0.)];
    let out = simple(&mut f, touching, vec![], 0, &[1], V(1., 0.), zero);
    assert!(
        out[0] < 1.0 && out.iter().all(|x| x.is_finite()),
        "overlap pushes back: {out:?}"
    );
    // Invalid inputs return a zero velocity with the invalid status.
    for (bad_agent, bad_pref, bad_config) in [
        (agent(f32::NAN, 0., 0., 0.), V(1., 0.), config()),
        (agent(0., 0., f32::INFINITY, 0.), V(1., 0.), config()),
        (agent(0., 0., 0., 0.), V(f32::NAN, 0.), config()),
        (
            Agent {
                r: -1.0,
                ..agent(0., 0., 0., 0.)
            },
            V(1., 0.),
            config(),
        ),
        (
            agent(0., 0., 0., 0.),
            V(1., 0.),
            Config {
                step: 0.0,
                ..config()
            },
        ),
        (
            agent(0., 0., 0., 0.),
            V(1., 0.),
            Config {
                max_speed: f32::NAN,
                ..config()
            },
        ),
        (
            agent(0., 0., 0., 0.),
            V(1., 0.),
            Config {
                horizon: f32::NAN,
                ..config()
            },
        ),
        (
            agent(0., 0., 0., 0.),
            V(1., 0.),
            Config {
                max_speed: -1.0,
                ..config()
            },
        ),
    ] {
        let out = simple(
            &mut f,
            vec![bad_agent],
            vec![],
            0,
            &[],
            bad_pref,
            bad_config,
        );
        assert_eq!((out[0], out[1], out[2]), (0.0, 0.0, 2.0));
    }
    // Index out of range and NaN neighbours are tolerated; a zero-length
    // obstacle edge is rejected.
    let mut ok = vec![agent(0., 0., 0., 0.), agent(f32::NAN, 0., 0., 0.)];
    let out = simple(
        &mut f,
        ok.clone(),
        vec![],
        0,
        &[1, 0, 9, 1],
        V(1., 0.),
        config(),
    );
    near_all(&out[..3], &[1.0, 0.0, 0.0], 1e-6);
    let out = simple(
        &mut f,
        ok.drain(..1).collect(),
        vec![],
        4,
        &[],
        V(1., 0.),
        config(),
    );
    assert_eq!(out[2], 2.0);
    let mut packed = packet(
        &Scene {
            agents: vec![agent(0., 0., 0., 0.)],
            polygons: vec![vec![V(1., 1.), V(1., 1.), V(2., 2.)]],
        },
        0,
        &[],
        &[0],
        V(1., 0.),
        &config(),
    );
    assert_eq!(f.floats("orca", std::mem::take(&mut packed)), vec![-1.0]);
    // Zero speed limit: the agent stays put; no neighbours with a wall.
    let out = simple(
        &mut f,
        vec![agent(0., 0., 0., 0.)],
        vec![],
        0,
        &[],
        V(1., 0.),
        Config {
            max_speed: 0.0,
            ..config()
        },
    );
    assert_eq!((out[0], out[1]), (0.0, 0.0));
    // A wall ahead stops the approach: the velocity cannot enter the wall.
    let wall = vec![V(2.0, 3.0), V(2.0, -3.0)];
    let out = simple(
        &mut f,
        vec![agent(0., 0., 1., 0.)],
        vec![wall.clone()],
        0,
        &[],
        V(2., 0.),
        config(),
    );
    assert!(
        out[0] < 2.0 && out[4] >= 1.0,
        "wall limits the speed: {out:?}"
    );
    // Squeezed by agents from both sides: infeasible, so the relaxed program
    // runs but the speed limit still holds.
    let crowd = vec![
        agent(0., 0., 0., 0.),
        agent(0.9, 0., -1., 0.),
        agent(-0.9, 0., 1., 0.),
        agent(0., 0.9, 0., -1.),
        agent(0., -0.9, 0., 1.),
    ];
    let out = simple(&mut f, crowd, vec![], 0, &[1, 2, 3, 4], V(1., 1.), config());
    assert!(
        out[2] == 1.0 && (out[0] * out[0] + out[1] * out[1]).sqrt() <= 2.0 + 1e-5,
        "{out:?}"
    );
}
