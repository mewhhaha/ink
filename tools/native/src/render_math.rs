use crate::*;
use std::f64::consts::PI;
pub fn linear(x: f64) -> f64 {
    if x <= 0.04045 {
        x / 12.92
    } else {
        ((x + 0.055) / 1.055).powf(2.4)
    }
}
pub fn srgb(x: f64) -> f64 {
    if x <= 0.0031308 {
        x * 12.92
    } else {
        1.055 * x.powf(1. / 2.4) - 0.055
    }
}
pub fn tone(x: f64) -> f64 {
    let x = x.max(0.);
    (x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14)).min(1.)
}
pub fn normalize(v: &[f64]) -> Vec<f64> {
    let n = v.iter().map(|x| x * x).sum::<f64>().sqrt();
    v.iter().map(|x| x / n).collect()
}
pub fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(a, b)| a * b).sum()
}
pub fn brdf(a: &[f64]) -> Vec<f64> {
    let n = normalize(&a[5..8]);
    let v = normalize(&a[8..11]);
    let l = normalize(&a[11..14]);
    let nl = dot(&n, &l).clamp(0., 1.);
    let nv = dot(&n, &v).max(1e-5);
    if nl <= 0. || dot(&n, &v) <= 0. {
        return vec![0.; 3];
    }
    let h = normalize(&v.iter().zip(l).map(|(a, b)| a + b).collect::<Vec<_>>());
    let nh = dot(&n, &h).clamp(0., 1.);
    let vh = dot(&v, &h).clamp(0., 1.);
    let a2 = a[4].clamp(0.04, 1.).powi(4);
    let den = nh * nh * (a2 - 1.) + 1.;
    let d = a2 / (PI * den * den);
    let vis = 0.5
        / (nl * (nv * nv * (1. - a2) + a2).sqrt() + nv * (nl * nl * (1. - a2) + a2).sqrt())
            .max(1e-6);
    let metal = a[3].clamp(0., 1.);
    a[..3]
        .iter()
        .map(|b| {
            let f0 = 0.04 + (b - 0.04) * metal;
            let f = f0 + (1. - f0) * (1. - vh).powi(5);
            ((1. - f) * b * (1. - metal) / PI + f * d * vis) * nl
        })
        .collect()
}
pub fn splits(n: f64, f: f64, count: usize, blend: f64) -> Vec<f64> {
    (1..=count)
        .map(|i| {
            let t = i as f64 / count as f64;
            (n + (f - n) * t) * (1. - blend) + n * (f / n).powf(t) * blend
        })
        .collect()
}
#[test]
fn color_transfer_hdr_exposure_and_ggx_energy() {
    let mut f = Fixture::new("tests/render-math.blot");
    for v in [0., 0.0031308, 0.04045, 0.18, 0.5, 1., 4.] {
        let c = [v, v * 0.5, v * 1.5];
        let r = f.floats(
            "channels",
            [c.to_vec(), vec![0.37, 1.5, 0.125, 2.4, -3.5]].concat(),
        );
        near_all(
            &r[..4],
            &[c.map(linear).to_vec(), vec![0.37]].concat(),
            2e-4,
        );
        near_all(&r[4..8], &[c.to_vec(), vec![0.37]].concat(), 2e-5);
        near_all(&r[8..11], &c.map(tone), 1e-5);
        near_all(&r[11..14], &c.map(|v| srgb(tone(v * 2f64.powf(1.5)))), 2e-5);
        near_all(
            &r[14..],
            &[
                c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722,
                0.125f64.powf(2.4),
                2f64.powf(-3.5),
                -3.,
            ],
            1e-5,
        );
    }
    for metal in [0., 0.5, 1.] {
        for rough in [0.1, 0.5, 1.] {
            for view in [[0., 1., 0.], [1., 0.1, 0.]] {
                for light in [[0., 1., 0.], [0.3, 0.5, -0.2], [0., -1., 0.]] {
                    let a = [
                        vec![0.8, 0.3, 0.05, metal, rough, 0., 1., 0.],
                        view.to_vec(),
                        light.to_vec(),
                    ]
                    .concat();
                    let expected = brdf(&a);
                    let tol = (expected.iter().copied().fold(0., f64::max) * 0.0008).max(2e-5);
                    near_all(&f.floats("brdf", a), &expected, tol);
                }
            }
        }
    }
    for metal in [0., 1.] {
        for rough in [0.3, 0.6, 1.] {
            for view in [[0., 1., 0.], [1., 0.2, 0.]] {
                let r = f.floats(
                    "energy",
                    [vec![0.9, 0.6, 0.2, metal, rough], view.to_vec()].concat(),
                );
                assert!(r.iter().all(|x| x.is_finite() && *x >= 0. && *x <= 1.01));
            }
        }
    }
}
pub fn basis(d: &[f64]) -> [f64; 9] {
    let d = normalize(d);
    let (x, y, z) = (d[0], d[1], d[2]);
    [
        0.2820947918,
        0.4886025119 * y,
        0.4886025119 * z,
        0.4886025119 * x,
        1.0925484306 * x * y,
        1.0925484306 * y * z,
        0.3153915653 * (3. * z * z - 1.),
        1.0925484306 * x * z,
        0.5462742153 * (x * x - y * y),
    ]
}
#[test]
fn lighting_falloff_spot_cones_sky_and_sh_quadrature() {
    let mut f = Fixture::new("tests/render-math.blot");
    for distance in [1f64, 2., 9., 10., 11.] {
        let attenuation = if distance < 10. {
            (1. - (distance / 10.).powi(4)).powi(2) / (distance * distance)
        } else {
            0.
        };
        near_all(
            &f.floats(
                "light",
                [
                    0., distance, 0., 10., 5., 2., 10., 0., 0., 0., 0., -1., 0., 0.95, 0.8,
                ],
            ),
            &[
                0.,
                1.,
                0.,
                10. * attenuation,
                5. * attenuation,
                2. * attenuation,
                10. * attenuation,
                5. * attenuation,
                2. * attenuation,
            ],
            1e-5,
        );
    }
    near_all(
        &f.floats(
            "light",
            [
                0., 2., 0., 10., 5., 2., 10., 0., 0., 0., 1., 0., 0., 0.95, 0.8,
            ],
        )[6..],
        &[0.; 3],
        1e-5,
    );
    let dirs = [
        [1., 0., 0.],
        [-1., 0., 0.],
        [0., 1., 0.],
        [0., -1., 0.],
        [0., 0., 1.],
        [0., 0., -1.],
    ];
    for constant in [true, false] {
        let mut coeff = [[0.; 3]; 9];
        let mut input = Vec::new();
        for (k, d) in dirs.iter().enumerate() {
            let mut rad = [0.3, 0.6, 0.9];
            if !constant {
                rad[0] *= k as f64 + 1.;
                rad[1] *= 2. - k as f64 * 0.2;
                rad[2] *= 0.5 + k as f64 * 0.1;
            }
            let weight = 4. * PI / 6.;
            input.extend(d);
            input.extend(rad);
            input.push(weight);
            let terms = basis(d);
            for i in 0..9 {
                let kernel = if i == 0 {
                    PI
                } else if i <= 3 {
                    2. * PI / 3.
                } else {
                    PI / 4.
                };
                for j in 0..3 {
                    coeff[i][j] += rad[j] * terms[i] * weight * kernel;
                }
            }
        }
        let r = f.floats("sh", input);
        near_all(&r[..27], &coeff.concat(), 1e-5);
        let mut evaluated = Vec::new();
        for d in [dirs[2], dirs[0], dirs[5]] {
            let terms = basis(&d);
            for j in 0..3 {
                evaluated.push((0..9).map(|i| coeff[i][j] * terms[i]).sum::<f64>().max(0.));
            }
        }
        near_all(&r[27..], &evaluated, 1e-5);
        if constant {
            near_all(&r[27..], &[0.3 * PI, 0.6 * PI, 0.9 * PI].repeat(3), 1e-5);
        }
    }
    for (a, b) in [
        ([1., 0., 0.], [0.3, 0.4, 0.5]),
        ([0., -1., 0.], [0.01, 0.02, 0.03]),
        ([0., 1., 0.], [10.1, 8.2, 6.4]),
    ] {
        near_all(&f.floats("sky", a), &b, 1e-5)
    }
}
#[test]
fn shadow_splits_fitting_depth_padding_and_subtexel_snapping() {
    let mut f = Fixture::new("tests/render-math.blot");
    for blend in [0., 0.5, 1.] {
        for count in [1, 4, 8] {
            near_all(
                &f.floats("splits", [0.1, 1000., count as f64, blend]),
                &splits(0.1, 1000., count, blend),
                0.005,
            );
        }
    }
    assert_eq!(
        *f.floats("splits", [0.1, 1000., 4., 0.5]).last().unwrap(),
        1000.
    );
    assert!(
        f.floats("splits", [1e-30, 1e30, 4., 1.])
            .iter()
            .all(|x| x.is_finite() && *x > 0.)
    );
    for a in [[0., 100., 4., 0.5], [1., 100., 0., 0.5]] {
        assert!(f.floats("splits", a).is_empty());
    }
    let mut corners = Vec::new();
    for x in [-2., 2.] {
        for y in [-1., 1.] {
            for z in [-4., -1.] {
                corners.push([x, y, z]);
            }
        }
    }
    let r = f.floats(
        "cascade",
        [vec![0., 0., -1., 1024., 3.], corners.concat()].concat(),
    );
    let radius = ((4f64 + 1. + 2.25).sqrt() * 16.).ceil() / 16. / (1. - 1. / 1024.);
    near_all(
        &r[..11],
        &[
            0.,
            0.,
            -2.5 + radius + 3.,
            0.,
            0.,
            0.,
            1.,
            radius * 2.,
            1.,
            0.,
            (radius + 3.) * 2.,
        ],
        1e-5,
    );
    for (i, p) in corners.iter().enumerate() {
        near_all(
            &r[11 + i * 3..14 + i * 3],
            &[
                p[0] / radius,
                p[1] / radius,
                (-p[2] - 2.5 + radius + 3.) / ((radius + 3.) * 2.),
            ],
            1e-5,
        )
    }
    for settings in [vec![0., 0., 0., 1024., 0.], vec![0., 0., -1., 1., 0.]] {
        assert!(
            f.floats("cascade", [settings, corners.concat()].concat())
                .is_empty()
        );
    }
    let base = f.floats(
        "cascade",
        [vec![0., -1., -1., 1024., 3.], corners.concat()].concat(),
    );
    for p in base[11..].chunks(3) {
        assert!(p[0].abs() <= 1. && p[1].abs() <= 1. && p[2] >= 0. && p[2] <= 1.);
    }
    let shifted = f.floats(
        "cascade",
        [
            vec![0., -1., -1., 1024., 3.],
            corners
                .iter()
                .flat_map(|p| [p[0] + 0.0001, p[1], p[2]])
                .collect(),
        ]
        .concat(),
    );
    near_all(&shifted[..11], &base[..11], 1e-5);
    let tight = f.floats(
        "cascade",
        [0., 0., -1., 1024., 0., 1.0009, 0., 0., -0.9991, 0., 0.],
    );
    assert!(tight[11..].chunks(3).all(|p| p[0].abs() <= 1.));
}

// The sky of `environment.sky` without its sun: colour lerps from the
// horizon to the zenith or the ground by sqrt of the height.
pub fn sky_radiance(settings: &[[f64; 3]; 3], d: &[f64; 3]) -> [f64; 3] {
    let [zenith, horizon, ground] = settings;
    let (to, t) = if d[1] >= 0. {
        (zenith, d[1].sqrt())
    } else {
        (ground, (-d[1]).sqrt())
    };
    std::array::from_fn(|c| horizon[c] + (to[c] - horizon[c]) * t)
}
// Midpoint quadrature over the sphere on an equal-area grid, calling `f`
// with each direction and its solid angle.
pub fn sphere(rows: usize, columns: usize, mut f: impl FnMut([f64; 3], f64)) {
    let weight = 4. * PI / (rows * columns) as f64;
    for row in 0..rows {
        let y = 1. - 2. * (row as f64 + 0.5) / rows as f64;
        let ring = (1. - y * y).max(0.).sqrt();
        for column in 0..columns {
            let angle = (column as f64 + 0.5) * 2. * PI / columns as f64;
            f([ring * angle.cos(), y, ring * angle.sin()], weight);
        }
    }
}
// The cosine-convolved irradiance of the sky toward `n`, divided by pi,
// summed directly over a fine grid with no spherical harmonics.
fn sky_light_toward(settings: &[[f64; 3]; 3], n: &[f64; 3]) -> [f64; 3] {
    let mut sum = [0.; 3];
    sphere(720, 1440, |d, weight| {
        let cosine = dot(n, &d).max(0.);
        let radiance = sky_radiance(settings, &d);
        for c in 0..3 {
            sum[c] += radiance[c] * cosine * weight;
        }
    });
    sum.map(|v| v / PI)
}
#[test]
fn sky_sh_diffuse_matches_direct_cosine_integration_and_keeps_flat_ambient() {
    let mut f = Fixture::new("tests/render-math.blot");
    let skies = [
        [[0.1, 0.2, 0.4], [0.3, 0.4, 0.5], [0.01, 0.02, 0.03]],
        [[0.9, 0.5, 0.2], [1.2, 0.8, 0.5], [0.05, 0.04, 0.03]],
        [
            [0.02, 0.03, 0.08],
            [0.01, 0.015, 0.03],
            [0.005, 0.005, 0.01],
        ],
    ];
    for sky in skies {
        let ambient = [0.24, 0.25, 0.26];
        let input = [sky.concat(), ambient.to_vec(), vec![16., 32.]].concat();
        let r = f.floats("ambient", input);
        // The tint is ambient over the sky's mean radiance.
        let mut mean = [0.; 3];
        sphere(720, 1440, |d, weight| {
            let radiance = sky_radiance(&sky, &d);
            for c in 0..3 {
                mean[c] += radiance[c] * weight / (4. * PI);
            }
        });
        let tint: Vec<f64> = (0..3).map(|c| ambient[c] / mean[c]).collect();
        near_all(
            &r[..3],
            &tint,
            1e-2 * tint.iter().cloned().fold(0., f64::max),
        );
        // Nine coefficients: the projection of the radiance, cosine lobes
        // applied, over pi, scaled by the tint.
        let mut expected = [[0.; 3]; 9];
        sphere(720, 1440, |d, weight| {
            let terms = basis(&d);
            let radiance = sky_radiance(&sky, &d);
            for i in 0..9 {
                let kernel = if i == 0 {
                    PI
                } else if i <= 3 {
                    2. * PI / 3.
                } else {
                    PI / 4.
                };
                for c in 0..3 {
                    expected[i][c] += radiance[c] * terms[i] * weight * kernel / PI * tint[c];
                }
            }
        });
        let scale = expected.iter().flatten().fold(0f64, |m, v| m.max(v.abs()));
        near_all(&r[3..30], &expected.concat(), 1e-2 * scale);
        // The evaluated light follows the true cosine integral (L2 keeps
        // well) and never goes negative; the L2 truncation costs a few percent.
        for (k, n) in [[0., 1., 0.], [1., 0., 0.], [0., -1., 0.]]
            .iter()
            .enumerate()
        {
            let direct = sky_light_toward(&sky, n);
            let got = &r[30 + k * 3..33 + k * 3];
            for c in 0..3 {
                let want = direct[c] * tint[c];
                assert!(got[c] >= 0.);
                assert!(
                    (got[c] - want).abs() <= 0.08 * want + 0.02 * ambient[c],
                    "sky {sky:?} normal {n:?} channel {c}: {} vs {want}",
                    got[c]
                );
            }
        }
    }
    // A uniform sky is the flat ambient light in every direction, to the
    // midpoint grid's 0.25% on the band-2 terms.
    let r = f.floats(
        "ambient",
        vec![
            0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.2, 0.3, 0.4, 16., 32.,
        ],
    );
    for k in 0..3 {
        near_all(&r[30 + k * 3..33 + k * 3], &[0.2, 0.3, 0.4], 2e-3);
    }
    // No light in a channel stays dark, with no division by zero.
    let r = f.floats(
        "ambient",
        vec![
            0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0., 0.3, 0., 16., 32.,
        ],
    );
    assert!(r.iter().all(|v| v.is_finite()));
    near_all(&r[30..33], &[0., 0.3, 0.], 2e-3);
}
