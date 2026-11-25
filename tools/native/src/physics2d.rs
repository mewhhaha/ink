//! Independent f64 numerical references for `ink/physics/d2/*`.
use crate::{Fixture, near};

#[test]
fn d2_inertia_matches_f64_analytic_formulas() {
    let mut f = Fixture::new("tests/physics2d_reference.blot");
    let (r, hw, hh, hl, m) = (1.25_f64, 1.5_f64, 0.75_f64, 1.1_f64, 4.5_f64);
    let out = f.floats("inertia_witness", [r, hw, hh, hl, m]);
    assert_eq!(out.len(), 5);

    // Analytic f64 moments of inertia.
    let i_circle = 0.5 * m * r * r;
    let w = 2.0 * hw;
    let h = 2.0 * hh;
    let i_box = m * (w * w + h * h) / 12.0;
    let rect_a = 4.0 * r * hl;
    let cap_a = std::f64::consts::PI * r * r;
    let total_a = rect_a + cap_a;
    let m_rect = m * (rect_a / total_a);
    let m_cap = m * (cap_a / total_a);
    let i_rect = m_rect * ((2.0 * r).powi(2) + (2.0 * hl).powi(2)) / 12.0;
    let c_shift = 4.0 * r / (3.0 * std::f64::consts::PI);
    let i_semi_centroid = 0.5 * m_cap * r * r - m_cap * c_shift * c_shift;
    let i_capsule = i_rect + i_semi_centroid + m_cap * (hl + c_shift).powi(2);

    near(out[0], i_circle, 1e-4);
    near(out[1], i_box, 1e-4);
    near(out[2], i_capsule, 1e-3);
    near(out[3], w * h, 1e-4);
    near(out[4], i_box, 1e-3);
}

#[test]
fn d2_elastic_collision_conserves_momentum_and_kinetic_energy() {
    let mut f = Fixture::new("tests/physics2d_reference.blot");
    let cases = [
        (1.0_f64, 1.0_f64, 6.0_f64, -2.0_f64),
        (2.5_f64, 1.0_f64, 5.0_f64, 0.0_f64),
        (1.0_f64, 4.0_f64, 8.0_f64, -3.0_f64),
    ];
    for (m0, m1, v0, v1) in cases {
        let out = f.floats("elastic_collision_witness", [m0, m1, v0, v1]);
        assert_eq!(out.len(), 4);
        // Exact 1D elastic collision formulas in f64.
        let exp_v0 = ((m0 - m1) * v0 + 2.0 * m1 * v1) / (m0 + m1);
        let exp_v1 = ((m1 - m0) * v1 + 2.0 * m0 * v0) / (m0 + m1);
        let p_before = m0 * v0 + m1 * v1;
        let p_after = m0 * out[0] + m1 * out[2];
        let ke_before = 0.5 * (m0 * v0 * v0 + m1 * v1 * v1);
        let ke_after = 0.5 * (m0 * out[0] * out[0] + m1 * out[2] * out[2]);
        near(out[0], exp_v0, 1e-3);
        near(out[2], exp_v1, 1e-3);
        near(out[1], 0.0, 1e-4);
        near(out[3], 0.0, 1e-4);
        near(p_after, p_before, 1e-3);
        near(ke_after, ke_before, 1e-2);
    }
}

#[test]
fn d2_raycast_matches_analytic_f64_circle_box_and_edge() {
    let mut f = Fixture::new("tests/physics2d_reference.blot");
    let (ox, oy, dx, dy) = (0.0_f64, 0.5_f64, 1.0_f64, 0.0_f64);
    let out = f.floats("raycast_witness", [ox, oy, dx, dy]);
    assert_eq!(out[0], 3.0);
    // Hit 0: circle at (4, 0.5) r=1 -> t=3.0, normal=(-1, 0).
    assert_eq!(out[1], 0.0);
    near(out[2], 3.0, 1e-4);
    near(out[3], -1.0, 1e-4);
    near(out[4], 0.0, 1e-4);
    // Hit 1: box at (8, 0) half=(1, 1.5) -> t=7.0, normal=(-1, 0).
    assert_eq!(out[5], 1.0);
    near(out[6], 7.0, 1e-4);
    near(out[7], -1.0, 1e-4);
    near(out[8], 0.0, 1e-4);
    // Hit 2: edge at x=11 -> t=11.0, normal=(-1, 0).
    assert_eq!(out[9], 2.0);
    near(out[10], 11.0, 1e-4);
    near(out[11], -1.0, 1e-4);
    near(out[12], 0.0, 1e-4);
}

#[test]
fn d2_broadphase_matches_bruteforce_reference_pairs_exactly() {
    let mut f = Fixture::new("tests/physics2d_reference.blot");
    let count: u32 = 35;
    let words = f.words("broadphase_parity_witness", count);
    let n_pairs = words[0] as usize;
    assert_eq!(words.len(), 1 + n_pairs * 2);
    let mut got = Vec::with_capacity(n_pairs);
    for i in 0..n_pairs {
        got.push((words[1 + i * 2], words[2 + i * 2]));
    }
    // Independent brute-force AABB overlap set in Rust.
    let mut aabbs: Vec<(f64, f64, f64, f64, bool)> = vec![(-40.0, -1.5, 40.0, -0.5, false)];
    for i in 0..count {
        let x = (i % 7) as f64 * 0.85;
        let y = (i / 7) as f64 * 0.85;
        aabbs.push((x - 0.5, y - 0.5, x + 0.5, y + 0.5, true));
    }
    let mut want = Vec::new();
    for i in 0..aabbs.len() {
        for j in (i + 1)..aabbs.len() {
            if !(aabbs[i].4 || aabbs[j].4) {
                continue;
            }
            let a = aabbs[i];
            let b = aabbs[j];
            if a.0 <= b.2 && a.2 >= b.0 && a.1 <= b.3 && a.3 >= b.1 {
                want.push((i as u32, j as u32));
            }
        }
    }
    assert_eq!(
        got, want,
        "spatial-hash broadphase must equal sorted brute-force AABB pairs"
    );
}

#[test]
fn d2_ccd_prevents_tunneling_and_rebounds_physically() {
    let mut f = Fixture::new("tests/physics2d_reference.blot");
    let (speed, wall_x, rest) = (600.0_f64, 4.0_f64, 0.8_f64);
    let out = f.floats("ccd_bullet_witness", [speed, wall_x, rest]);
    // Impact x = wall_x - wall_half_w(0.1) - bullet_r(0.25) = 3.65.
    // Rebound velocity = -rest * speed = -480 m/s; remaining time = (1/60) - 3.65/600.
    let dt = 1.0 / 60.0;
    let impact_x = wall_x - 0.1 - 0.25;
    let toi = impact_x / (speed * dt);
    let exp_v = -rest * speed;
    let exp_x = impact_x + (1.0 - toi) * dt * exp_v;
    assert!(out[0] < wall_x, "bullet must never tunnel past thin wall");
    near(out[1], exp_v, 1.0);
    near(out[0], exp_x, 0.25);
}

#[test]
fn d2_character_climbs_walkable_slope_and_rejects_steep_slope() {
    let mut f = Fixture::new("tests/physics2d_reference.blot");
    let gentle = f.floats("character_slope_witness", 25.0);
    let steep = f.floats("character_slope_witness", 65.0);
    assert!(
        gentle[2] >= 20.0,
        "25 deg ramp must register grounded frames"
    );
    assert!(gentle[1] > 1.0, "character must climb up 25 deg ramp");
    assert!(
        steep[2] <= 2.0,
        "65 deg slope exceeds 45 deg max_slope and must not count as walkable ground"
    );
}
