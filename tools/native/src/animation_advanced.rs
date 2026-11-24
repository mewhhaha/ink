//! Independent f64 references for skinning palettes, inertialization,
//! multi-bone IK (FABRIK & CCD), skeleton retargeting, and morph blending.
use super::*;

type V = [f64; 3];
type Q = [f64; 4];

const FIXTURE: &str = "tests/animation_advanced_reference.blot";

fn add(a: V, b: V) -> V {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn sub(a: V, b: V) -> V {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn mul(a: V, s: f64) -> V {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn dot(a: V, b: V) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn len(a: V) -> f64 {
    dot(a, a).sqrt()
}
fn qmul(a: Q, b: Q) -> Q {
    [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ]
}
fn qconj(q: Q) -> Q {
    [-q[0], -q[1], -q[2], q[3]]
}
fn qnorm(q: Q) -> Q {
    let l = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    [q[0] / l, q[1] / l, q[2] / l, q[3] / l]
}
fn qdot(a: Q, b: Q) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
}
fn qlog_vec(q: Q) -> V {
    let mut n = qnorm(q);
    if n[3] < 0.0 {
        n = [-n[0], -n[1], -n[2], -n[3]];
    }
    let s = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if s < 1e-12 {
        return [2.0 * n[0], 2.0 * n[1], 2.0 * n[2]];
    }
    let f = 2.0 * s.atan2(n[3]) / s;
    [n[0] * f, n[1] * f, n[2] * f]
}
fn qexp_vec(v: V) -> Q {
    let a = len(v);
    if a < 1e-12 {
        return qnorm([0.5 * v[0], 0.5 * v[1], 0.5 * v[2], 1.0]);
    }
    let s = (0.5 * a).sin() / a;
    qnorm([v[0] * s, v[1] * s, v[2] * s, (0.5 * a).cos()])
}
fn rand_dir(r: &mut Random) -> V {
    let z = r.unit() * 2.0 - 1.0;
    let a = r.unit() * std::f64::consts::TAU;
    let s = (1.0 - z * z).sqrt();
    [s * a.cos(), z, s * a.sin()]
}
fn rand_quat(r: &mut Random) -> Q {
    let axis = rand_dir(r);
    let angle = r.unit() * 5.0 - 2.5;
    qexp_vec(mul(axis, angle))
}
fn rand_vec(r: &mut Random, scale: f64) -> V {
    [
        (r.unit() * 2.0 - 1.0) * scale,
        (r.unit() * 2.0 - 1.0) * scale,
        (r.unit() * 2.0 - 1.0) * scale,
    ]
}
fn compose_mat4(p: V, q: Q, s: V) -> [f64; 16] {
    let q = qnorm(q);
    let (x, y, z, w) = (q[0], q[1], q[2], q[3]);
    let (xx, yy, zz) = (x * x, y * y, z * z);
    let (xy, xz, yz) = (x * y, x * z, y * z);
    let (wx, wy, wz) = (w * x, w * y, w * z);
    [
        (1.0 - 2.0 * (yy + zz)) * s[0],
        2.0 * (xy + wz) * s[0],
        2.0 * (xz - wy) * s[0],
        0.0,
        2.0 * (xy - wz) * s[1],
        (1.0 - 2.0 * (xx + zz)) * s[1],
        2.0 * (yz + wx) * s[1],
        0.0,
        2.0 * (xz + wy) * s[2],
        2.0 * (yz - wx) * s[2],
        (1.0 - 2.0 * (xx + yy)) * s[2],
        0.0,
        p[0],
        p[1],
        p[2],
        1.0,
    ]
}
fn mul_mat4(a: &[f64; 16], b: &[f64; 16]) -> [f64; 16] {
    let mut out = [0.0; 16];
    for col in 0..4 {
        for row in 0..4 {
            out[col * 4 + row] = (0..4).map(|k| a[k * 4 + row] * b[col * 4 + k]).sum::<f64>();
        }
    }
    out
}
fn inv_affine_mat4(m: &[f64; 16]) -> [f64; 16] {
    let (ax, ay, az) = (m[0], m[1], m[2]);
    let (bx, by, bz) = (m[4], m[5], m[6]);
    let (cx, cy, cz) = (m[8], m[9], m[10]);
    let rxx = by * cz - bz * cy;
    let rxy = bz * cx - bx * cz;
    let rxz = bx * cy - by * cx;
    let det = ax * rxx + ay * rxy + az * rxz;
    let inv3 = [
        [
            rxx / det,
            (cy * az - cz * ay) / det,
            (ay * bz - az * by) / det,
        ],
        [
            rxy / det,
            (cz * ax - cx * az) / det,
            (az * bx - ax * bz) / det,
        ],
        [
            rxz / det,
            (cx * ay - cy * ax) / det,
            (ax * by - ay * bx) / det,
        ],
    ];
    let t = [-m[12], -m[13], -m[14]];
    let tx = inv3[0][0] * t[0] + inv3[1][0] * t[1] + inv3[2][0] * t[2];
    let ty = inv3[0][1] * t[0] + inv3[1][1] * t[1] + inv3[2][1] * t[2];
    let tz = inv3[0][2] * t[0] + inv3[1][2] * t[1] + inv3[2][2] * t[2];
    [
        inv3[0][0], inv3[0][1], inv3[0][2], 0.0, inv3[1][0], inv3[1][1], inv3[1][2], 0.0,
        inv3[2][0], inv3[2][1], inv3[2][2], 0.0, tx, ty, tz, 1.0,
    ]
}

#[test]
fn inertialization_matches_f64_critically_damped_spring() {
    let mut f = Fixture::new(FIXTURE);
    let mut r = Random(0x1E27A);
    let spring_k = 4.0 * 2.0f64.ln();
    for _ in 0..120 {
        let hl = 0.03 + r.unit() * 0.4;
        let dt = r.unit() * 0.25;
        let sp = rand_vec(&mut r, 3.0);
        let sr = rand_quat(&mut r);
        let ss = [
            0.7 + r.unit() * 0.6,
            0.7 + r.unit() * 0.6,
            0.7 + r.unit() * 0.6,
        ];
        let svp = rand_vec(&mut r, 2.0);
        let sva = rand_vec(&mut r, 2.0);
        let svs = rand_vec(&mut r, 0.5);
        let tp = rand_vec(&mut r, 3.0);
        let tr = rand_quat(&mut r);
        let ts = [
            0.7 + r.unit() * 0.6,
            0.7 + r.unit() * 0.6,
            0.7 + r.unit() * 0.6,
        ];
        let tvp = rand_vec(&mut r, 2.0);
        let tva = rand_vec(&mut r, 2.0);
        let tvs = rand_vec(&mut r, 0.5);
        let args: Vec<f64> = [
            &[hl, dt][..],
            &sp,
            &sr,
            &ss,
            &svp,
            &sva,
            &svs,
            &tp,
            &tr,
            &ts,
            &tvp,
            &tva,
            &tvs,
        ]
        .concat();
        let got = f.floats("inertialize_step", args);
        assert_eq!(got[0], 1.0);
        let y = spring_k / hl;
        let ey = (-y * dt).exp();
        let decay = |x: V, v: V| -> V {
            let j1 = add(v, mul(x, y));
            mul(add(x, mul(j1, dt)), ey)
        };
        let ep = add(tp, decay(sub(sp, tp), sub(svp, tvp)));
        let es = add(ts, decay(sub(ss, ts), sub(svs, tvs)));
        let r_off = decay(qlog_vec(qmul(sr, qconj(tr))), sub(sva, tva));
        let er = qnorm(qmul(qexp_vec(r_off), tr));
        near_all(&got[1..4], &ep, 2e-4);
        near_all(&got[8..11], &es, 2e-4);
        let gq = [got[4], got[5], got[6], got[7]];
        assert!(qdot(gq, er).abs() > 0.99995, "got={gq:?} exp={er:?}");
    }
}

#[test]
fn fabrik_and_ccd_preserve_lengths_and_converge_across_random_chains() {
    let mut f = Fixture::new(FIXTURE);
    let mut r = Random(0xFAB21);
    for _ in 0..80 {
        let count = 3 + ((r.unit() * 4.0) as usize).min(3);
        let mut pts = vec![rand_vec(&mut r, 1.0)];
        let mut lengths = Vec::new();
        for _ in 1..count {
            let seg = 0.4 + r.unit() * 0.8;
            lengths.push(seg);
            pts.push(add(*pts.last().unwrap(), mul(rand_dir(&mut r), seg)));
        }
        let reach_max: f64 = lengths.iter().sum();
        let longest = lengths.iter().copied().fold(0.0f64, f64::max);
        let reach_min = (2.0 * longest - reach_max).max(0.0);
        let span = (reach_max - reach_min).max(0.2);
        let dist = reach_min + span * (0.15 + 0.75 * r.unit());
        let target = add(pts[0], mul(rand_dir(&mut r), dist));
        let pole = rand_dir(&mut r);

        let mut f_args = vec![count as f64];
        f_args.extend(target);
        f_args.extend(pole);
        f_args.extend([32.0, 1e-4, 1.0]);
        for p in &pts {
            f_args.extend(p);
        }
        let fg = f.floats("fabrik_solve", f_args);
        assert_eq!(fg[0], 1.0);
        let fpts: Vec<V> = (0..count)
            .map(|i| [fg[1 + i * 3], fg[2 + i * 3], fg[3 + i * 3]])
            .collect();
        near_all(&fpts[0], &pts[0], 1e-5);
        for i in 0..(count - 1) {
            near(len(sub(fpts[i + 1], fpts[i])), lengths[i], 2e-4);
        }
        assert!(len(sub(*fpts.last().unwrap(), target)) < 0.02);

        let mut c_args = vec![count as f64];
        c_args.extend(target);
        c_args.extend([64.0, 1e-4, 1.0]);
        for p in &pts {
            c_args.extend(p);
        }
        let cg = f.floats("ccd_solve", c_args);
        assert_eq!(cg[0], 1.0);
        let cpts: Vec<V> = (0..count)
            .map(|i| [cg[1 + i * 3], cg[2 + i * 3], cg[3 + i * 3]])
            .collect();
        near_all(&cpts[0], &pts[0], 1e-5);
        for i in 0..(count - 1) {
            near(len(sub(cpts[i + 1], cpts[i])), lengths[i], 3e-4);
        }
        let c_err = len(sub(*cpts.last().unwrap(), target));
        assert!(
            c_err < 0.05,
            "ccd err={c_err} count={count} lengths={lengths:?} reach=[{reach_min}, {reach_max}] dist={dist}"
        );
    }
}

#[test]
fn retargeting_and_skinning_match_f64_references() {
    let mut f = Fixture::new(FIXTURE);
    let mut r = Random(0x5C12);
    for _ in 0..80 {
        let sr0 = (rand_vec(&mut r, 1.0), rand_quat(&mut r));
        let sr1 = (rand_vec(&mut r, 1.0), rand_quat(&mut r));
        let sp0 = (rand_vec(&mut r, 1.0), rand_quat(&mut r));
        let sp1 = (rand_vec(&mut r, 1.0), rand_quat(&mut r));
        let tr0 = (rand_vec(&mut r, 1.0), rand_quat(&mut r));
        let tr1 = (rand_vec(&mut r, 1.0), rand_quat(&mut r));
        let hscale = 0.5 + r.unit() * 2.0;
        let args: Vec<f64> = [
            &sr0.0[..],
            &sr0.1,
            &sr1.0,
            &sr1.1,
            &sp0.0,
            &sp0.1,
            &sp1.0,
            &sp1.1,
            &tr0.0,
            &tr0.1,
            &tr1.0,
            &tr1.1,
            &[hscale],
        ]
        .concat();
        let got = f.floats("retarget_pair", args);
        assert_eq!(got[0], 1.0);
        let sw_rest0 = sr0.1;
        let sw_rest1 = qnorm(qmul(sw_rest0, sr1.1));
        let sw_pose0 = sp0.1;
        let sw_pose1 = qnorm(qmul(sw_pose0, sp1.1));
        let tw_rest0 = tr0.1;
        let tw_rest1 = qnorm(qmul(tw_rest0, tr1.1));
        let exp_w0 = qnorm(qmul(qmul(sw_pose0, qconj(sw_rest0)), tw_rest0));
        let exp_w1 = qnorm(qmul(qmul(sw_pose1, qconj(sw_rest1)), tw_rest1));
        let exp_l1 = qnorm(qmul(qconj(exp_w0), exp_w1));
        let exp_p0 = add(tr0.0, mul(sub(sp0.0, sr0.0), hscale));
        near_all(&got[1..4], &exp_p0, 2e-4);
        assert!(qdot([got[4], got[5], got[6], got[7]], exp_w0).abs() > 0.9999);
        assert!(qdot([got[11], got[12], got[13], got[14]], exp_l1).abs() > 0.9999);

        // Skinning matrix check with nonuniform scale (shear under rotation).
        let s0 = [0.6 + r.unit(), 0.6 + r.unit(), 0.6 + r.unit()];
        let s1 = [0.6 + r.unit(), 0.6 + r.unit(), 0.6 + r.unit()];
        let skin_args: Vec<f64> = [
            &sr0.0[..],
            &sr0.1,
            &s0,
            &sr1.0,
            &sr1.1,
            &s1,
            &sp0.0,
            &sp0.1,
            &s0,
            &sp1.0,
            &sp1.1,
            &s1,
        ]
        .concat();
        let sg = f.floats("skin_pair", skin_args);
        assert_eq!(sg[0], 1.0);
        let rest_w1 = mul_mat4(
            &compose_mat4(sr0.0, sr0.1, s0),
            &compose_mat4(sr1.0, sr1.1, s1),
        );
        let pose_w1 = mul_mat4(
            &compose_mat4(sp0.0, sp0.1, s0),
            &compose_mat4(sp1.0, sp1.1, s1),
        );
        let exp_skin = mul_mat4(&pose_w1, &inv_affine_mat4(&rest_w1));
        near_all(&sg[1..17], &exp_skin, 1e-3);
    }
}

#[test]
fn morph_vertex_blending_matches_f64_reference() {
    let mut f = Fixture::new(FIXTURE);
    let mut r = Random(0x402F);
    for _ in 0..80 {
        let bp = rand_vec(&mut r, 2.0);
        let bn = rand_dir(&mut r);
        let d0p = rand_vec(&mut r, 0.5);
        let d0n = rand_vec(&mut r, 0.3);
        let w0 = r.unit() * 2.0 - 0.5;
        let d1p = rand_vec(&mut r, 0.5);
        let d1n = rand_vec(&mut r, 0.3);
        let w1 = r.unit() * 2.0 - 0.5;
        let args: Vec<f64> = [&bp[..], &bn, &d0p, &d0n, &[w0], &d1p, &d1n, &[w1]].concat();
        let got = f.floats("morph_vertex", args);
        assert_eq!(got[0], 1.0);
        let ep = add(add(bp, mul(d0p, w0)), mul(d1p, w1));
        let raw_n = add(add(bn, mul(d0n, w0)), mul(d1n, w1));
        let en = if len(raw_n) > 1e-6 {
            mul(raw_n, 1.0 / len(raw_n))
        } else {
            bn
        };
        near_all(&got[1..4], &ep, 2e-5);
        near_all(&got[4..7], &en, 2e-4);
    }
}
