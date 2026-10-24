use super::*;
#[derive(Clone)]
struct Body {
    kind: f64,
    mass: f64,
    gravity: f64,
    linear_damping: f64,
    angular_damping: f64,
    can_sleep: bool,
    continuous: bool,
    velocity: [f64; 3],
    angular_velocity: [f64; 3],
    sleeping: bool,
    sleep_time: f64,
}
impl Default for Body {
    fn default() -> Self {
        Self {
            kind: 1.0,
            mass: 1.0,
            gravity: 1.0,
            linear_damping: 0.0,
            angular_damping: 0.05,
            can_sleep: true,
            continuous: true,
            velocity: [0.0; 3],
            angular_velocity: [0.0; 3],
            sleeping: false,
            sleep_time: 0.0,
        }
    }
}
#[derive(Clone)]
struct Walker {
    slope: f64,
    step: f64,
    snap: f64,
    push: f64,
}
impl Default for Walker {
    fn default() -> Self {
        Self {
            slope: 50.0,
            step: 0.4,
            snap: 0.3,
            push: 1.0,
        }
    }
}
#[derive(Clone)]
struct Source {
    id: u32,
    position: [f64; 3],
    rotation: [f64; 4],
    size: [f64; 3],
    shape: f64,
    radius: f64,
    height: f64,
    offset: [f64; 3],
    friction: f64,
    restitution: f64,
    trigger: bool,
    layer: u32,
    mask: u32,
    body: Option<Body>,
    walker: Option<Walker>,
    planes: Vec<[f64; 4]>,
}
fn box_(id: u32, position: [f64; 3], size: [f64; 3]) -> Source {
    Source {
        id,
        position,
        size,
        rotation: [0.0, 0.0, 0.0, 1.0],
        shape: 0.0,
        radius: 0.5,
        height: 2.0,
        offset: [0.0; 3],
        friction: 0.6,
        restitution: 0.0,
        trigger: false,
        layer: 1,
        mask: 65535,
        body: None,
        walker: None,
        planes: vec![],
    }
}
fn walker(position: [f64; 3], config: Walker) -> Source {
    let mut s = box_(100, position, [1.0; 3]);
    s.shape = 2.0;
    s.radius = 0.4;
    s.height = 1.8;
    s.offset = [0.0, 0.9, 0.0];
    s.walker = Some(config);
    s
}
fn floor() -> Source {
    box_(1, [0.0, -0.5, 0.0], [100.0, 1.0, 100.0])
}
fn stack(count: u32, can_sleep: bool) -> Vec<Source> {
    let mut sources = vec![box_(1, [0.0, -0.5, 0.0], [40.0, 1.0, 40.0])];
    for i in 0..count {
        let mut s = box_(i + 2, [0.0, 0.5 + i as f64, 0.0], [1.0; 3]);
        s.body = Some(Body {
            can_sleep,
            ..Default::default()
        });
        sources.push(s);
    }
    sources
}
struct World {
    fixture: Fixture,
    ids: Vec<u32>,
    lanes: Vec<f64>,
}
#[derive(Debug)]
struct State {
    position: [f64; 3],
    velocity: [f64; 3],
    sleeping: bool,
    grounded: bool,
    ground: f64,
}
impl World {
    fn new(sources: Vec<Source>) -> Self {
        let mut lanes = vec![0.0; 14 + sources.len() * 75];
        lanes[0] = 1.0 / 60.0;
        lanes[13] = sources.len() as f64;
        for (i, s) in sources.iter().enumerate() {
            let o = 14 + i * 75;
            let a = &mut lanes[o..o + 75];
            a[0] = s.id as f64;
            a[1..4].copy_from_slice(&s.position);
            a[4..8].copy_from_slice(&s.rotation);
            a[8..11].copy_from_slice(&s.size);
            a[11] = s.shape;
            a[12] = s.radius;
            a[13] = s.height;
            a[14..17].copy_from_slice(&s.offset);
            a[17] = s.friction;
            a[18] = s.restitution;
            a[19] = u32::from(s.trigger) as f64;
            if let Some(b) = &s.body {
                a[20..27].copy_from_slice(&[
                    b.kind,
                    b.mass,
                    b.gravity,
                    b.linear_damping,
                    b.angular_damping,
                    u32::from(b.can_sleep) as f64,
                    u32::from(b.continuous) as f64,
                ]);
                a[27..30].copy_from_slice(&b.velocity);
                a[30..33].copy_from_slice(&b.angular_velocity);
                a[33] = u32::from(b.sleeping) as f64;
                a[34] = b.sleep_time;
            }
            if let Some(w) = &s.walker {
                a[35..40].copy_from_slice(&[1.0, w.slope, w.step, w.snap, w.push]);
            }
            assert!(s.planes.len() <= 6);
            a[48] = s.planes.len() as f64;
            for (p, plane) in s.planes.iter().enumerate() {
                a[49 + p * 4..53 + p * 4].copy_from_slice(plane);
            }
            a[73] = s.layer as f64;
            a[74] = s.mask as f64;
        }
        Self {
            fixture: Fixture::new("tests/physics.blot"),
            ids: sources.iter().map(|s| s.id).collect(),
            lanes,
        }
    }
    fn advance(&mut self, ticks: usize, velocity: [f64; 3], jump: bool, moving: bool) {
        self.lanes[2..5].copy_from_slice(&velocity);
        self.lanes[1] = u32::from(jump) as f64;
        self.lanes[12] = u32::from(moving) as f64;
        for _ in 0..ticks {
            self.lanes = self.fixture.floats("step", self.lanes.as_slice());
        }
    }
    fn tick(&mut self, ticks: usize) {
        self.advance(ticks, [0.0; 3], false, false)
    }
    fn state(&self, id: u32) -> State {
        let i = self.ids.iter().position(|&n| n == id).unwrap();
        let o = 14 + i * 75;
        let a = &self.lanes[o..o + 75];
        State {
            position: a[1..4].try_into().unwrap(),
            velocity: a[27..30].try_into().unwrap(),
            sleeping: a[33] == 1.0,
            grounded: a[43] == 1.0,
            ground: a[44],
        }
    }
    fn query(
        &mut self,
        mode: f64,
        origin: [f64; 3],
        direction: [f64; 3],
        reach: f64,
        radius: f64,
        skip: f64,
        mask: f64,
    ) -> Vec<f64> {
        let mut a = self.lanes.clone();
        a[1] = mode;
        a[2..5].copy_from_slice(&direction);
        a[5] = reach;
        a[6] = radius;
        a[7] = skip;
        a[8..11].copy_from_slice(&origin);
        a[11] = mask;
        self.fixture.floats("query", a)
    }
}
#[test]
fn physics_towers_are_deterministic_and_bounded_without_sleep() {
    let mut first = World::new(stack(50, true));
    let mut second = World::new(stack(50, true));
    first.tick(600);
    second.tick(600);
    assert_eq!(first.lanes, second.lanes);
    let mut sag = 0.0f64;
    let mut drift = 0.0f64;
    for i in 0..50 {
        let [x, y, z] = first.state(i + 2).position;
        assert!(y.is_finite());
        sag = sag.max((y - (0.5 + i as f64)).abs());
        drift = drift.max(x.abs()).max(z.abs());
    }
    assert!(sag < 0.5 && drift < 0.06, "sag {sag}, drift {drift}");
    assert!(first.state(51).sleeping);
    for (count, sag_limit, drift_limit) in [(50, 0.45, 0.2), (60, 0.55, 0.4)] {
        let mut tower = World::new(stack(count, false));
        tower.tick(600);
        let mut sag = 0.0f64;
        let mut drift = 0.0f64;
        for i in 0..count {
            let s = tower.state(i + 2);
            let [x, y, z] = s.position;
            assert!(y.is_finite() && !s.sleeping);
            sag = sag.max((y - (0.5 + i as f64)).abs());
            drift = drift.max(x.abs()).max(z.abs());
        }
        assert!(
            sag < sag_limit && drift < drift_limit,
            "tower {count}: sag {sag}, drift {drift}"
        );
    }
}
#[test]
fn physics_scene_queries_and_shapes() {
    let mut second = box_(2, [10.0, 0.0, 0.0], [2.0; 3]);
    second.layer = 2;
    let mut trigger = box_(3, [3.0, 0.0, 0.0], [1.0; 3]);
    trigger.trigger = true;
    let mut w = World::new(vec![box_(1, [5.0, 0.0, 0.0], [2.0; 3]), second, trigger]);
    let hit = w.query(1.0, [0.0; 3], [1.0, 0.0, 0.0], 20.0, 0.5, 0.0, 65535.0);
    assert_eq!(&hit[..2], [1.0, 1.0]);
    near(hit[2], 4.0, 0.02);
    near(hit[3], -1.0, 0.02);
    near(hit[6], 4.0, 0.02);
    let skipped = w.query(1.0, [0.0; 3], [1.0, 0.0, 0.0], 20.0, 0.5, 1.0, 65535.0);
    assert_eq!(skipped[1], 2.0);
    near(skipped[2], 9.0, 0.02);
    assert_eq!(
        w.query(1.0, [0.0; 3], [1.0, 0.0, 0.0], 3.0, 0.5, 0.0, 65535.0),
        [0.0]
    );
    assert_eq!(
        w.query(1.0, [0.0; 3], [1.0, 0.0, 0.0], 20.0, 0.5, 0.0, 2.0)[1],
        2.0
    );
    let mut wedge = box_(5, [0.0; 3], [1.0; 3]);
    wedge.shape = 3.0;
    wedge.planes = vec![
        [0.0, -1.0, 0.0, 0.0],
        [1.0, 0.0, 0.0, 4.0],
        [0.0, 0.0, 1.0, 1.0],
        [0.0, 0.0, -1.0, 1.0],
        [-0.7071068, 0.7071068, 0.0, 0.0],
    ];
    let mut sphere = box_(6, [10.0, 1.0, 0.0], [1.0; 3]);
    sphere.shape = 1.0;
    sphere.radius = 1.0;
    let mut capsule = box_(7, [10.0, 1.0, 5.0], [1.0; 3]);
    capsule.shape = 2.0;
    capsule.radius = 0.5;
    capsule.height = 3.0;
    let mut w = World::new(vec![wedge, sphere, capsule]);
    let hit = w.query(
        1.0,
        [2.0, 5.0, 0.0],
        [0.0, -1.0, 0.0],
        20.0,
        0.5,
        0.0,
        65535.0,
    );
    assert_eq!(hit[1], 5.0);
    near(hit[2], 3.0, 0.02);
    near(hit[3], -0.7071, 0.01);
    near(hit[4], 0.7071, 0.01);
    for (origin, direction, id, distance) in [
        ([6.0, 1.0, 0.0], [1.0, 0.0, 0.0], 6.0, 3.0),
        ([0.0, 1.0, 5.0], [1.0, 0.0, 0.0], 7.0, 9.5),
    ] {
        let hit = w.query(1.0, origin, direction, 20.0, 0.5, 0.0, 65535.0);
        assert_eq!(hit[1], id);
        near(hit[2], distance, 0.02);
    }
    let mut wall = World::new(vec![box_(1, [8.0, 0.0, 0.0], [1.0, 4.0, 4.0])]);
    for mode in [2.0, 3.0] {
        let hit = wall.query(mode, [0.0; 3], [1.0, 0.0, 0.0], 20.0, 0.5, 0.0, 65535.0);
        assert_eq!(hit[1], 1.0);
        near(hit[2], 7.0, 0.01);
        near(hit[3], -1.0, 0.01);
    }
    let mut trigger = box_(2, [2.0, 0.0, 0.0], [1.0; 3]);
    trigger.trigger = true;
    let mut w = World::new(vec![box_(1, [4.0, 0.0, 0.0], [2.0; 3]), trigger]);
    assert_eq!(
        w.query(4.0, [2.75, 0.0, 0.0], [0.0; 3], 20.0, 0.4, 0.0, 65535.0),
        [2.0, 1.0, 2.0]
    );
    assert_eq!(
        w.query(4.0, [2.75, 0.0, 0.0], [0.0; 3], 20.0, 0.1, 0.0, 65535.0),
        [0.0]
    );
    assert_eq!(
        w.query(5.0, [4.0, 0.0, 0.0], [0.0; 3], 20.0, 0.5, 0.0, 65535.0),
        [1.0]
    );
    assert_eq!(
        w.query(5.0, [2.0, 0.0, 0.0], [0.0; 3], 20.0, 0.5, 0.0, 65535.0),
        [0.0]
    );
}
#[test]
fn physics_characters_walk_slopes_steps_walls_and_jump() {
    let mut w = World::new(vec![floor(), walker([0.0, 0.5, 0.0], Walker::default())]);
    w.advance(60, [4.0, 0.0, 0.0], false, false);
    let s = w.state(100);
    near(s.position[0], 4.0, 0.1);
    assert!(s.position[1] >= 0.0 && s.position[1] < 0.02 && s.grounded);
    assert_eq!(s.ground, 1.0);
    let mut ramp = box_(5, [0.0; 3], [1.0; 3]);
    ramp.shape = 3.0;
    ramp.planes = vec![
        [0.0, -1.0, 0.0, 0.0],
        [1.0, 0.0, 0.0, 12.0],
        [0.0, 0.0, 1.0, 3.0],
        [0.0, 0.0, -1.0, 3.0],
        [-0.5, 0.8660254, 0.0, -2.0],
    ];
    for slope in [40.0, 25.0] {
        let mut w = World::new(vec![
            floor(),
            ramp.clone(),
            walker(
                [2.0, 0.0, 0.0],
                Walker {
                    slope,
                    ..Default::default()
                },
            ),
        ]);
        w.advance(120, [3.0, 0.0, 0.0], false, false);
        let s = w.state(100);
        if slope == 40.0 {
            assert!(
                s.position[0] > 8.0 && s.position[1] > 1.0 && s.grounded,
                "{s:?}"
            );
        } else {
            assert!(s.position[0] < 5.0 && s.position[1] < 0.5, "{s:?}");
        }
    }
    for rise in [0.3, 0.7] {
        let mut w = World::new(vec![
            floor(),
            box_(2, [5.0, rise / 2.0, 0.0], [2.0, rise, 6.0]),
            walker([2.0, 0.0, 0.0], Walker::default()),
        ]);
        w.advance(120, [3.0, 0.0, 0.0], false, false);
        let s = w.state(100);
        if rise == 0.3 {
            assert!(s.position[0] > 5.5 && s.grounded, "{s:?}");
        } else {
            assert!(s.position[0] < 4.2, "{s:?}");
        }
    }
    let mut w = World::new(vec![
        floor(),
        box_(2, [5.0, 1.0, 0.0], [1.0, 2.0, 20.0]),
        walker([0.0; 3], Walker::default()),
    ]);
    w.advance(180, [3.0, 0.0, 3.0], false, false);
    let s = w.state(100);
    assert!(s.position[0] < 4.7 && s.position[2] > 6.0, "{s:?}");
    let mut w = World::new(vec![
        box_(1, [0.0, -0.75, 0.0], [100.0, 1.0, 100.0]),
        box_(2, [-5.0, -0.5, 0.0], [10.0, 1.0, 20.0]),
        walker([-4.0, 0.0, 0.0], Walker::default()),
    ]);
    for tick in 0..120 {
        w.advance(1, [4.0, 0.0, 0.0], false, false);
        assert!(w.state(100).grounded, "airborne at {tick}");
    }
    assert!(w.state(100).position[0] > 0.0);
    let mut w = World::new(vec![floor(), walker([0.0; 3], Walker::default())]);
    let mut apex = 0.0f64;
    let mut landed = false;
    for _ in 0..90 {
        w.advance(1, [0.0; 3], true, false);
        let s = w.state(100);
        apex = apex.max(s.position[1]);
        if apex > 1.0 && s.grounded {
            landed = true;
        }
    }
    near(apex, 49.0 / 40.0, 0.12);
    assert!(landed);
}
#[test]
fn physics_bodies_push_bounce_sleep_wake_and_resist_tunneling() {
    let mut platform = box_(2, [0.0, 0.5, 8.0], [4.0, 0.2, 4.0]);
    platform.body = Some(Body {
        kind: 2.0,
        velocity: [2.0, 0.0, 0.0],
        ..Default::default()
    });
    let mut w = World::new(vec![
        floor(),
        platform.clone(),
        walker([0.0, 0.6, 8.0], Walker::default()),
    ]);
    w.advance(120, [0.0; 3], false, true);
    near(w.state(100).position[0], w.state(2).position[0], 0.15);
    assert!(w.state(100).position[0] > 3.5);
    assert_eq!(w.state(100).ground, 2.0);
    let mut crate_ = box_(3, [3.0, 0.9, 8.0], [1.0; 3]);
    crate_.body = Some(Body::default());
    let mut w = World::new(vec![floor(), platform, crate_]);
    w.advance(120, [0.0; 3], false, true);
    assert!(w.state(3).position[0] > 3.5);
    let mut crate_ = box_(3, [2.0, 0.5, 0.0], [1.0; 3]);
    crate_.body = Some(Body {
        mass: 0.5,
        ..Default::default()
    });
    let mut w = World::new(vec![floor(), walker([0.0; 3], Walker::default()), crate_]);
    w.advance(120, [3.0, 0.0, 0.0], false, false);
    assert!(w.state(3).position[0] > 3.5 && w.state(100).position[0] > 3.0);
    let mut ball = box_(2, [0.0, 5.0, 0.0], [1.0; 3]);
    ball.shape = 1.0;
    ball.radius = 0.5;
    ball.restitution = 0.8;
    ball.body = Some(Body::default());
    let mut crate_ = box_(3, [4.0, 3.0, 0.0], [1.0; 3]);
    crate_.rotation = [0.2, 0.3, 0.1, 0.92];
    crate_.body = Some(Body {
        velocity: [3.0, 0.0, 1.0],
        ..Default::default()
    });
    let mut w = World::new(vec![floor(), ball, crate_]);
    let mut rebound = 0.0f64;
    let mut landed = false;
    for _ in 0..360 {
        w.tick(1);
        let ball = w.state(2);
        if ball.position[1] < 0.7 {
            landed = true;
        }
        if landed {
            rebound = rebound.max(ball.velocity[1]);
        }
    }
    assert!(rebound > 5.0);
    let s = w.state(3);
    assert!(s.sleeping);
    near(s.position[1], 0.5, 0.06);
    assert!(s.position[0] > 4.0 && s.position[2].abs() < 6.0);
    let mut fast = box_(3, [0.0, 1.0, 0.0], [1.0; 3]);
    fast.shape = 1.0;
    fast.radius = 0.2;
    fast.body = Some(Body {
        gravity: 0.0,
        velocity: [150.0, 0.0, 0.0],
        ..Default::default()
    });
    let mut w = World::new(vec![
        floor(),
        box_(2, [10.0, 2.0, 0.0], [0.1, 4.0, 8.0]),
        fast,
    ]);
    w.tick(30);
    assert!(w.state(3).position[0] < 10.0);
    let mut crate_ = box_(2, [0.0, 0.5, 0.0], [1.0; 3]);
    crate_.body = Some(Body::default());
    let mut w = World::new(vec![floor(), crate_.clone()]);
    w.tick(120);
    assert!(w.state(2).sleeping);
    crate_.position = w.state(2).position;
    crate_.body = Some(Body {
        sleeping: true,
        ..Default::default()
    });
    let mut ball = box_(3, [-4.0, 0.5, 0.0], [1.0; 3]);
    ball.shape = 1.0;
    ball.body = Some(Body {
        velocity: [10.0, 0.0, 0.0],
        ..Default::default()
    });
    let mut w = World::new(vec![floor(), crate_, ball]);
    w.tick(30);
    assert!(w.state(2).position[0] > 0.3);
    let mut f = Fixture::new("tests/physics.blot");
    let out = f.floats("primitives", [1.0, 2.0, 3.0, 4.0, -5.0, 6.0]);
    assert_eq!(&out[..6], [-1.0, -2.0, -3.0, 1.0, 2.0, 3.0]);
    near_all(&out[6..9], &[13.0 / 3.0, 10.0 / 3.0, 5.0 / 3.0], 1e-5);
    assert_eq!(&out[9..], [0.0, 0.0, 0.0, 4.0, 0.0, 6.0]);
    let mut crate_ = box_(2, [0.0, 2.0, 0.0], [1.0; 3]);
    crate_.body = Some(Body::default());
    let mut w = World::new(vec![floor(), crate_]);
    w.tick(15);
    assert!(w.state(2).position[1] < 2.0);
    w.tick(120);
    near(w.state(2).position[1], 0.5, 0.02);
    let hit = w.query(
        1.0,
        [0.0, 3.0, 0.0],
        [0.0, -1.0, 0.0],
        20.0,
        0.5,
        0.0,
        65535.0,
    );
    assert_eq!(hit[1], 2.0);
    near(hit[2], 2.0, 0.02);
}
