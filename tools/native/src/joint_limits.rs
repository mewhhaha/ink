//! Independent f64 references for the joint kinds: swing/twist decomposition,
//! hinge angle and slider translation measured from simulated body states.
use super::*;

const SOURCE: usize = 18;
const JOINT: usize = 40;
const HEADER: usize = 10;
const TRACE: usize = 13;
type Q = [f64; 4];
type V = [f64; 3];

#[derive(Clone)]
struct Body {
    kind: f64,
    shape: f64,
    pos: V,
    rot: Q,
    radius: f64,
    height: f64,
    lin: V,
    ang: V,
    mass: f64,
}
impl Body {
    fn dynamic(pos: V) -> Self {
        Self {
            kind: 1.0,
            shape: 0.0,
            pos,
            rot: [0.0, 0.0, 0.0, 1.0],
            radius: 0.3,
            height: 1.0,
            lin: [0.0; 3],
            ang: [0.0; 3],
            mass: 1.0,
        }
    }
    fn fixed(pos: V) -> Self {
        Self {
            kind: 0.0,
            ..Self::dynamic(pos)
        }
    }
}
#[derive(Clone)]
struct Joint(Vec<f64>);
impl Joint {
    fn new(kind: f64, a: usize, b: usize, anchor_a: V, anchor_b: V) -> Self {
        let mut l = vec![0.0; JOINT];
        l[0] = kind;
        l[1] = a as f64;
        l[2] = b as f64;
        l[3..6].copy_from_slice(&anchor_a);
        l[6..9].copy_from_slice(&anchor_b);
        l[9..12].copy_from_slice(&[0.0, 1.0, 0.0]);
        l[12..15].copy_from_slice(&[0.0, 1.0, 0.0]);
        l[18] = std::f64::consts::PI;
        l[22] = 1.0;
        l[28 + 3] = 1.0;
        Self(l)
    }
    fn axes(mut self, a: V, b: V) -> Self {
        self.0[9..12].copy_from_slice(&a);
        self.0[12..15].copy_from_slice(&b);
        self
    }
    fn limits(mut self, lower: f64, upper: f64) -> Self {
        self.0[15] = 1.0;
        self.0[16] = lower;
        self.0[17] = upper;
        self
    }
    fn swing(mut self, swing: f64) -> Self {
        self.0[18] = swing;
        self
    }
    fn motor(mut self, mode: f64, value: f64, torque: f64) -> Self {
        self.0[23] = mode;
        self.0[24] = value;
        self.0[25] = torque;
        self.0[26] = 30.0;
        self.0[27] = 1.0;
        self
    }
}
fn encode(
    ticks: usize,
    dt: f64,
    substeps: u32,
    gravity: V,
    floor: Option<f64>,
    bodies: &[Body],
    joints: &[Joint],
) -> Vec<f64> {
    let mut a = vec![
        ticks as f64,
        dt,
        substeps as f64,
        gravity[0],
        gravity[1],
        gravity[2],
        bodies.len() as f64,
        joints.len() as f64,
        floor.is_some() as u32 as f64,
        floor.unwrap_or(0.0),
    ];
    for b in bodies {
        a.extend([b.kind, b.shape]);
        a.extend(b.pos);
        a.extend(b.rot);
        a.extend([b.radius, b.height]);
        a.extend(b.lin);
        a.extend(b.ang);
        a.push(b.mass);
    }
    assert_eq!(a.len(), HEADER + bodies.len() * SOURCE);
    for j in joints {
        a.extend(&j.0);
    }
    a
}
struct Trace {
    count: usize,
    data: Vec<f64>,
}
impl Trace {
    fn ticks(&self) -> usize {
        self.data.len() / (self.count * TRACE)
    }
    fn at(&self, tick: usize, body: usize) -> &[f64] {
        let o = (tick * self.count + body) * TRACE;
        &self.data[o..o + TRACE]
    }
}
fn run(
    f: &mut Fixture,
    ticks: usize,
    substeps: u32,
    gravity: V,
    floor: Option<f64>,
    bodies: &[Body],
    joints: &[Joint],
) -> Trace {
    let data = f.floats(
        "scenario",
        encode(ticks, 1.0 / 60.0, substeps, gravity, floor, bodies, joints),
    );
    assert!(data.iter().all(|x| x.is_finite()), "non-finite state");
    Trace {
        count: bodies.len(),
        data,
    }
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
fn rotate(q: Q, v: V) -> V {
    let r = mul(mul(q, [v[0], v[1], v[2], 0.0]), conj(q));
    [r[0], r[1], r[2]]
}
fn norm(q: Q) -> Q {
    let l = q.iter().map(|x| x * x).sum::<f64>().sqrt();
    [q[0] / l, q[1] / l, q[2] / l, q[3] / l]
}
fn dot(a: V, b: V) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn q_of(s: &[f64]) -> Q {
    norm([s[3], s[4], s[5], s[6]])
}
/// Swing angle and twist angle of the rotation `q` about unit `axis` (world).
fn swing_twist(q: Q, axis: V) -> (f64, f64) {
    let q = if q[3] < 0.0 {
        [-q[0], -q[1], -q[2], -q[3]]
    } else {
        q
    };
    let along = dot([q[0], q[1], q[2]], axis);
    let twist = 2.0 * along.atan2(q[3]);
    let length = (along * along + q[3] * q[3]).sqrt();
    let t = [
        axis[0] * along / length,
        axis[1] * along / length,
        axis[2] * along / length,
        q[3] / length,
    ];
    let s = mul(q, conj(t));
    let sv = (s[0] * s[0] + s[1] * s[1] + s[2] * s[2]).sqrt();
    (2.0 * sv.atan2(s[3].abs()), twist)
}
fn axis_angle(axis: V, angle: f64) -> Q {
    let (s, c) = ((angle / 2.0).sin(), (angle / 2.0).cos());
    [axis[0] * s, axis[1] * s, axis[2] * s, c]
}

#[test]
fn swing_twist_reference_matches_constructed_rotations() {
    for (swing, twist) in [(0.3, 0.2), (0.9, -1.0), (0.0, 2.0), (1.5, 0.0)] {
        let q = mul(
            axis_angle([1.0, 0.0, 0.0], swing),
            axis_angle([0.0, 1.0, 0.0], twist),
        );
        let (s, t) = swing_twist(q, [0.0, 1.0, 0.0]);
        near(s, swing, 1e-9);
        near(t, twist, 1e-9);
    }
}

fn pendulum(rot: Q, ang: V) -> (Vec<Body>, V) {
    // Pivot at the static body; the capsule hangs below it, anchored at its top.
    let pivot = [0.0, 2.0, 0.0];
    let mut b = Body::dynamic([0.0; 3]);
    b.shape = 1.0;
    b.rot = rot;
    let off = rotate(rot, [0.0, -0.5, 0.0]);
    b.pos = [pivot[0] + off[0], pivot[1] + off[1], pivot[2] + off[2]];
    b.ang = ang;
    (vec![Body::fixed(pivot), b], pivot)
}

#[test]
fn cone_twist_limits_hold_under_gravity_and_spin() {
    let mut f = Fixture::new("tests/ragdoll.sq");
    let (swing_limit, low, high) = (0.5f64, -0.4f64, 0.6f64);
    let joint = Joint::new(3.0, 0, 1, [0.0; 3], [0.0, 0.5, 0.0])
        .axes([0.0, 1.0, 0.0], [0.0, 1.0, 0.0])
        .swing(swing_limit)
        .limits(low, high);
    // Starts well outside the cone; spins about the twist axis; a second case
    // swings sideways with gravity pulling the body into the cone wall.
    for (rot, ang, label) in [
        (axis_angle([0.0, 0.0, 1.0], 1.2), [0.0; 3], "outside cone"),
        (axis_angle([0.0, 1.0, 0.0], 0.0), [0.0, 6.0, 0.0], "spin"),
        (
            axis_angle([0.0, 1.0, 0.0], 0.0),
            [0.0, -6.0, 0.0],
            "counter spin",
        ),
        (axis_angle([1.0, 0.0, 0.0], 0.4), [2.0, 3.0, -2.0], "mixed"),
    ] {
        let (bodies, _) = pendulum(rot, ang);
        let t = run(
            &mut f,
            1200,
            8,
            [0.0, -9.81, 0.0],
            None,
            &bodies,
            &[joint.clone()],
        );
        let (mut worst_swing, mut worst_twist) = (0.0f64, 0.0f64);
        for tick in 120..t.ticks() {
            let (s, tw) = swing_twist(q_of(t.at(tick, 1)), [0.0, 1.0, 0.0]);
            worst_swing = worst_swing.max(s - swing_limit);
            worst_twist = worst_twist.max(tw - high).max(low - tw);
            let p = t.at(tick, 1);
            let top = [
                p[0] + rotate(q_of(p), [0.0, 0.5, 0.0])[0],
                p[1] + rotate(q_of(p), [0.0, 0.5, 0.0])[1],
                p[2] + rotate(q_of(p), [0.0, 0.5, 0.0])[2],
            ];
            assert!(
                (top[0].powi(2) + (top[1] - 2.0).powi(2) + top[2].powi(2)).sqrt() < 0.05,
                "{label}: pivot drift"
            );
        }
        assert!(
            worst_swing < 0.06 && worst_twist < 0.06,
            "{label}: swing over {worst_swing}, twist over {worst_twist}"
        );
    }
}

#[test]
fn cone_wall_holds_a_sideways_load() {
    let mut f = Fixture::new("tests/ragdoll.sq");
    let joint = Joint::new(3.0, 0, 1, [0.0; 3], [0.0, 0.5, 0.0])
        .axes([0.0, 1.0, 0.0], [0.0, 1.0, 0.0])
        .swing(0.5)
        .limits(-0.4, 0.6);
    let (bodies, _) = pendulum([0.0, 0.0, 0.0, 1.0], [0.0; 3]);
    // Gravity leans 76 degrees from the axis: the cone wall must carry it.
    let t = run(&mut f, 900, 8, [8.0, -2.0, 0.0], None, &bodies, &[joint]);
    for tick in 300..t.ticks() {
        let (s, _) = swing_twist(q_of(t.at(tick, 1)), [0.0, 1.0, 0.0]);
        assert!((0.45..0.56).contains(&s), "swing {s} at {tick}");
    }
}

#[test]
fn hinge_angle_limits_and_motors() {
    let mut f = Fixture::new("tests/ragdoll.sq");
    // Arm along +x from a z-axis hinge; gravity swings it down (negative angle).
    let arm = |rot_z: f64, ang: V| {
        let mut b = Body::dynamic([1.0, 2.0, 0.0]);
        b.rot = axis_angle([0.0, 0.0, 1.0], rot_z);
        let off = rotate(b.rot, [1.0, 0.0, 0.0]);
        b.pos = [off[0], 2.0 + off[1], off[2]];
        b.ang = ang;
        vec![Body::fixed([0.0, 2.0, 0.0]), b]
    };
    let hinge =
        || Joint::new(2.0, 0, 1, [0.0; 3], [-1.0, 0.0, 0.0]).axes([0.0, 0.0, 1.0], [0.0, 0.0, 1.0]);
    let angle = |t: &Trace, tick: usize| {
        let q = q_of(t.at(tick, 1));
        let q = if q[3] < 0.0 {
            [-q[0], -q[1], -q[2], -q[3]]
        } else {
            q
        };
        2.0 * q[2].atan2(q[3])
    };
    // Lower limit holds the sagging arm; upper limit catches a fast swing up.
    let t = run(
        &mut f,
        900,
        8,
        [0.0, -9.81, 0.0],
        None,
        &arm(0.0, [0.0; 3]),
        &[hinge().limits(-0.6, 0.8)],
    );
    let mut worst = 0.0f64;
    for tick in 0..t.ticks() {
        worst = worst.max(-0.6 - angle(&t, tick)).max(angle(&t, tick) - 0.8);
    }
    assert!(worst < 0.05, "hinge lower violation {worst}");
    near(angle(&t, t.ticks() - 1), -0.6, 0.05);
    let t = run(
        &mut f,
        600,
        8,
        [0.0, -9.81, 0.0],
        None,
        &arm(0.0, [0.0, 0.0, 9.0]),
        &[hinge().limits(-0.6, 0.8)],
    );
    let mut worst = 0.0f64;
    for tick in 0..t.ticks() {
        worst = worst.max(-0.6 - angle(&t, tick)).max(angle(&t, tick) - 0.8);
    }
    assert!(worst < 0.06, "hinge upper violation {worst}");
    // Velocity motor reaches its speed (no gravity), position motor its angle
    // (with gravity pulling against it).
    let t = run(
        &mut f,
        120,
        8,
        [0.0; 3],
        None,
        &arm(0.0, [0.0; 3]),
        &[hinge().motor(1.0, 2.0, 50.0)],
    );
    near(t.at(119, 1)[12], 2.0, 0.05);
    let t = run(
        &mut f,
        600,
        8,
        [0.0, -9.81, 0.0],
        None,
        &arm(0.0, [0.0; 3]),
        &[hinge().motor(2.0, 0.7, 200.0)],
    );
    near(angle(&t, t.ticks() - 1), 0.7, 0.05);
    // A weak motor loses to its torque cap and the limit still holds.
    let t = run(
        &mut f,
        600,
        8,
        [0.0; 3],
        None,
        &arm(0.0, [0.0; 3]),
        &[hinge().limits(-0.5, 0.5).motor(1.0, 3.0, 50.0)],
    );
    near(angle(&t, t.ticks() - 1), 0.5, 0.05);
}

#[test]
fn slider_limits_and_motors() {
    let mut f = Fixture::new("tests/ragdoll.sq");
    let bodies = |vx: f64| {
        let mut b = Body::dynamic([0.0, 1.0, 0.0]);
        b.lin = [vx, 0.0, 0.0];
        vec![Body::fixed([0.0, 1.0, 0.0]), b]
    };
    let slider =
        || Joint::new(4.0, 0, 1, [0.0; 3], [0.0; 3]).axes([1.0, 0.0, 0.0], [1.0, 0.0, 0.0]);
    for (vx, label) in [(4.0, "toward upper"), (-4.0, "toward lower")] {
        let t = run(
            &mut f,
            600,
            8,
            [0.0, -9.81, 0.0],
            None,
            &bodies(vx),
            &[slider().limits(-0.5, 1.0)],
        );
        let mut worst = 0.0f64;
        let (mut sag, mut spin) = (0.0f64, 0.0f64);
        for tick in 0..t.ticks() {
            let s = t.at(tick, 1);
            worst = worst.max(-0.5 - s[0]).max(s[0] - 1.0);
            sag = sag.max((s[1] - 1.0).abs()).max(s[2].abs());
            spin = spin.max((1.0 - s[6].abs()).abs());
        }
        assert!(
            worst < 0.04 && sag < 0.03 && spin < 0.01,
            "{label}: over {worst}, sag {sag}, spin {spin}"
        );
        near(t.at(599, 1)[0], if vx > 0.0 { 1.0 } else { -0.5 }, 0.05);
    }
    let t = run(
        &mut f,
        300,
        8,
        [0.0; 3],
        None,
        &bodies(0.0),
        &[slider().motor(1.0, 1.5, 100.0)],
    );
    near(t.at(60, 1)[7], 1.5, 0.05);
    let t = run(
        &mut f,
        600,
        8,
        [0.0, -9.81, 0.0],
        None,
        &bodies(0.0),
        &[slider().motor(2.0, 0.4, 500.0)],
    );
    near(t.at(599, 1)[0], 0.4, 0.03);
}

#[test]
fn fixed_joint_holds_pose() {
    let mut f = Fixture::new("tests/ragdoll.sq");
    let mut b = Body::dynamic([1.5, 2.0, 0.0]);
    b.shape = 1.0;
    b.ang = [1.0, 2.0, 0.5];
    let joint = Joint::new(5.0, 0, 1, [0.0; 3], [-1.5, 0.0, 0.0]);
    let t = run(
        &mut f,
        900,
        8,
        [0.0, -9.81, 0.0],
        None,
        &[Body::fixed([0.0, 2.0, 0.0]), b],
        &[joint],
    );
    let s = t.at(899, 1);
    near_all(&s[0..3], &[1.5, 2.0, 0.0], 0.05);
    assert!(s[3].abs() < 0.03 && s[4].abs() < 0.03 && s[5].abs() < 0.03 && s[6] > 0.99);
}

#[test]
fn heavy_chain_keeps_every_limit_over_a_long_run() {
    let mut f = Fixture::new("tests/ragdoll.sq");
    // Six ball joints in a chain with a heavy tip, swung from the side.
    let links = 6;
    let mut bodies = vec![Body::fixed([0.0, 4.0, 0.0])];
    let mut joints = vec![];
    for i in 0..links {
        let mut b = Body::dynamic([0.0, 3.5 - i as f64, 0.0]);
        b.shape = 1.0;
        b.lin = [if i == 0 { 0.0 } else { 0.0 }, 0.0, 0.0];
        b.mass = if i == links - 1 { 8.0 } else { 1.0 };
        b.ang = [0.0, 0.0, 0.0];
        bodies.push(b);
        let (anchor_a, anchor_b) = if i == 0 {
            ([0.0; 3], [0.0, 0.5, 0.0])
        } else {
            ([0.0, -0.5, 0.0], [0.0, 0.5, 0.0])
        };
        joints.push(
            Joint::new(3.0, i, i + 1, anchor_a, anchor_b)
                .axes([0.0, 1.0, 0.0], [0.0, 1.0, 0.0])
                .swing(0.6)
                .limits(-0.5, 0.5),
        );
    }
    bodies[1 + links - 1].lin = [4.0, 0.0, 0.0];
    let t = run(&mut f, 1500, 16, [0.0, -9.81, 0.0], None, &bodies, &joints);
    let (mut swing, mut twist, mut gap) = (0.0f64, 0.0f64, 0.0f64);
    for tick in 60..t.ticks() {
        for i in 0..links {
            let qa = if i == 0 {
                [0.0, 0.0, 0.0, 1.0]
            } else {
                q_of(t.at(tick, i))
            };
            let qb = q_of(t.at(tick, i + 1));
            let rel = mul(conj(qa), qb);
            let rel_world = mul(mul(qa, rel), conj(qa));
            let axis = rotate(qa, [0.0, 1.0, 0.0]);
            let (s, tw) = swing_twist(rel_world, axis);
            swing = swing.max(s - 0.6);
            twist = twist.max(tw - 0.5).max(-0.5 - tw);
            let pa = if i == 0 {
                [0.0, 4.0, 0.0]
            } else {
                t.at(tick, i)[0..3].try_into().unwrap()
            };
            let anchor_a = if i == 0 {
                [0.0; 3]
            } else {
                rotate(qa, [0.0, -0.5, 0.0])
            };
            let pb = t.at(tick, i + 1);
            let anchor_b = rotate(qb, [0.0, 0.5, 0.0]);
            let d: Vec<f64> = (0..3)
                .map(|k| pa[k] + anchor_a[k] - pb[k] - anchor_b[k])
                .collect();
            gap = gap.max(d.iter().map(|x| x * x).sum::<f64>().sqrt());
        }
    }
    assert!(
        swing < 0.1 && twist < 0.1 && gap < 0.12,
        "swing {swing}, twist {twist}, stretch {gap}"
    );
}

#[test]
fn joint_scenarios_replay_bit_identically() {
    let mut f = Fixture::new("tests/ragdoll.sq");
    let (bodies, _) = pendulum(axis_angle([0.0, 0.0, 1.0], 1.0), [1.0, 2.0, 3.0]);
    let joint = Joint::new(3.0, 0, 1, [0.0; 3], [0.0, 0.5, 0.0])
        .axes([0.0, 1.0, 0.0], [0.0, 1.0, 0.0])
        .swing(0.5)
        .limits(-0.4, 0.4);
    let a = run(
        &mut f,
        300,
        8,
        [0.0, -9.81, 0.0],
        None,
        &bodies,
        &[joint.clone()],
    );
    let b = run(&mut f, 300, 8, [0.0, -9.81, 0.0], None, &bodies, &[joint]);
    assert_eq!(
        a.data.iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
        b.data.iter().map(|x| x.to_bits()).collect::<Vec<_>>()
    );
}

#[test]
fn invalid_joints_are_rejected_or_ignored() {
    let mut f = Fixture::new("tests/ragdoll.sq");
    let base = || {
        Joint::new(3.0, 0, 1, [0.0; 3], [0.0, 0.5, 0.0])
            .swing(0.5)
            .limits(-0.4, 0.4)
    };
    assert_eq!(f.number("joint_valid", base().0), 1.0);
    let mut cases: Vec<(&str, Joint)> = vec![];
    cases.push(("inverted limits", base().limits(0.4, -0.4)));
    cases.push(("negative swing", base().swing(-0.1)));
    cases.push(("swing beyond pi", base().swing(4.0)));
    cases.push(("twist beyond pi", base().limits(-0.4, 4.0)));
    cases.push(("self joint", Joint::new(3.0, 1, 1, [0.0; 3], [0.0; 3])));
    let mut zero_axis = base();
    zero_axis.0[9..12].copy_from_slice(&[0.0; 3]);
    cases.push(("zero axis", zero_axis));
    let mut zero_rest = base();
    zero_rest.0[19..23].copy_from_slice(&[0.0; 4]);
    cases.push(("zero rest", zero_rest));
    cases.push((
        "zero hertz",
        base().motor(3.0, 0.0, 1.0).motor(3.0, 0.0, 1.0),
    ));
    for lane in [3usize, 9, 16, 17, 18, 19, 24, 25, 26, 28] {
        let mut j = base().motor(if lane == 28 { 3.0 } else { 2.0 }, 0.1, 1.0);
        j.0[lane] = f64::NAN;
        cases.push(("nan lane", j));
    }
    for (label, j) in &mut cases {
        if *label == "zero hertz" {
            j.0[26] = 0.0;
        }
    }
    for (label, j) in cases {
        assert_eq!(f.number("joint_valid", j.0), 0.0, "{label}");
    }
    // An ignored joint leaves the simulation as if it did not exist.
    let (bodies, _) = pendulum(axis_angle([0.0, 0.0, 1.0], 1.0), [0.0; 3]);
    let nan = {
        let mut j = base();
        j.0[16] = f64::NAN;
        j
    };
    let with = f.floats(
        "scenario",
        encode(60, 1.0 / 60.0, 4, [0.0, -9.81, 0.0], None, &bodies, &[nan]),
    );
    let without = f.floats(
        "scenario",
        encode(60, 1.0 / 60.0, 4, [0.0, -9.81, 0.0], None, &bodies, &[]),
    );
    assert_eq!(with.len(), without.len());
    assert!(
        with.iter()
            .zip(&without)
            .all(|(a, b)| a.to_bits() == b.to_bits() || (a - b).abs() < 1e-6)
    );
}
