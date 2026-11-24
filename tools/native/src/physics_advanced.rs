//! Independent f64 references for compound rigid-body inertia, vehicle
//! Ackermann/Pacejka curves, and spherical-cap Archimedes buoyancy.
use super::*;

type V = [f64; 3];
type Q = [f64; 4];

const FIXTURE: &str = "tests/physics_advanced_reference.blot";

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
fn add(a: V, b: V) -> V {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn sub(a: V, b: V) -> V {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn mul(a: V, s: f64) -> V {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn len(a: V) -> f64 {
    dot(a, a).sqrt()
}
fn rot_vec(q: Q, v: V) -> V {
    let u = [q[0], q[1], q[2]];
    let t = mul(cross(u, v), 2.0);
    add(add(v, mul(t, q[3])), cross(u, t))
}
fn rand_dir(r: &mut Random) -> V {
    let z = r.unit() * 2.0 - 1.0;
    let a = r.unit() * std::f64::consts::TAU;
    let s = (1.0 - z * z).sqrt();
    [s * a.cos(), z, s * a.sin()]
}
fn rand_quat(r: &mut Random) -> Q {
    let axis = rand_dir(r);
    let half = (r.unit() * 5.0 - 2.5) * 0.5;
    let s = half.sin();
    [axis[0] * s, axis[1] * s, axis[2] * s, half.cos()]
}
fn rand_vec(r: &mut Random, scale: f64) -> V {
    [
        (r.unit() * 2.0 - 1.0) * scale,
        (r.unit() * 2.0 - 1.0) * scale,
        (r.unit() * 2.0 - 1.0) * scale,
    ]
}

#[test]
fn compound_inertia_matches_f64_parallel_axis_theorem() {
    let mut f = Fixture::new(FIXTURE);
    let mut r = Random(0xC0490);
    for _ in 0..80 {
        let half = [0.2 + r.unit(), 0.2 + r.unit(), 0.2 + r.unit()];
        let bp = rand_vec(&mut r, 2.0);
        let bq = rand_quat(&mut r);
        let bm = 0.5 + r.unit() * 5.0;
        let sr = 0.2 + r.unit() * 1.2;
        let sp = rand_vec(&mut r, 2.0);
        let sm = 0.5 + r.unit() * 5.0;
        let args: Vec<f64> = [&half[..], &bp, &bq, &[bm, sr], &sp, &[sm]].concat();
        let got = f.floats("compound_two", args);
        assert_eq!(got[0], 1.0);

        let total_m = bm + sm;
        let com = mul(add(mul(bp, bm), mul(sp, sm)), 1.0 / total_m);
        let bdiag = [
            bm / 3.0 * (half[1] * half[1] + half[2] * half[2]),
            bm / 3.0 * (half[0] * half[0] + half[2] * half[2]),
            bm / 3.0 * (half[0] * half[0] + half[1] * half[1]),
        ];
        let sdiag = 0.4 * sm * sr * sr;
        let c0 = rot_vec(bq, [1.0, 0.0, 0.0]);
        let c1 = rot_vec(bq, [0.0, 1.0, 0.0]);
        let c2 = rot_vec(bq, [0.0, 0.0, 1.0]);
        let r_mat = [c0, c1, c2];
        let mut tensor = [[0.0f64; 3]; 3];
        for row in 0..3 {
            for col in 0..3 {
                tensor[row][col] = (0..3)
                    .map(|k| bdiag[k] * r_mat[k][row] * r_mat[k][col])
                    .sum();
            }
        }
        for i in 0..3 {
            tensor[i][i] += sdiag;
        }
        for (pos, m) in [(bp, bm), (sp, sm)] {
            let d = sub(pos, com);
            let d2 = dot(d, d);
            for row in 0..3 {
                for col in 0..3 {
                    let kron = if row == col { 1.0 } else { 0.0 };
                    tensor[row][col] += m * (d2 * kron - d[row] * d[col]);
                }
            }
        }
        let rad = (len(sub(bp, com)) + len(half)).max(len(sub(sp, com)) + sr);
        near(got[1], total_m, 2e-4);
        near_all(&got[2..5], &com, 2e-4);
        near_all(
            &got[5..11],
            &[
                tensor[0][0],
                tensor[1][1],
                tensor[2][2],
                tensor[0][1],
                tensor[0][2],
                tensor[1][2],
            ],
            2e-3,
        );
        near(got[11], rad, 2e-4);
    }
}

#[test]
fn vehicle_ackermann_and_pacejka_match_f64_formulas() {
    let mut f = Fixture::new(FIXTURE);
    let mut r = Random(0xCA25);
    for _ in 0..80 {
        let wb = 1.5 + r.unit() * 2.5;
        let tr = 0.8 + r.unit() * 1.4;
        let steer = (r.unit() * 2.0 - 1.0) * 0.7;
        let slip = (r.unit() * 2.0 - 1.0) * 0.8;
        let (b, c, d, e) = (10.0, 1.9, 1.1, 0.97);
        let got = f.floats("vehicle_curves", [wb, tr, steer, slip, b, c, d, e]);
        let (exp_l, exp_r) = if steer.abs() < 1e-4 {
            (0.0, 0.0)
        } else {
            let turn_r = wb / steer.abs().tan();
            let inner = wb.atan2((turn_r - tr * 0.5).max(1e-3));
            let outer = wb.atan2(turn_r + tr * 0.5);
            if steer > 0.0 {
                (inner, outer)
            } else {
                (-outer, -inner)
            }
        };
        let bx = b * slip;
        let exp_p = d * (c * (bx - e * (bx - bx.atan())).atan()).sin();
        near_all(&got, &[exp_l, exp_r, exp_p], 2e-4);
    }
}

#[test]
fn spherical_cap_buoyancy_matches_f64_reference() {
    let mut f = Fixture::new(FIXTURE);
    let mut r = Random(0xB0A7);
    for _ in 0..80 {
        let y = (r.unit() * 2.0 - 1.0) * 3.0;
        let radius = 0.2 + r.unit() * 1.5;
        let wh = (r.unit() * 2.0 - 1.0) * 1.5;
        let vol = 0.5 + r.unit() * 4.0;
        let rho = 800.0 + r.unit() * 400.0;
        let g = 9.81;
        let vy = (r.unit() * 2.0 - 1.0) * 5.0;
        let ld = r.unit() * 50.0;
        let qd = r.unit() * 20.0;
        let got = f.floats("buoyancy_single", [y, radius, wh, vol, rho, g, vy, ld, qd]);
        assert_eq!(got[0], 1.0);
        let h = (wh - (y - radius)).clamp(0.0, 2.0 * radius);
        let frac = (h * h * (3.0 * radius - h) / (4.0 * radius.powi(3))).clamp(0.0, 1.0);
        let exp_fy = if frac > 0.0 {
            rho * g * vol * frac - frac * (ld + qd * vy.abs()) * vy
        } else {
            0.0
        };
        near(got[1], frac, 1e-4);
        near(got[2], exp_fy, (exp_fy.abs() * 2e-4).max(1e-2));
    }
}
