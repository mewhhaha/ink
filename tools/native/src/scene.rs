use crate::*;
#[derive(Clone)]
struct Source {
    id: f64,
    shape: f64,
    p: [f64; 3],
    q: [f64; 4],
    scale: [f64; 3],
    size: [f64; 3],
    radius: f64,
    height: f64,
    layer: f64,
    trigger: bool,
    body: f64,
}
impl Source {
    fn new(id: f64, shape: f64, p: [f64; 3]) -> Self {
        Self {
            id,
            shape,
            p,
            q: [0., 0., 0., 1.],
            scale: [1.; 3],
            size: [1.; 3],
            radius: 0.5,
            height: 2.,
            layer: 1.,
            trigger: false,
            body: 0.,
        }
    }
    fn lanes(&self) -> Vec<f64> {
        [
            vec![self.id, self.shape],
            self.p.to_vec(),
            self.q.to_vec(),
            self.scale.to_vec(),
            self.size.to_vec(),
            vec![
                self.radius,
                self.height,
                self.layer,
                self.trigger as u8 as f64,
                self.body,
            ],
        ]
        .concat()
    }
}
#[derive(Clone)]
struct Query {
    mode: f64,
    a: [f64; 3],
    b: [f64; 3],
    r: f64,
    d: [f64; 3],
    mask: f64,
    skip: f64,
    triggers: bool,
    walkers: bool,
    dynamics: bool,
}
impl Query {
    fn new(mode: usize, a: [f64; 3]) -> Self {
        Self {
            mode: mode as f64,
            a,
            b: a,
            r: 0.,
            d: [0.; 3],
            mask: 7.,
            skip: 0.,
            triggers: false,
            walkers: true,
            dynamics: true,
        }
    }
    fn lanes(&self) -> Vec<f64> {
        [
            vec![
                self.mode,
                self.mask,
                self.skip,
                self.triggers as u8 as f64,
                self.walkers as u8 as f64,
                self.dynamics as u8 as f64,
            ],
            self.a.to_vec(),
            self.b.to_vec(),
            vec![self.r],
            self.d.to_vec(),
        ]
        .concat()
    }
}
fn parts(v: Vec<f64>) -> Vec<Vec<f64>> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < v.len() {
        let n = v[i] as usize;
        i += 1;
        out.push(v[i..i + n].to_vec());
        i += n;
    }
    assert_eq!(i, v.len());
    out
}
fn probe(f: &mut Fixture, s: &[Source], q: Query) -> Vec<f64> {
    let r = parts(
        f.floats(
            "probe",
            [
                vec![s.len() as f64],
                q.lanes(),
                s.iter().flat_map(Source::lanes).collect(),
            ]
            .concat(),
        ),
    );
    assert_eq!(r.len(), 2);
    near_all(&r[0], &r[1], 2e-5);
    r[0].clone()
}
fn update(
    f: &mut Fixture,
    b: &[Source],
    a: &[Source],
    dirty: &[usize],
    q: Query,
) -> (Vec<f64>, Vec<f64>) {
    let r = parts(
        f.floats(
            "update",
            [
                vec![b.len() as f64, a.len() as f64, dirty.len() as f64],
                q.lanes(),
                b.iter().flat_map(Source::lanes).collect(),
                a.iter().flat_map(Source::lanes).collect(),
                dirty.iter().map(|x| *x as f64).collect(),
            ]
            .concat(),
        ),
    );
    assert_eq!(r.len(), 6);
    for (a, b) in [(1, 2), (1, 3), (0, 4), (4, 5)] {
        near_all(&r[a], &r[b], 2e-5)
    }
    (r[0].clone(), r[1].clone())
}
fn distributed(seed: u32, count: usize) -> Vec<Source> {
    let mut r = Random(seed);
    (0..count)
        .map(|i| {
            let angle = (r.unit() - 0.5) * std::f64::consts::PI;
            Source {
                id: (count * 3 - i * 2) as f64,
                shape: (i % 3 + 1) as f64,
                p: [
                    (r.unit() - 0.5) * 40.,
                    (r.unit() - 0.5) * 12.,
                    (r.unit() - 0.5) * 40.,
                ],
                q: [0., (angle / 2.).sin(), 0., (angle / 2.).cos()],
                scale: std::array::from_fn(|_| 0.5 + r.unit()),
                size: std::array::from_fn(|_| 0.5 + r.unit() * 3.),
                radius: 0.25 + r.unit(),
                height: 1. + r.unit() * 3.,
                layer: (1u32 << (i % 3)) as f64,
                trigger: i % 5 == 0,
                body: (i % 4) as f64,
            }
        })
        .collect()
}
#[test]
fn indexed_scene_queries_match_exhaustive_seeded_geometry() {
    let mut f = Fixture::new("tests/scene.blot");
    for seed in [7, 19283, 0x12345678] {
        let s = distributed(seed, 54);
        let mut r = Random(seed + 1);
        for i in 0..36 {
            let t = s[i].p;
            let a = [t[0] - 5. - r.unit() * 5., t[1] + r.unit(), t[2]];
            let d = [12. + r.unit() * 5., -r.unit() * 2., r.unit() - 0.5];
            let mut q = Query::new(0, a);
            q.d = d;
            q.mask = (i % 7 + 1) as f64;
            q.skip = s[(i + 7) % s.len()].id;
            probe(&mut f, &s, q.clone());
            q.mode = 1.;
            q.skip = 0.;
            q.b = [a[0], a[1] + 1.5, a[2]];
            q.r = 0.3;
            q.triggers = i % 2 == 0;
            q.walkers = i % 3 != 0;
            q.dynamics = i % 4 != 0;
            probe(&mut f, &s, q);
            let mut q = Query::new(2, t);
            q.r = 0.75 + r.unit() * 2.;
            q.mask = (i % 7 + 1) as f64;
            probe(&mut f, &s, q.clone());
            q.mode = 3.;
            q.b = [t[0] + 2., t[1] + 3., t[2] - 1.];
            q.r = 0.4;
            probe(&mut f, &s, q.clone());
            q.mode = 4.;
            q.b = t;
            q.r = 0.;
            probe(&mut f, &s, q);
        }
    }
}
#[test]
fn scene_degenerate_axes_order_ties_empty_and_filtering() {
    let mut f = Fixture::new("tests/scene.blot");
    let mut s = vec![Source::new(800., 0., [0.; 3])];
    for id in [90., 10., 30.] {
        let mut v = Source::new(id, 2., [0.; 3]);
        v.radius = 1.;
        v.trigger = id == 30.;
        s.push(v);
    }
    for mode in [2, 3] {
        let mut q = Query::new(mode, [0.; 3]);
        q.b = [0., 2., 0.];
        q.r = 0.1;
        assert_eq!(probe(&mut f, &s, q), vec![90., 10., 30.]);
    }
    let mut q = Query::new(0, [-3., 0., 0.]);
    q.d = [6., 0., 0.];
    assert_eq!(&probe(&mut f, &s, q.clone())[..3], &[1., 90., 0.]);
    q.skip = 90.;
    assert_eq!(probe(&mut f, &s, q)[1], 10.);
    for axis in 0..3 {
        let s = (0..40)
            .map(|i| {
                let mut p = [0.; 3];
                p[axis] = (i as f64 - 20.) * 2.;
                Source::new((100 - i) as f64, 2., p)
            })
            .collect::<Vec<_>>();
        let mut a = [0.; 3];
        a[axis] = -50.;
        let mut q = Query::new(0, a);
        q.d[axis] = 100.;
        probe(&mut f, &s, q.clone());
        q.mode = 1.;
        q.r = 0.4;
        probe(&mut f, &s, q);
        let mut q = Query::new(2, [0.; 3]);
        q.r = 4.;
        probe(&mut f, &s, q);
        let mut q = Query::new(3, [-1.; 3]);
        q.b = [1.; 3];
        q.r = 1.;
        probe(&mut f, &s, q);
        probe(&mut f, &s, Query::new(4, [0.; 3]));
    }
    for mode in 0..5 {
        let mut q = Query::new(mode, [0.; 3]);
        q.r = 1.;
        probe(&mut f, &[], q);
    }
    let mut a = Source::new(1., 2., [0.; 3]);
    a.trigger = true;
    let mut b = Source::new(2., 3., [2., 0., 0.]);
    b.layer = 2.;
    b.body = 3.;
    let mut c = Source::new(3., 1., [4., 0., 0.]);
    c.layer = 4.;
    c.body = 1.;
    let s = [a, b, c];
    assert_eq!(probe(&mut f, &s, Query::new(4, [0.; 3])), vec![0.]);
    let mut q = Query::new(2, [0.; 3]);
    q.r = 0.1;
    assert_eq!(probe(&mut f, &s, q.clone()), vec![1.]);
    q.mode = 1.;
    assert_eq!(probe(&mut f, &s, q.clone()), vec![0.]);
    q.triggers = true;
    assert_eq!(probe(&mut f, &s, q)[1], 1.);
    let mut q = Query::new(1, [-2., 0., 0.]);
    q.d = [8., 0., 0.];
    q.walkers = false;
    q.dynamics = false;
    assert_eq!(probe(&mut f, &s, q.clone()), vec![0.]);
    q.mode = 0.;
    q.mask = 0.;
    assert_eq!(probe(&mut f, &s, q), vec![0.]);
    assert_eq!(probe(&mut f, &s, Query::new(0, [4., 0., 0.]))[1], 3.);
}
#[test]
fn updates_move_rotate_mutate_shapes_and_preserve_old_snapshots() {
    let mut f = Fixture::new("tests/scene.blot");
    let mut a = Source::new(4., 1., [0.; 3]);
    a.size = [6., 0.5, 0.5];
    a.body = 2.;
    let mut b = Source::new(8., 2., [20., 0., 0.]);
    b.radius = 1.;
    b.body = 1.;
    let before = vec![a, b];
    let mut after = before.clone();
    after[0].p = [10., 0., 0.];
    after[0].q = [
        0.,
        0.,
        std::f64::consts::FRAC_1_SQRT_2,
        std::f64::consts::FRAC_1_SQRT_2,
    ];
    after[1].p = [10., 4., 0.];
    after[1].scale = [2., 1., 1.];
    assert_eq!(
        update(
            &mut f,
            &before,
            &after,
            &[0, 1],
            Query::new(4, [10., 2., 0.])
        ),
        (vec![0.], vec![1.])
    );
    let mut q = Query::new(2, [0.; 3]);
    q.r = 0.1;
    assert_eq!(
        update(&mut f, &before, &after, &[0, 1], q),
        (vec![4.], vec![])
    );
    for mode in 0..5 {
        let mut q = Query::new(mode, [6., 2., 0.]);
        q.b = [6., 3., 0.];
        q.d = [10., 0., 0.];
        q.r = 0.3;
        update(&mut f, &before, &after, &[0, 1], q);
    }
    let a = Source::new(7., 1., [0.; 3]);
    let mut b = Source::new(2., 2., [4., 0., 0.]);
    b.trigger = true;
    let before = vec![a, b];
    let mut after = before.clone();
    after[0].shape = 3.;
    after[0].radius = 1.;
    after[0].height = 6.;
    after[0].layer = 2.;
    after[0].trigger = true;
    after[1].radius = 2.;
    after[1].layer = 4.;
    after[1].trigger = false;
    let mut q = Query::new(2, [0., 2., 0.]);
    q.r = 0.1;
    q.mask = 2.;
    assert_eq!(update(&mut f, &before, &after, &[0, 1], q).1, vec![7.]);
    assert_eq!(
        update(&mut f, &before, &after, &[0, 1], Query::new(4, [0.; 3])),
        (vec![1.], vec![0.])
    );
    let mut q = Query::new(4, [4., 0., 0.]);
    q.mask = 4.;
    assert_eq!(
        update(&mut f, &before, &after, &[0, 1], q),
        (vec![0.], vec![1.])
    );
    for mode in 0..5 {
        let mut q = Query::new(mode, [-4., 0., 0.]);
        q.b = [-4., 2., 0.];
        q.d = [12., 0., 0.];
        q.r = 1.;
        q.triggers = true;
        update(&mut f, &before, &after, &[0, 1], q);
    }
}
#[test]
fn scene_insert_remove_reorder_and_partition_refits() {
    let mut f = Fixture::new("tests/scene.blot");
    let sphere = |id| {
        let mut v = Source::new(id, 2., [0.; 3]);
        v.radius = 1.;
        v
    };
    let before = vec![sphere(90.), Source::new(20., 0., [0.; 3]), sphere(10.)];
    let mut after = before.clone();
    after[0].shape = 0.;
    after[1].shape = 1.;
    let mut q = Query::new(2, [0.; 3]);
    q.r = 0.1;
    assert_eq!(
        update(&mut f, &before, &after, &[0, 1], q.clone()),
        (vec![90., 10.], vec![20., 10.])
    );
    for mode in 0..5 {
        let mut q = Query::new(mode, [-3., 0., 0.]);
        q.b = [-3., 1., 0.];
        q.d = [6., 0., 0.];
        q.r = 0.2;
        update(&mut f, &before, &after, &[0, 1], q);
    }
    let before = vec![sphere(90.), sphere(10.)];
    let mut after = before.clone();
    after.push(Source::new(5., 3., [0.; 3]));
    assert_eq!(
        update(&mut f, &before, &after, &[], q.clone()).1,
        vec![90., 10., 5.]
    );
    assert_eq!(
        update(&mut f, &before, &before[1..], &[], q.clone()).1,
        vec![10.]
    );
    assert!(update(&mut f, &before, &[], &[], q.clone()).1.is_empty());
    let after = vec![before[1].clone(), before[0].clone()];
    assert_eq!(
        update(&mut f, &before, &after, &[0, 1], q).1,
        vec![10., 90.]
    );
    let mut q = Query::new(0, [-3., 0., 0.]);
    q.d = [6., 0., 0.];
    let r = update(&mut f, &before, &after, &[0, 1], q);
    assert_eq!((r.0[1], r.1[1]), (90., 10.));
    let s = distributed(19, 32);
    for mode in 0..5 {
        let mut q = Query::new(mode, s[0].p);
        q.b = [1., 2., 3.];
        q.d = [30., 0., 0.];
        q.r = 2.;
        update(&mut f, &s, &s, &[], q);
    }
    let before = distributed(8173, 54);
    let mut after = before.clone();
    let dirty = [0, 3, 8, 14, 20, 27, 31, 38, 46, 53];
    for i in dirty {
        let p = before[i].p;
        after[i].p = [50. - p[0], p[1] + 12., -40. - p[2]];
        after[i].q = [
            0.,
            0.,
            std::f64::consts::FRAC_1_SQRT_2,
            std::f64::consts::FRAC_1_SQRT_2,
        ];
        after[i].size = [2., 6., 1.];
        after[i].layer = 7.;
        after[i].trigger = false;
    }
    for i in dirty {
        let p = after[i].p;
        for mode in 0..5 {
            let mut q = Query::new(mode, p);
            q.b = [p[0], p[1] + 2., p[2]];
            q.d = [8., 0., 0.];
            q.r = 0.2;
            q.triggers = true;
            update(&mut f, &before, &after, &dirty, q);
        }
        let mut q = Query::new(2, p);
        q.r = 0.2;
        let r = update(&mut f, &before, &after, &dirty, q);
        assert!(r.1.contains(&after[i].id));
        assert!(r.0.is_empty());
    }
}
