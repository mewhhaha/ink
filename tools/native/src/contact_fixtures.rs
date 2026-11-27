use super::*;
#[derive(Default)]
struct Field {
    origin: [f64; 3],
    size: Option<f64>,
    cells: Option<usize>,
    grid: Option<Vec<f64>>,
    amplitude: f64,
    wavelength: Option<f64>,
    octaves: u32,
}
fn lanes(field: &Field, p: [f64; 3], q: Option<[f64; 3]>, radius: f64, kind: f64) -> Vec<f64> {
    let q = q.unwrap_or(p);
    [
        field.origin.to_vec(),
        vec![
            field.size.unwrap_or(8.0),
            field.cells.unwrap_or(1) as f64,
            field.amplitude,
            field.wavelength.unwrap_or(4.0),
            field.octaves as f64,
            7.0,
        ],
        p.to_vec(),
        q.to_vec(),
        vec![radius, kind],
        field.grid.clone().unwrap_or(vec![0.0; 4]),
    ]
    .concat()
}
#[test]
fn heightfield_gaps_contacts_walls_and_features() {
    let mut f = Fixture::new("tests/heightfield.sq");
    let field = Field {
        origin: [10.0, 3.0, -5.0],
        grid: Some(vec![1.0; 4]),
        ..Default::default()
    };
    let above = f.floats("gap", lanes(&field, [10.0, 5.0, -5.0], None, 0.0, 0.0));
    near(above[0], 1.0, 1e-5);
    assert_eq!(&above[1..4], [0.0, 1.0, 0.0]);
    assert_eq!(&above[7..], [6.0, -9.0, 14.0, 4.0, -1.0]);
    near(
        f.floats("gap", lanes(&field, [10.0, 3.8, -5.0], None, 0.0, 0.0))[0],
        -0.2,
        1e-5,
    );
    let outside = f.floats("gap", lanes(&field, [15.0, 0.0, -5.0], None, 0.0, 0.0));
    near(outside[0], 1.0, 1e-5);
    assert_eq!(&outside[1..4], [1.0, 0.0, 0.0]);
    let slope = Field {
        origin: [3.0, 2.0, -7.0],
        grid: Some(vec![-2.0, 2.0, -2.0, 2.0]),
        ..Default::default()
    };
    let gap = f.floats("gap", lanes(&slope, [3.0, 3.0, -7.0], None, 0.0, 0.0));
    near(gap[0], 1.0 / 1.25f64.sqrt(), 2e-4);
    near(gap[1], -0.5 / 1.25f64.sqrt(), 2e-4);
    near(gap[2], 1.0 / 1.25f64.sqrt(), 2e-4);
    let result = f.floats("contacts", lanes(&slope, [3.0, 2.55, -7.0], None, 0.5, 0.0));
    assert_eq!(result[0], 1.0);
    near(result[7], 0.55 / 1.25f64.sqrt() - 0.5, 2e-4);
    let empty = Field::default();
    for (p, q, radius, kind, minimum, normal, depth) in [
        (
            [-1.0, 0.49, 0.0],
            [1.0, 0.49, 0.0],
            0.5,
            2.0,
            2,
            [0.0, 1.0, 0.0],
            -0.01,
        ),
        (
            [0.0, 0.49, 0.0],
            [1.0, 0.5, 1.0],
            0.0,
            1.0,
            4,
            [0.0, 1.0, 0.0],
            -0.01,
        ),
        (
            [4.4, -2.0, 0.0],
            [0.5; 3],
            0.0,
            1.0,
            4,
            [1.0, 0.0, 0.0],
            -0.1,
        ),
    ] {
        let result = f.floats("contacts", lanes(&empty, p, Some(q), radius, kind));
        if kind == 2.0 {
            assert!(result[0] >= minimum as f64);
        } else {
            assert_eq!(result[0], minimum as f64);
        }
        for i in 0..result[0] as usize {
            let o = 1 + i * 7;
            assert_eq!(&result[o + 3..o + 6], normal);
            near(result[o + 6], depth, 1e-5);
        }
    }
    let tilted = f.floats(
        "contacts",
        lanes(
            &empty,
            [0.0, 0.6, 0.0],
            Some([0.5; 3]),
            std::f64::consts::FRAC_PI_4,
            1.0,
        ),
    );
    assert!(tilted[0] >= 2.0 && tilted[7] < -0.1);
    let valley = Field {
        cells: Some(2),
        grid: Some(vec![4.0, 4.0, 4.0, 4.0, 0.0, 4.0, 4.0, 4.0, 4.0]),
        ..Default::default()
    };
    assert!(f.floats("gap", lanes(&valley, [0.0, 0.01, 0.0], None, 0.0, 0.0))[0] >= 0.0);
    let peak = Field {
        cells: Some(2),
        size: Some(4.0),
        grid: Some(vec![0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0]),
        ..Default::default()
    };
    let result = f.floats(
        "contacts",
        lanes(&peak, [0.0, 1.4, 0.0], Some([1.0, 0.5, 1.0]), 0.0, 1.0),
    );
    assert!(result[0] > 0.0 && result[7] < -0.09);
}
#[test]
fn heightfield_scene_masks_sweeps_settling_and_walking() {
    let mut f = Fixture::new("tests/heightfield.sq");
    let field = Field {
        origin: [10.0, 3.0, -5.0],
        grid: Some(vec![-2.0, 2.0, -2.0, 2.0]),
        ..Default::default()
    };
    let mut a = lanes(
        &field,
        [10.0, 8.0, -5.0],
        Some([0.0, -10.0, 0.0]),
        -1.0,
        4.0,
    );
    let ray = f.floats("query", a.clone());
    assert_eq!(ray[0], 1.0);
    near(ray[1], 0.5, 2e-4);
    near(ray[3], 3.0, 2e-3);
    near(ray[5], -0.5 / 1.25f64.sqrt(), 2e-3);
    a[16] = 1.0;
    assert_eq!(f.floats("query", a.clone()), [0.0]);
    a[16] = 4.0;
    a[9] = 15.0;
    assert_eq!(f.floats("query", a.clone()), [0.0]);
    a[9] = 10.0;
    a[15] = 0.5;
    let sweep = f.floats("query", a);
    assert_eq!(sweep[0], 1.0);
    near(sweep[1], (5.0 - 0.5 * 1.25f64.sqrt()) / 10.0, 2e-3);
    assert_eq!(
        f.floats("solid", lanes(&field, [10.0, 2.0, -5.0], None, 0.1, 0.0)),
        [1.0, 1.0]
    );
    assert_eq!(
        f.floats("solid", lanes(&field, [15.0, 0.0, -5.0], None, 0.1, 0.0)),
        [0.0, 0.0]
    );
    let noisy = Field {
        cells: Some(2),
        grid: Some(vec![0.0, 2.0, -1.0, 1.0, -2.0, 3.0, 2.0, 0.0, 1.0]),
        amplitude: 0.35,
        octaves: 2,
        ..Default::default()
    };
    let ray = f.floats(
        "query",
        lanes(&noisy, [0.6, 4.0, -0.8], Some([0.0, -8.0, 0.0]), -1.0, 4.0),
    );
    assert_eq!(ray[0], 1.0);
    let height = f.number(
        "height",
        lanes(&noisy, [ray[2], ray[3], ray[4]], None, 0.0, 0.0),
    );
    near(ray[3], height, 0.002);
    let uphill = Field {
        cells: Some(2),
        grid: Some(vec![0.0, 3.0, 0.0, 0.0, 3.0, 0.0, 0.0, 3.0, 0.0]),
        ..Default::default()
    };
    let ray = f.floats(
        "query",
        lanes(&uphill, [-3.0, 1.5, 0.0], Some([6.0, 0.0, 0.0]), -1.0, 4.0),
    );
    assert_eq!(ray[0], 1.0);
    near(ray[2], -2.0, 0.003);
    near(ray[3], 1.5, 0.003);
    let field = Field {
        origin: [10.0, 3.0, -5.0],
        grid: Some(vec![1.0; 4]),
        ..Default::default()
    };
    let sphere = f.floats("fall", lanes(&field, [10.0, 6.0, -5.0], None, 0.5, 0.0));
    near(sphere[1], 4.5, 0.03);
    assert!(sphere[3].abs() < 0.1);
    let box_ = f.floats(
        "fall",
        lanes(&field, [10.0, 6.0, -5.0], Some([1.0; 3]), 0.0, 1.0),
    );
    near(box_[1], 4.5, 0.04);
    assert!(box_[3].abs() < 0.1 && box_[4] < 0.2);
    let slope = Field {
        size: Some(16.0),
        grid: Some(vec![-2.4, 2.4, -2.4, 2.4]),
        ..Default::default()
    };
    for speed in [-2.0, 2.0] {
        let result = f.floats("walk", lanes(&slope, [0.0, 0.05, 0.0], None, speed, 0.0));
        assert!(result[0].abs() > 2.5);
        assert_eq!(result[3], 1.0);
        assert_eq!(result[4], 0.0);
        near(result[1], result[0] * 0.3 + 0.018, 0.025);
        near(result[5], -0.3 / 1.09f64.sqrt(), 0.003);
    }
}
fn initial(mode: f64, x: f64, y: f64, anchor: f64, speed: f64) -> Vec<f64> {
    let mut s = vec![0.0; 22];
    s[0] = mode;
    s[1] = 1.0 / 60.0;
    s[2] = speed;
    s[4] = anchor;
    s[9] = x;
    s[10] = y;
    s[15] = 1.0;
    s
}
fn distance(s: &[f64]) -> f64 {
    ((s[9] - s[3]).powi(2) + (s[10] - s[4]).powi(2) + (s[11] - s[5]).powi(2)).sqrt()
}
#[test]
fn joint_pendulum_spring_hinge_and_contact_stability() {
    let mut f = Fixture::new("tests/joints.sq");
    let mut s = initial(0.0, 1.0, 2.0, 2.0, 0.0);
    let (mut drift, mut max_energy) = (0.0f64, 0.0f64);
    for _ in 0..3600 {
        s = f.floats("tick", s);
        assert!(s.iter().all(|x| x.is_finite()));
        drift = drift.max((distance(&s) - 1.0).abs());
        let kinetic = s[16..19].iter().map(|x| x * x).sum::<f64>() / 2.0;
        max_energy = max_energy.max(kinetic + 9.81 * (s[10] - 1.0));
    }
    assert!(
        drift < 0.015 && max_energy < 11.0,
        "drift {drift}, energy {max_energy}"
    );
    let mut s = initial(1.0, 2.0, 0.0, 0.0, 0.0);
    for _ in 0..360 {
        s = f.floats("tick", s);
    }
    near(distance(&s), 1.0, 0.002);
    assert!(s[16..19].iter().map(|x| x * x).sum::<f64>().sqrt() < 0.01);
    for speed in [-3.0, 3.0] {
        let mut s = initial(2.0, 1.0, 0.0, 0.0, speed);
        s[12] = 0.15f64.sin();
        s[15] = 0.15f64.cos();
        let mut pivot = 0.0f64;
        for _ in 0..600 {
            s = f.floats("tick", s);
            let (qx, qy, qz, qw) = (s[12], s[13], s[14], s[15]);
            let a = [
                s[9] - (1.0 - 2.0 * (qy * qy + qz * qz)),
                s[10] - 2.0 * (qx * qy + qw * qz),
                s[11] - 2.0 * (qx * qz - qw * qy),
            ];
            pivot = pivot.max(a.iter().map(|x| x * x).sum::<f64>().sqrt());
            assert!(s.iter().all(|x| x.is_finite()));
        }
        assert!(pivot < 0.03);
        near(s[21], speed, 0.05);
        assert!(1.0 - 2.0 * (s[12] * s[12] + s[13] * s[13]) > 0.999);
    }
    let mut s = initial(2.0, 1.0, 0.0, 0.0, 0.0);
    s[12] = 1.0;
    s[15] = 0.0;
    for _ in 0..600 {
        s = f.floats("tick", s);
    }
    assert!(s.iter().all(|x| x.is_finite()));
    assert!(1.0 - 2.0 * (s[12] * s[12] + s[13] * s[13]) > 0.999);
    let mut s = initial(3.0, 1.0, 0.0, 0.0, 0.0);
    s[6] = 0.5;
    for frame in 0..180 {
        s[3] = (frame + 1) as f64 / 120.0;
        s = f.floats("tick", s);
    }
    near(distance(&s), 1.0, 0.02);
    near(s[16], 0.5, 0.02);
    let mut s = initial(4.0, 1.0, 1.1, 1.1, 0.0);
    for _ in 0..900 {
        s = f.floats("tick", s);
    }
    assert!(s[10] >= 0.28 && s.len() > 22 && s.iter().all(|x| x.is_finite()));
    near(distance(&s), 1.0, 0.03);
    assert!(f.floats("tick", initial(6.0, 1.0, 2.0, 2.0, 0.0))[17] < 0.0);
    assert_eq!(f.number("validity", [1.0, 40.0, 8.0, 3.0, 5.0]), 1.0);
    for i in 0..5 {
        for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let mut a = [1.0, 40.0, 8.0, 3.0, 5.0];
            a[i] = invalid;
            assert_eq!(f.number("validity", a), 0.0);
        }
    }
    assert_eq!(f.number("validity", [-1.0, 40.0, 8.0, 3.0, 5.0]), 0.0);
    let start = std::time::Instant::now();
    near(f.number("thousand", 1000), 3000.0, 0.1);
    assert!(start.elapsed() < Duration::from_secs(1));
}
#[test]
fn tiles_floor_walls_heads_one_way_ladders_and_hazards() {
    let mut f = Fixture::new("tests/tiles.sq");
    let mut cells = vec![0.0; 40];
    cells[..8].fill(1.0);
    for (x, y, v) in [
        (6, 1, 1.0),
        (6, 2, 1.0),
        (2, 2, 2.0),
        (3, 2, 2.0),
        (4, 1, 3.0),
        (4, 2, 3.0),
        (4, 3, 3.0),
        (1, 1, 4.0),
        (0, 4, 1.0),
    ] {
        cells[y * 8 + x] = v;
    }
    let mut slide = |p: [f64; 4], drop: bool, half: [f64; 2]| {
        f.floats(
            "probe",
            [
                p.to_vec(),
                vec![u32::from(drop) as f64, 1.0 / 60.0],
                half.to_vec(),
                cells.clone(),
            ]
            .concat(),
        )
    };
    let half = [0.4, 0.5];
    let r = slide([3.5, 1.52, 0.0, -10.0], false, half);
    assert_eq!(r[4], 1.0);
    near(r[1], 1.5, 0.002);
    assert_eq!(r[3], 0.0);
    let r = slide([5.55, 1.5, 6.0, 0.0], false, half);
    assert_eq!(r[5], 1.0);
    assert_eq!(r[2], 0.0);
    assert!(r[0] + 0.4 <= 6.0);
    let r = slide([7.45, 1.5, -6.0, 0.0], false, half);
    assert_eq!(r[5], -1.0);
    assert!(r[0] - 0.4 >= 7.0 - 1e-3);
    assert_eq!(slide([3.0, 1.5, 3.0, 0.0], false, half)[5], 0.0);
    let r = slide([0.5, 3.45, 0.0, 8.0], false, half);
    assert_eq!(r[6], 1.0);
    assert_eq!(r[3], 0.0);
    assert!(r[1] + 0.5 <= 4.0 + 1e-3);
    let r = slide([2.5, 3.52, 0.0, -8.0], false, half);
    assert_eq!(r[4], 1.0);
    near(r[1], 3.5, 0.002);
    let r = slide([2.5, 2.2, 0.0, 12.0], false, half);
    assert_eq!(r[6], 0.0);
    assert!(r[1] > 2.2);
    assert_eq!(slide([2.5, 3.5, 0.0, -2.0], true, half)[4], 0.0);
    assert_eq!(slide([4.5, 2.5, 0.0, 0.0], false, half)[7], 1.0);
    assert_eq!(slide([5.5, 2.5, 0.0, 0.0], false, half)[7], 0.0);
    assert_eq!(slide([1.5, 1.5, 0.0, 0.0], false, [0.3, 0.3])[8], 1.0);
    assert_eq!(slide([2.5, 2.5, 0.0, 0.0], false, half)[9], 2.0);
    assert_eq!(slide([-3.0, 2.5, 0.0, 0.0], false, half)[9], 0.0);
}
