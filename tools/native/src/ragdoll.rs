//! Ragdoll witnesses: stability on a floor, powered tracking, pose read-back
//! and blending, against f64 quaternion references.
use super::*;

type Q = [f64; 4];
const TRACE: usize = 13;

struct Skeleton {
    parents: Vec<i32>,
    pos: Vec<[f64; 3]>,
    rot: Vec<Q>,
}
fn mul(a: Q, b: Q) -> Q {
    [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ]
}
fn conj(q: Q) -> Q {
    [-q[0], -q[1], -q[2], q[3]]
}
fn axis(axis: [f64; 3], angle: f64) -> Q {
    let l = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
    let (s, c) = ((angle / 2.0).sin(), (angle / 2.0).cos());
    [axis[0] / l * s, axis[1] / l * s, axis[2] / l * s, c]
}
fn nlerp(a: Q, b: Q, t: f64) -> Q {
    let sign = if a.iter().zip(&b).map(|(x, y)| x * y).sum::<f64>() < 0.0 {
        -1.0
    } else {
        1.0
    };
    let q: Vec<f64> = (0..4).map(|i| a[i] * (1.0 - t) + b[i] * sign * t).collect();
    let l = q.iter().map(|x| x * x).sum::<f64>().sqrt();
    [q[0] / l, q[1] / l, q[2] / l, q[3] / l]
}
/// The rotation angle between two orientations.
fn between(a: Q, b: Q) -> f64 {
    let d = mul(conj(a), b);
    2.0 * d[3].abs().min(1.0).acos()
}
fn humanoid(root_height: f64, wiggle: f64) -> Skeleton {
    // pelvis, spine, chest, head, arm L/R (upper, fore), leg L/R (thigh, shin)
    let parents = vec![-1, 0, 1, 2, 2, 4, 2, 6, 0, 8, 0, 10];
    let pos = vec![
        [0.0, root_height, 0.0],
        [0.0, 0.15, 0.0],
        [0.0, 0.25, 0.0],
        [0.0, 0.3, 0.0],
        [0.2, 0.2, 0.0],
        [0.3, 0.0, 0.0],
        [-0.2, 0.2, 0.0],
        [-0.3, 0.0, 0.0],
        [0.1, -0.05, 0.0],
        [0.0, -0.4, 0.0],
        [-0.1, -0.05, 0.0],
        [0.0, -0.4, 0.0],
    ];
    let mut random = Random(7);
    let rot = (0..12)
        .map(|_| {
            let a = [
                random.unit() - 0.5,
                random.unit() - 0.5,
                random.unit() - 0.5,
            ];
            axis([a[0] + 0.01, a[1], a[2]], wiggle * random.unit())
        })
        .collect();
    Skeleton { parents, pos, rot }
}
struct Run {
    n: usize,
    ticks: usize,
    data: Vec<f64>,
}
impl Run {
    fn body(&self, tick: usize, bone: usize) -> &[f64] {
        let o = (tick * self.n + bone) * TRACE;
        &self.data[o..o + TRACE]
    }
    fn local(&self, bone: usize) -> (Vec<f64>, Q) {
        let o = self.ticks * self.n * TRACE + bone * 7;
        (
            self.data[o..o + 3].to_vec(),
            [
                self.data[o + 3],
                self.data[o + 4],
                self.data[o + 5],
                self.data[o + 6],
            ],
        )
    }
    fn blended(&self, bone: usize) -> (Vec<f64>, Q) {
        let o = self.ticks * self.n * TRACE + self.n * 7 + bone * 7;
        (
            self.data[o..o + 3].to_vec(),
            [
                self.data[o + 3],
                self.data[o + 4],
                self.data[o + 5],
                self.data[o + 6],
            ],
        )
    }
}
struct Setup {
    mode: f64,
    ticks: usize,
    substeps: f64,
    swing: f64,
    twist: f64,
    strength: f64,
    scale: f64,
    hertz: f64,
    pin: bool,
    floor: Option<f64>,
    weight: f64,
    // 0 box floor, 1 tessellated mesh, 2 bumpy mesh, 3 stairs mesh.
    mesh: f64,
}
impl Default for Setup {
    fn default() -> Self {
        Self {
            mode: 0.0,
            ticks: 0,
            substeps: 8.0,
            swing: 0.8,
            twist: 0.5,
            strength: 0.0,
            scale: 0.0,
            hertz: 30.0,
            pin: false,
            floor: None,
            weight: 0.0,
            mesh: 0.0,
        }
    }
}
fn run(f: &mut Fixture, s: &Setup, bind: &Skeleton, animated: &[Q]) -> Run {
    let n = bind.parents.len();
    let mut a = vec![
        s.mode,
        s.ticks as f64,
        1.0 / 60.0,
        s.substeps,
        0.06,
        s.swing,
        -s.twist,
        s.twist,
        s.strength,
        s.scale,
        s.hertz,
        1.0,
        n as f64,
        s.pin as u32 as f64,
        s.floor.unwrap_or(-1.0e6),
        s.weight,
        s.mesh,
    ];
    for i in 0..n {
        a.push(bind.parents[i] as f64);
        a.extend(bind.pos[i]);
        a.extend(bind.rot[i]);
    }
    for i in 0..n {
        a.extend(bind.pos[i]);
        a.extend(animated[i]);
    }
    let data = f.floats("ragdoll_run", a);
    assert_eq!(data.len(), s.ticks * n * TRACE + n * 14);
    assert!(data.iter().all(|x| x.is_finite()));
    Run {
        n,
        ticks: s.ticks,
        data,
    }
}
fn bits(r: &Run) -> Vec<u64> {
    r.data.iter().map(|x| x.to_bits()).collect()
}

#[test]
fn pose_read_back_round_trips_the_bind_pose_and_blends() {
    let mut f = Fixture::new("tests/ragdoll.sq");
    let bind = humanoid(1.3, 1.2);
    let animated: Vec<Q> = (0..12)
        .map(|i| axis([0.3, 1.0, 0.2], 0.1 * i as f64))
        .collect();
    for weight in [0.0, 0.25, 1.0] {
        let r = run(
            &mut f,
            &Setup {
                weight,
                ..Default::default()
            },
            &bind,
            &animated,
        );
        for i in 0..12 {
            let (p, q) = r.local(i);
            assert!(
                between(q, bind.rot[i]) < 2e-3,
                "bone {i} rotation round trip {}",
                between(q, bind.rot[i])
            );
            near_all(&p, &bind.pos[i], 2e-4);
            // Blend of animated (weight 0) and simulated read-back (weight 1).
            let (bp, bq) = r.blended(i);
            near(between(nlerp(animated[i], q, weight), bq), 0.0, 3e-3);
            near_all(&bp, &bind.pos[i], 2e-4);
        }
    }
}

#[test]
fn bodies_start_with_joint_anchors_coincident() {
    let mut f = Fixture::new("tests/ragdoll.sq");
    let bind = humanoid(1.3, 1.2);
    let r = run(
        &mut f,
        &Setup {
            ticks: 1,
            ..Default::default()
        },
        &bind,
        &vec![[0.0, 0.0, 0.0, 1.0]; 12],
    );
    // With zero gravity impulses the bodies barely move from the bind pose, and
    // the capsule frames stay put relative to each other.
    for i in 0..12 {
        let b = r.body(0, i);
        assert!(
            b[7..10].iter().all(|v| v.abs() < 0.2),
            "bone {i} moved {:?}",
            &b[7..10]
        );
    }
}

#[test]
fn dropped_ragdoll_stays_stable_bounded_and_comes_to_rest() {
    let mut f = Fixture::new("tests/ragdoll.sq");
    let mut bind = humanoid(1.6, 0.0);
    bind.rot[0] = axis([0.0, 0.0, 1.0], 0.9);
    let setup = Setup {
        ticks: 1500,
        floor: Some(0.0),
        swing: 0.9,
        twist: 0.6,
        ..Default::default()
    };
    let animated = vec![[0.0, 0.0, 0.0, 1.0]; 12];
    let r = run(&mut f, &setup, &bind, &animated);
    let energy = |t: usize| -> f64 {
        (0..12)
            .map(|i| {
                let b = r.body(t, i);
                0.5 * (b[7] * b[7] + b[8] * b[8] + b[9] * b[9]) + 9.81 * b[1]
            })
            .sum()
    };
    let start = energy(0);
    let mut peak = 0.0f64;
    let mut speed = 0.0f64;
    let mut low = f64::INFINITY;
    for t in 0..r.ticks {
        peak = peak.max(energy(t));
        for i in 0..12 {
            let b = r.body(t, i);
            speed = speed.max((b[7] * b[7] + b[8] * b[8] + b[9] * b[9]).sqrt());
            low = low.min(b[1]);
        }
    }
    assert!(peak < start + 3.0, "energy grew from {start} to {peak}");
    assert!(speed < 12.0, "speed {speed}");
    assert!(low > -0.05, "fell through the floor: {low}");
    // At rest: tiny velocity in the last half second, bodies on or above the floor.
    for t in (r.ticks - 30)..r.ticks {
        for i in 0..12 {
            let b = r.body(t, i);
            let v = (b[7] * b[7] + b[8] * b[8] + b[9] * b[9]).sqrt();
            assert!(v < 0.1, "bone {i} still moving at {v}");
        }
    }
    assert!(energy(r.ticks - 1) < start * 0.35);
    // Replay: bit-identical.
    let again = run(&mut f, &setup, &bind, &animated);
    assert_eq!(bits(&r), bits(&again));
}

#[test]
fn powered_ragdoll_tracks_a_pose_and_relaxes_without_strength() {
    let mut f = Fixture::new("tests/ragdoll.sq");
    let mut bind = humanoid(1.3, 0.0);
    for q in &mut bind.rot {
        *q = [0.0, 0.0, 0.0, 1.0];
    }
    // Raise the left arm and bend the right elbow and a knee.
    let mut animated = vec![[0.0, 0.0, 0.0, 1.0]; 12];
    animated[4] = axis([0.0, 0.0, 1.0], 1.0);
    animated[5] = axis([0.0, 0.0, 1.0], 0.4);
    animated[7] = axis([0.0, 1.0, 0.0], 0.5);
    animated[9] = axis([1.0, 0.0, 0.0], -0.6);
    let powered = Setup {
        mode: 1.0,
        ticks: 600,
        swing: 1.5,
        twist: 0.8,
        strength: 400.0,
        scale: 1.0,
        pin: true,
        ..Default::default()
    };
    let r = run(&mut f, &powered, &bind, &animated);
    for i in 1..12 {
        let (_, q) = r.local(i);
        assert!(
            between(q, animated[i]) < 0.12,
            "bone {i} off by {}",
            between(q, animated[i])
        );
    }
    // The blended pose at weight 1 is the simulated one; the animated pose at 0.
    let half = run(
        &mut f,
        &Setup {
            weight: 0.5,
            ..powered
        },
        &bind,
        &animated,
    );
    let (_, sim) = half.local(4);
    let (_, mix) = half.blended(4);
    near(between(nlerp(animated[4], sim, 0.5), mix), 0.0, 3e-3);
    // Without strength the arm drops away from the animated pose.
    let limp = run(
        &mut f,
        &Setup {
            strength: 0.0,
            ..powered
        },
        &bind,
        &animated,
    );
    let (_, q) = limp.local(4);
    assert!(
        between(q, animated[4]) > 0.4,
        "limp arm still near pose: {}",
        between(q, animated[4])
    );
    // Half strength lands between.
    let weak = run(
        &mut f,
        &Setup {
            scale: 0.002,
            ..powered
        },
        &bind,
        &animated,
    );
    assert!(between(weak.local(4).1, animated[4]) > between(r.local(4).1, animated[4]));
}

#[test]
fn skeleton_validation_rejects_bad_input() {
    let mut f = Fixture::new("tests/ragdoll.sq");
    // [count, parents..., radius, strength]
    let ok = |f: &mut Fixture, parents: &[f64], radius: f64, strength: f64| {
        let mut a = vec![parents.len() as f64];
        a.extend(parents);
        a.extend([radius, strength]);
        f.words("skeleton", a)
    };
    assert_eq!(ok(&mut f, &[-1.0, 0.0, 1.0], 0.05, 10.0), vec![3, 2]);
    assert_eq!(ok(&mut f, &[-1.0, -1.0], 0.05, 10.0), vec![2, 0]);
    // Empty skeleton, forward/self parent, bad radius, negative or NaN strength.
    assert_eq!(ok(&mut f, &[], 0.05, 10.0), vec![0, 0]);
    assert_eq!(ok(&mut f, &[1.0, -1.0], 0.05, 10.0), vec![0, 0]);
    assert_eq!(ok(&mut f, &[-1.0, 1.0], 0.05, 10.0), vec![0, 0]);
    assert_eq!(ok(&mut f, &[-1.0, 0.0], 0.0, 10.0), vec![0, 0]);
    assert_eq!(ok(&mut f, &[-1.0, 0.0], f64::NAN, 10.0), vec![0, 0]);
    assert_eq!(ok(&mut f, &[-1.0, 0.0], 0.05, -1.0), vec![0, 0]);
    assert_eq!(ok(&mut f, &[-1.0, 0.0], 0.05, f64::NAN), vec![0, 0]);
}

#[test]
fn ragdoll_dropped_on_meshes_stays_stable_and_comes_to_rest() {
    let mut f = Fixture::new("tests/ragdoll.sq");
    let mut bind = humanoid(1.6, 0.0);
    bind.rot[0] = axis([0.0, 0.0, 1.0], 0.9);
    let animated = vec![[0.0, 0.0, 0.0, 1.0]; 12];
    for mesh in [1.0, 2.0, 3.0] {
        let setup = Setup {
            ticks: 900,
            floor: Some(0.0),
            swing: 0.9,
            twist: 0.6,
            mesh,
            ..Default::default()
        };
        let r = run(&mut f, &setup, &bind, &animated);
        let energy = |t: usize| -> f64 {
            (0..12)
                .map(|i| {
                    let b = r.body(t, i);
                    0.5 * (b[7] * b[7] + b[8] * b[8] + b[9] * b[9]) + 9.81 * b[1]
                })
                .sum()
        };
        let start = energy(0);
        let mut peak = 0.0f64;
        let mut speed = 0.0f64;
        for t in 0..r.ticks {
            peak = peak.max(energy(t));
            for i in 0..12 {
                let b = r.body(t, i);
                speed = speed.max((b[7] * b[7] + b[8] * b[8] + b[9] * b[9]).sqrt());
                // Never below the lowest surface (bumps reach -0.12).
                assert!(
                    b[1] > -0.2,
                    "mesh {mesh}: bone {i} fell through at tick {t}: {}",
                    b[1]
                );
            }
        }
        assert!(
            peak < start + 3.0,
            "mesh {mesh}: energy grew from {start} to {peak}"
        );
        assert!(speed < 12.0, "mesh {mesh}: speed {speed}");
        for t in (r.ticks - 30)..r.ticks {
            for i in 0..12 {
                let b = r.body(t, i);
                let v = (b[7] * b[7] + b[8] * b[8] + b[9] * b[9]).sqrt();
                assert!(v < 0.1, "mesh {mesh}: bone {i} still moving at {v}");
            }
        }
        assert!(
            energy(r.ticks - 1) < start * 0.4,
            "mesh {mesh}: did not settle"
        );
        let again = run(&mut f, &setup, &bind, &animated);
        assert_eq!(bits(&r), bits(&again), "mesh {mesh}: replay differs");
    }
}
