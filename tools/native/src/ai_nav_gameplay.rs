//! Independent f64 references for Utility AI response curves & compensation
//! scoring, AI perception attenuation, and gameplay attribute evaluation.
use super::*;

const FIXTURE: &str = "tests/ai_nav_reference.blot";

#[test]
fn utility_curves_and_compensation_match_f64_reference() {
    let mut f = Fixture::new(FIXTURE);
    let mut r = Random(0x07117);
    for _ in 0..80 {
        let x = r.unit();
        let steep = 1.0 + r.unit() * 12.0;
        let mid = r.unit();
        let slope = 0.5 + r.unit() * 1.5;
        let exp = 0.5 + r.unit() * 3.0;
        let w0 = 0.05 + r.unit() * 0.95;
        let w1 = 0.05 + r.unit() * 0.95;
        let w2 = 0.05 + r.unit() * 0.95;
        let got = f.floats("utility_eval", [x, steep, mid, slope, exp, w0, w1, w2]);
        let exp_log = (1.0 / (1.0 + (-(steep * (x - mid))).exp())).clamp(0.0, 1.0);
        let exp_quad = (slope * x.powf(exp)).clamp(0.0, 1.0);
        let prod = w0 * w1 * w2;
        let exp_comp = prod + (1.0 - prod) * (1.0 - 1.0 / 3.0) * prod;
        near_all(&got, &[exp_log, exp_quad, exp_comp], 2e-4);
    }
}

#[test]
fn attribute_stack_and_hearing_falloff_match_f64_reference() {
    let mut f = Fixture::new(FIXTURE);
    let mut r = Random(0xA7721);
    for _ in 0..80 {
        let base = r.unit() * 100.0;
        let add0 = r.unit() * 40.0 - 20.0;
        let add1 = r.unit() * 40.0 - 20.0;
        let mul0 = 0.5 + r.unit() * 1.5;
        let mul1 = 0.5 + r.unit() * 1.5;
        let got = f.floats("attribute_eval", [base, 0.0, 200.0, add0, add1, mul0, mul1]);
        let exp = ((base + add0 + add1) * mul0 * mul1).clamp(0.0, 200.0);
        near(got[0], exp, 2e-3);

        let dist = r.unit() * 20.0;
        let range = 2.0 + r.unit() * 15.0;
        let loud = 0.2 + r.unit() * 1.8;
        let hg = f.floats("hearing_eval", [dist, range, loud]);
        let reach = range * loud;
        let exp_h = if dist >= reach {
            0.0
        } else {
            (1.0 - dist / reach).clamp(0.0, 1.0)
        };
        near(hg[0], exp_h, 1e-4);
    }
}
