// Independent f64 references for ink/render/reflections: influence boxes with their
// smooth blend, priority groups, the box projection of a reflected ray by the
// slab method, and which probes win slots. The same formulas Pen's WGSL is
// held to (crates/pen-render/src/environment.rs, gpu tests).
use crate::*;

#[derive(Clone, Copy, Debug)]
struct Probe {
    id: u32,
    priority: u32,
    centre: [f64; 3],
    half: [f64; 3],
    blend: f64,
}

fn weight(p: &Probe, at: [f64; 3]) -> f64 {
    let edge = (0..3)
        .map(|a| p.half[a] - (at[a] - p.centre[a]).abs())
        .fold(f64::INFINITY, f64::min);
    if edge <= 0.0 {
        return 0.0;
    }
    let t = if p.blend > 0.0 {
        (edge / p.blend).clamp(0.0, 1.0)
    } else {
        1.0
    };
    t * t * (3.0 - 2.0 * t)
}

fn precedes(a: &Probe, ia: usize, b: &Probe, ib: usize) -> bool {
    (a.priority, std::cmp::Reverse(a.id), std::cmp::Reverse(ia))
        > (b.priority, std::cmp::Reverse(b.id), std::cmp::Reverse(ib))
}

// Each probe's share: sorted the way the host's table is, the first four with weight
// counted, priority groups taking what the higher ones leave.
fn shares(probes: &[Probe], at: [f64; 3]) -> Vec<f64> {
    let mut order: Vec<usize> = (0..probes.len()).collect();
    order.sort_by(|&a, &b| {
        if precedes(&probes[a], a, &probes[b], b) {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });
    let mut out = vec![0.0; probes.len()];
    let mut counted = vec![];
    for &i in &order {
        let w = weight(&probes[i], at);
        if w > 0.0 && counted.len() < 4 {
            counted.push((i, w));
        }
    }
    let mut left = 1.0;
    let mut start = 0;
    while start < counted.len() {
        let priority = probes[counted[start].0].priority;
        let end = counted[start..]
            .iter()
            .position(|&(i, _)| probes[i].priority != priority)
            .map_or(counted.len(), |n| start + n);
        let group = &counted[start..end];
        let total: f64 = group.iter().map(|&(_, w)| w).sum();
        let missed: f64 = group.iter().map(|&(_, w)| 1.0 - w).product();
        for &(i, w) in group {
            out[i] = left * (1.0 - missed) * w / total;
        }
        left *= missed;
        start = end;
    }
    out
}

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
    fn between(&mut self, low: f64, high: f64) -> f64 {
        low + (high - low) * self.next()
    }
}

fn pack(at: [f64; 3], probes: &[Probe]) -> Vec<f64> {
    let mut a = at.to_vec();
    a.push(probes.len() as f64);
    for p in probes {
        a.extend([f64::from(p.id), f64::from(p.priority)]);
        a.extend(p.centre);
        a.extend(p.half);
        a.push(p.blend);
    }
    a
}

fn random_probes(rng: &mut Lcg, n: usize) -> Vec<Probe> {
    (0..n)
        .map(|i| Probe {
            id: i as u32 + 1,
            priority: (rng.next() * 3.0) as u32,
            centre: [
                rng.between(-2.0, 2.0),
                rng.between(-1.0, 1.0),
                rng.between(-2.0, 2.0),
            ],
            half: [
                rng.between(0.5, 2.5),
                rng.between(0.5, 2.5),
                rng.between(0.5, 2.5),
            ],
            blend: if rng.next() < 0.25 {
                0.0
            } else {
                rng.between(0.1, 1.5)
            },
        })
        .collect()
}

#[test]
fn shares_match_the_f64_reference_sum_to_the_coverage_and_never_pass_one() {
    let mut f = Fixture::new("tests/reflections.sq");
    let mut rng = Lcg(7);
    let mut covered = 0;
    for case in 0..120 {
        let n = 1 + (case % 7);
        let probes = random_probes(&mut rng, n);
        let at = [
            rng.between(-3.0, 3.0),
            rng.between(-2.0, 2.0),
            rng.between(-3.0, 3.0),
        ];
        let got = f.floats("shares", pack(at, &probes));
        let want = shares(&probes, at);
        for i in 0..n {
            assert!(
                (got[i] - want[i]).abs() < 2e-5,
                "case {case} probe {i}: {} vs {}",
                got[i],
                want[i]
            );
        }
        let (sum, coverage) = (got[n], got[n + 1]);
        assert!((sum - want.iter().sum::<f64>()).abs() < 2e-5);
        assert!(
            (sum - coverage).abs() < 1e-6,
            "the shares add up to the coverage"
        );
        assert!((-1e-9..=1.0 + 1e-6).contains(&sum), "case {case}: {sum}");
        covered += usize::from(sum > 0.0);
    }
    assert!(covered > 40, "the cases reach the boxes: {covered}");
}

#[test]
fn a_higher_priority_takes_first_equal_ones_share_and_a_fifth_probe_is_left_out() {
    let mut f = Fixture::new("tests/reflections.sq");
    let b = |id, priority, x: f64| Probe {
        id,
        priority,
        centre: [x, 0., 0.],
        half: [3., 3., 3.],
        blend: 0.0,
    };
    // Hard boxes all holding the origin: priority 2 covers it whole, nothing is left for the rest.
    let got = f.floats(
        "shares",
        pack([0., 0., 0.], &[b(1, 0, 0.), b(2, 2, 0.), b(3, 0, 1.)]),
    );
    assert_eq!(&got[..3], &[0., 1., 0.]);
    // Equal priorities with hard boxes: 1 - (1 - 1)(1 - 1) = 1 covered, split by weight.
    let got = f.floats("shares", pack([0., 0., 0.], &[b(1, 1, 0.), b(2, 1, 1.)]));
    assert_eq!(&got[..2], &[0.5, 0.5]);
    // Five probes of one priority and hard edges: the first four by id count, the fifth gets nothing.
    let five: Vec<Probe> = (1..=5).map(|id| b(id, 0, 0.)).collect();
    let got = f.floats("shares", pack([0., 0., 0.], &five));
    assert_eq!(&got[..5], &[0.25, 0.25, 0.25, 0.25, 0.]);
    // A half-faded probe over a full one of lower priority leaves the rest to the lower one.
    let faded = Probe {
        id: 1,
        priority: 1,
        centre: [0., 0., 0.],
        half: [1., 1., 1.],
        blend: 2.0,
    };
    let under = b(2, 0, 0.);
    // 0.5 in from the face, over a blend of 2: t = 0.25, weight 0.15625.
    let got = f.floats("shares", pack([0.5, 0., 0.], &[faded, under]));
    let w = 0.25f64 * 0.25 * (3.0 - 0.5);
    assert!(
        (got[0] - w).abs() < 1e-6 && (got[1] - (1.0 - w)).abs() < 1e-6,
        "{got:?}"
    );
}

#[test]
fn the_weight_fades_smoothly_from_a_face_to_the_blend_distance() {
    let mut f = Fixture::new("tests/reflections.sq");
    let p = Probe {
        id: 1,
        priority: 0,
        centre: [0., 0., 0.],
        half: [2., 2., 2.],
        blend: 0.8,
    };
    let mut last = 0.0;
    for step in 0..=420 {
        let x = 2.05 - f64::from(step) * 0.005;
        let got = f.floats("shares", pack([x, 0., 0.], &[p]))[0];
        assert!((got - weight(&p, [x, 0., 0.])).abs() < 2e-5, "x {x}");
        assert!(got >= last - 1e-6, "monotonic");
        assert!(got - last < 0.03, "no jump at x {x}: {}", got - last);
        last = got;
    }
    assert_eq!(last, 1.0);
}

#[test]
fn a_reflected_ray_is_looked_up_where_it_leaves_the_parallax_box() {
    let mut f = Fixture::new("tests/reflections.sq");
    let mut rng = Lcg(11);
    for case in 0..200 {
        let position = [
            rng.between(-1., 1.),
            rng.between(0., 2.),
            rng.between(-1., 1.),
        ];
        let centre = [
            rng.between(-0.5, 0.5),
            rng.between(1., 1.5),
            rng.between(-0.5, 0.5),
        ];
        let half = [
            rng.between(3., 6.),
            rng.between(1.5, 3.),
            rng.between(3., 6.),
        ];
        let point = [
            rng.between(-2., 2.),
            rng.between(0., 2.4),
            rng.between(-2., 2.),
        ];
        let mut d = [
            rng.between(-1., 1.),
            rng.between(-1., 1.),
            rng.between(-1., 1.),
        ];
        let length = d.iter().map(|v| v * v).sum::<f64>().sqrt();
        d = d.map(|v| v / length);
        let mut a = position.to_vec();
        a.extend(centre);
        a.extend(half);
        a.extend(point);
        a.extend(d);
        let got = f.floats("projected", a);
        // The slab method: the first face the ray leaves through; the hit must lie on it.
        let along = (0..3)
            .map(|k| ((centre[k] + half[k].copysign(d[k])) - point[k]) / d[k])
            .fold(f64::INFINITY, f64::min);
        let hit: [f64; 3] = std::array::from_fn(|k| point[k] + d[k] * along);
        assert!(
            (0..3).any(|k| ((hit[k] - centre[k]).abs() - half[k]).abs() < 1e-9),
            "case {case}: on a face"
        );
        assert!((0..3).all(|k| (hit[k] - centre[k]).abs() <= half[k] + 1e-9));
        for k in 0..3 {
            assert!(
                (got[k] - (hit[k] - position[k])).abs() < 1e-4,
                "case {case} axis {k}: {} vs {}",
                got[k],
                hit[k] - position[k]
            );
        }
    }
    // Without a box (a half size of 0) the direction is the lookup.
    let got = f.floats(
        "projected",
        vec![1., 1., 1., 0., 0., 0., 0., 2., 2., 0., 0., 0., 0., 0., 1.],
    );
    assert_eq!(got, vec![0., 0., 1.]);
}

#[test]
fn the_host_keeps_the_highest_priority_then_the_nearest_boxes() {
    let mut f = Fixture::new("tests/reflections.sq");
    let probes: Vec<Probe> = (0..10u32)
        .map(|i| Probe {
            id: i + 1,
            priority: u32::from(i == 9) * 5,
            centre: [f64::from(i) * 10.0, 0., 0.],
            half: [1., 1., 1.],
            blend: 0.0,
        })
        .collect();
    let mut a = vec![0.0, 0.0, 0.0, 8.0];
    a.extend(&pack([0., 0., 0.], &probes)[3..]);
    let got = f.floats("chosen", a);
    // The priority 5 probe (index 9), then the nearest seven.
    assert_eq!(got, vec![9., 0., 1., 2., 3., 4., 5., 6.]);
    // The same probes listed backwards choose the same ids.
    let mut backwards = probes.clone();
    backwards.reverse();
    let mut a = vec![0.0, 0.0, 0.0, 8.0];
    a.extend(&pack([0., 0., 0.], &backwards)[3..]);
    let ids: Vec<u32> = f
        .floats("chosen", a)
        .iter()
        .map(|&i| backwards[i as usize].id)
        .collect();
    assert_eq!(ids, vec![10, 1, 2, 3, 4, 5, 6, 7]);
}
