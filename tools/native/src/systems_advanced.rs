//! Independent f64 references for audio mixing/compression/reverb zones,
//! input stick curves & haptics, lag-compensated hitbox rewind raycasts,
//! camera-facing ribbon geometry, and LOD crossfade continuity.
use super::*;

const FIXTURE: &str = "tests/systems_advanced_reference.blot";

#[test]
fn audio_compressor_and_reverb_match_f64_reference() {
    let mut f = Fixture::new(FIXTURE);
    let mut r = Random(0xA0D10);
    for _ in 0..60 {
        let threshold = 0.05 + r.unit() * 0.6;
        let ratio = 1.0 + r.unit() * 9.0;
        let attack = 0.005 + r.unit() * 0.1;
        let release = 0.02 + r.unit() * 0.4;
        let floor_gain = r.unit() * 0.25;
        let det0 = r.unit() * 1.5;
        let dt0 = 0.005 + r.unit() * 0.08;
        let det1 = r.unit() * 0.4;
        let dt1 = 0.005 + r.unit() * 0.15;
        let got = f.floats(
            "compressor_eval",
            [
                threshold, ratio, attack, release, floor_gain, det0, dt0, det1, dt1,
            ],
        );
        let step = |level: f64, det: f64, dt: f64| -> (f64, f64) {
            let rate = if det > level { attack } else { release };
            let coeff = 1.0 - (-dt / rate).exp();
            let nl = level + (det - level) * coeff.clamp(0.0, 1.0);
            let raw_g = if nl > threshold {
                (nl / threshold).powf(1.0 / ratio - 1.0)
            } else {
                1.0
            };
            (nl, raw_g.clamp(floor_gain, 1.0))
        };
        let (l1, g1) = step(0.0, det0, dt0);
        let (l2, g2) = step(l1, det1, dt1);
        near_all(&got, &[l1, g1, l2, g2], 3e-4);

        let lx = r.unit() * 12.0 - 6.0;
        let ly = r.unit() * 4.0 - 2.0;
        let lz = r.unit() * 12.0 - 6.0;
        let (c0x, c0y, c0z, in0, out0, p0, w0) = (0.0, 0.0, 0.0, 2.0, 10.0, 1.0 + r.unit(), 0.8);
        let (c1x, c1y, c1z, in1, out1, p1, w1) = (4.0, 0.0, 0.0, 1.0, 8.0, 1.0 + r.unit(), 0.3);
        let rg = f.floats(
            "reverb_eval",
            [
                lx, ly, lz, c0x, c0y, c0z, in0, out0, p0, w0, c1x, c1y, c1z, in1, out1, p1, w1,
            ],
        );
        let zf = |cx: f64, cy: f64, cz: f64, inn: f64, out: f64, pr: f64| {
            let d = ((lx - cx).powi(2) + (ly - cy).powi(2) + (lz - cz).powi(2)).sqrt();
            let f = if d <= inn {
                1.0
            } else if d >= out {
                0.0
            } else {
                1.0 - (d - inn) / (out - inn)
            };
            f * pr
        };
        let r0 = zf(c0x, c0y, c0z, in0, out0, p0);
        let r1 = zf(c1x, c1y, c1z, in1, out1, p1);
        let tot = r0 + r1;
        let (e0, e1, ewet) = if tot <= 0.0 {
            (0.0, 0.0, 0.0)
        } else {
            (r0 / tot, r1 / tot, (r0 * w0 + r1 * w1) / tot)
        };
        near_all(&rg, &[e0, e1, ewet], 3e-4);
    }
}

#[test]
fn stick_curve_haptics_and_lag_comp_match_f64_reference() {
    let mut f = Fixture::new(FIXTURE);
    let mut r = Random(0x571C4);
    for _ in 0..60 {
        let sx = r.unit() * 2.0 - 1.0;
        let sy = r.unit() * 2.0 - 1.0;
        let inner = 0.05 + r.unit() * 0.25;
        let outer = 0.75 + r.unit() * 0.25;
        let exp = 1.0 + r.unit() * 2.5;
        let lp = 0.2 + r.unit() * 0.8;
        let hp = 0.2 + r.unit() * 0.8;
        let att = 0.05 + r.unit() * 0.2;
        let sus = 0.05 + r.unit() * 0.3;
        let rel = 0.05 + r.unit() * 0.2;
        let t = r.unit() * (att + sus + rel + 0.1);
        let got = f.floats(
            "stick_haptic_eval",
            [sx, sy, inner, outer, exp, lp, hp, att, sus, rel, t],
        );
        let mag = (sx * sx + sy * sy).sqrt();
        let (ex, ey) = if mag <= inner {
            (0.0, 0.0)
        } else {
            let norm = ((mag - inner) / (outer - inner)).clamp(0.0, 1.0);
            let shaped = norm.powf(exp);
            (sx * shaped / mag, sy * shaped / mag)
        };
        let env = if t < att {
            t / att
        } else if t < att + sus {
            1.0
        } else if t < att + sus + rel {
            1.0 - (t - att - sus) / rel
        } else {
            0.0
        };
        near_all(&got, &[ex, ey, lp * env, hp * env], 3e-4);

        let x0 = r.unit() * 4.0 - 2.0;
        let x1 = x0 + 2.0 + r.unit() * 6.0;
        let r0 = 0.5 + r.unit() * 1.5;
        let r1 = 0.5 + r.unit() * 1.5;
        let qt = r.unit() * 1.2 - 0.1;
        let t_clamped = qt.clamp(0.0, 1.0);
        let cx = x0 + (x1 - x0) * t_clamped;
        let cr = r0 + (r1 - r0) * t_clamped;
        let ox = cx + (r.unit() * 2.0 - 1.0) * cr * 1.4;
        let oz = -10.0;
        let rg = f.floats(
            "rewind_ray_eval",
            [
                0.0, x0, r0, 1.0, x1, r1, qt, ox, 0.0, oz, 0.0, 0.0, 1.0, 30.0,
            ],
        );
        let dx_c = ox - cx;
        let disc = 100.0 - (dx_c * dx_c + 100.0 - cr * cr);
        near(rg[0], cx, 1e-4);
        near(rg[1], cr, 1e-4);
        if disc >= 0.0 {
            let root = disc.sqrt();
            let hit_t = 10.0 - root;
            assert_eq!(rg[2], 1.0);
            near(rg[3], hit_t, 5e-4);
        } else {
            assert_eq!(rg[2], 0.0);
        }
    }
}

#[test]
fn ribbon_geometry_and_lod_crossfade_match_f64_reference() {
    let mut f = Fixture::new(FIXTURE);
    let mut r = Random(0x21BB0);
    for _ in 0..40 {
        let z1 = 1.0 + r.unit() * 5.0;
        let z2 = z1 + 1.0 + r.unit() * 5.0;
        let w0 = 0.5 + r.unit() * 3.0;
        let w1 = 0.5 + r.unit() * 3.0;
        let w2 = 0.5 + r.unit() * 3.0;
        let got = f.floats(
            "ribbon_eval",
            [
                0.0, 0.0, 0.0, w0, 0.0, 0.0, z1, w1, 0.0, 0.0, z2, w2, 0.0, 8.0, z1,
            ],
        );
        assert_eq!(got[0], 12.0);
        let width_actual =
            ((got[4] - got[1]).powi(2) + (got[5] - got[2]).powi(2) + (got[6] - got[3]).powi(2))
                .sqrt();
        near(width_actual, w0, 5e-4);
        near(got[7], z1 / z2, 5e-4);
        near(got[8], 1.0, 5e-4);
    }
    for i in 0..120 {
        let dist = i as f64;
        let got = f.floats("crossfade_eval", [20.0, 50.0, 90.0, 6.0, dist]);
        assert!((0.0..=1.0).contains(&got[2]));
        assert!(got[0] <= got[1]);
        if (dist - 20.0).abs() < 1e-6 {
            near_all(&got, &[0.0, 1.0, 0.5], 1e-4);
        }
        if (dist - 50.0).abs() < 1e-6 {
            near_all(&got, &[1.0, 2.0, 0.5], 1e-4);
        }
        if (dist - 90.0).abs() < 1e-6 {
            near_all(&got, &[2.0, 3.0, 0.5], 1e-4);
        }
    }
}
