use crate::Fixture;

#[test]
fn ballistics_rk4_lead_and_mesh_slice_match_f64_reference() {
    let mut f = Fixture::new("tests/feel_physics_extra.sq");
    let got = f.floats("witness_ballistics_and_slice", 0u32);
    assert_eq!(got.len(), 10);

    // Independent f64 RK4 projectile reference (drag = 0.02, wind = (3, 0, 0), g = (0, -9.81, 0)).
    let acc = |v: [f64; 3]| -> [f64; 3] {
        let rel = [v[0] - 3.0, v[1], v[2]];
        let speed = (rel[0] * rel[0] + rel[1] * rel[1] + rel[2] * rel[2]).sqrt();
        [
            -0.02 * speed * rel[0],
            -9.81 - 0.02 * speed * rel[1],
            -0.02 * speed * rel[2],
        ]
    };
    let mut pos = [0.0f64; 3];
    let mut vel = [10.0, 20.0, 0.0];
    let dt = 0.025f64;
    for _ in 0..40 {
        let k1v = acc(vel);
        let k1x = vel;
        let v2 = [
            vel[0] + 0.5 * dt * k1v[0],
            vel[1] + 0.5 * dt * k1v[1],
            vel[2] + 0.5 * dt * k1v[2],
        ];
        let k2v = acc(v2);
        let k2x = v2;
        let v3 = [
            vel[0] + 0.5 * dt * k2v[0],
            vel[1] + 0.5 * dt * k2v[1],
            vel[2] + 0.5 * dt * k2v[2],
        ];
        let k3v = acc(v3);
        let k3x = v3;
        let v4 = [
            vel[0] + dt * k3v[0],
            vel[1] + dt * k3v[1],
            vel[2] + dt * k3v[2],
        ];
        let k4v = acc(v4);
        let k4x = v4;
        for c in 0..3 {
            pos[c] += (dt / 6.0) * (k1x[c] + 2.0 * k2x[c] + 2.0 * k3x[c] + k4x[c]);
            vel[c] += (dt / 6.0) * (k1v[c] + 2.0 * k2v[c] + 2.0 * k3v[c] + k4v[c]);
        }
    }
    assert!(
        (got[0] - pos[0]).abs() < 1e-3,
        "px: {} vs {}",
        got[0],
        pos[0]
    );
    assert!(
        (got[1] - pos[1]).abs() < 1e-3,
        "py: {} vs {}",
        got[1],
        pos[1]
    );
    assert!(
        (got[2] - vel[0]).abs() < 1e-3,
        "vx: {} vs {}",
        got[2],
        vel[0]
    );
    assert!(
        (got[3] - vel[1]).abs() < 1e-3,
        "vy: {} vs {}",
        got[3],
        vel[1]
    );

    // Verify ballistic lead intercept satisfies valid==true, t>0, |p(t) - target(t)| == 0 and |v0| == 60.
    let (t, lvx, lvy, lvz) = (got[4], got[5], got[6], got[7]);
    assert!(t > 0.1 && t < 5.0, "flight time {t}");
    let speed = (lvx * lvx + lvy * lvy + lvz * lvz).sqrt();
    assert!((speed - 60.0).abs() < 0.05, "launch speed {speed}");
    let hit = [lvx * t, lvy * t - 0.5 * 9.81 * t * t, lvz * t];
    let target = [40.0 - 4.0 * t, 5.0, 6.0 * t];
    let miss = ((hit[0] - target[0]).powi(2)
        + (hit[1] - target[1]).powi(2)
        + (hit[2] - target[2]).powi(2))
    .sqrt();
    assert!(miss < 1e-2, "ballistic miss {miss}");

    // Exact analytic volumes for [0,2]^3 cut at x = 0.5: front = 1.5*4 = 6.0, back = 0.5*4 = 2.0.
    assert!((got[8] - 6.0).abs() < 1e-3, "front vol {}", got[8]);
    assert!((got[9] - 2.0).abs() < 1e-3, "back vol {}", got[9]);
}

#[test]
fn pcg_poisson_and_noise_invariants_hold() {
    let mut f = Fixture::new("tests/gameplay_pcg.sq");
    let got = f.floats("witness_pcg_stats", 42u32);
    assert_eq!(got.len(), 8);
    assert!(got[0] >= 12.0, "poisson point count {}", got[0]);
    assert!(got[1] >= 3.0 - 1e-3, "poisson min spacing {}", got[1]);
    // Exact Worley boundary F2 witness at seed=3, (0.99, 0.01) & (0.99, 0.01, 0.01)
    // must include offset +-2 cells (2D F2 <= 1.15, 3D F2 <= 1.20).
    assert!(
        got[2] >= 0.0 && got[3] >= got[2] && got[3] < 1.16,
        "worley2 boundary F1/F2: {:?}",
        &got[2..4]
    );
    assert!(
        got[4] >= 0.0 && got[5] >= got[4] && got[5] < 1.20,
        "worley3 boundary F1/F2: {:?}",
        &got[4..6]
    );
    assert!(got[6].abs() <= 1.1, "simplex2 range {}", got[6]);
    // 3D Simplex continuity across x=y simplex boundary (2e-7 step must have jump < 1e-4).
    assert!(
        got[7] < 1.0e-4,
        "simplex3 discontinuity across x=y: {}",
        got[7]
    );
}
