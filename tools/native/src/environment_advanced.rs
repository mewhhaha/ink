//! Independent f64 references for CDLOD terrain splat/triplanar/morphing,
//! multi-wave Gerstner ocean waves + Beer-Lambert + Fresnel, and foliage wind
//! bending + octahedral impostor encoding/decoding.
use super::*;

const FIXTURE: &str = "tests/render_environment_reference.blot";

#[test]
fn cdlod_splat_triplanar_and_morph_match_f64_reference() {
    let mut f = Fixture::new(FIXTURE);
    let mut r = Random(0x7E22A1);
    for _ in 0..60 {
        let w = [r.unit(), r.unit(), r.unit(), r.unit()];
        let h = [r.unit(), r.unit(), r.unit(), r.unit()];
        let depth = 0.05 + r.unit() * 0.5;
        let nx = r.unit() * 2.0 - 1.0;
        let ny = r.unit() * 2.0 - 1.0;
        let nz = r.unit() * 2.0 - 1.0;
        let sharp = 1.0 + r.unit() * 8.0;
        let dist = r.unit() * 120.0;
        let range = 20.0 + r.unit() * 100.0;
        let mstart = 0.2 + r.unit() * 0.7;
        let got = f.floats(
            "terrain_eval",
            [
                w[0], w[1], w[2], w[3], h[0], h[1], h[2], h[3], depth, nx, ny, nz, sharp, dist,
                range, mstart,
            ],
        );
        let s: [f64; 4] = std::array::from_fn(|i| if w[i] > 0.0 { w[i] + h[i] } else { -1e6 });
        let top = s.into_iter().fold(f64::NEG_INFINITY, f64::max);
        let b = s.map(|v| (v - (top - depth)).max(0.0));
        let bsum: f64 = b.iter().sum();
        let sw = b.map(|v| v / bsum);
        let tw_raw = [nx, ny, nz].map(|c| c.abs().max(1e-6).powf(sharp));
        let tsum: f64 = tw_raw.iter().sum();
        let tw = tw_raw.map(|v| v / tsum);
        let lo = range * mstart;
        let mf = ((dist - lo) / (range - lo)).clamp(0.0, 1.0);
        near_all(
            &got,
            &[sw[0], sw[1], sw[2], sw[3], tw[0], tw[1], tw[2], mf],
            3e-4,
        );
    }
}

#[test]
fn gerstner_waves_beer_lambert_and_fresnel_match_f64_reference() {
    let mut f = Fixture::new(FIXTURE);
    let mut r = Random(0x0CEAA1);
    for _ in 0..60 {
        let waves = [
            (
                r.unit() * 2.0 - 1.0,
                r.unit() * 2.0 - 1.0,
                0.05 + r.unit() * 0.4,
                4.0 + r.unit() * 16.0,
                0.1 + r.unit() * 0.8,
                0.5 + r.unit() * 4.0,
            ),
            (
                r.unit() * 2.0 - 1.0,
                r.unit() * 2.0 - 1.0,
                0.05 + r.unit() * 0.3,
                3.0 + r.unit() * 12.0,
                0.1 + r.unit() * 0.8,
                0.5 + r.unit() * 4.0,
            ),
        ];
        let x = r.unit() * 20.0 - 10.0;
        let z = r.unit() * 20.0 - 10.0;
        let t = r.unit() * 10.0;
        let depth = r.unit() * 8.0;
        let ext = [
            0.2 + r.unit() * 0.5,
            0.05 + r.unit() * 0.3,
            0.02 + r.unit() * 0.15,
        ];
        let cos_t = r.unit();
        let f0 = 0.02 + r.unit() * 0.06;
        let got = f.floats(
            "water_eval",
            [
                waves[0].0, waves[0].1, waves[0].2, waves[0].3, waves[0].4, waves[0].5, waves[1].0,
                waves[1].1, waves[1].2, waves[1].3, waves[1].4, waves[1].5, x, z, t, depth, ext[0],
                ext[1], ext[2], cos_t, f0,
            ],
        );
        let (mut px, mut py, mut pz) = (x, 0.0, z);
        let (mut txx, mut txy, mut txz) = (1.0, 0.0, 0.0);
        let (mut tzx, mut tzy, mut tzz) = (0.0, 0.0, 1.0);
        for (dx_r, dz_r, amp, wl, steep, spd) in waves {
            let len = dx_r.hypot(dz_r);
            if len > 1e-6 {
                let (dx, dz) = (dx_r / len, dz_r / len);
                let k = std::f64::consts::TAU / wl;
                let q = steep.clamp(0.0, 0.99) * 0.5;
                let phase = k * (dx * x + dz * z) - k * spd * t;
                let (c, s) = (phase.cos(), phase.sin());
                px += (q / k) * dx * c;
                py += amp * s;
                pz += (q / k) * dz * c;
                txx -= dx * dx * q * s;
                txy += dx * k * amp * c;
                txz -= dx * dz * q * s;
                tzx -= dx * dz * q * s;
                tzy += dz * k * amp * c;
                tzz -= dz * dz * q * s;
            }
        }
        let nx = tzy * txz - tzz * txy;
        let ny = tzz * txx - tzx * txz;
        let nz = tzx * txy - tzy * txx;
        let nlen = (nx * nx + ny * ny + nz * nz).sqrt();
        let foam = (1.0 - (txx * tzz - txz * tzx)).clamp(0.0, 1.0);
        let tr = ext.map(|e| (-e * depth).exp());
        let fr = f0 + (1.0 - f0) * (1.0 - cos_t).powi(5);
        near_all(
            &got,
            &[
                px,
                py,
                pz,
                nx / nlen,
                ny / nlen,
                nz / nlen,
                foam,
                tr[0],
                tr[1],
                tr[2],
                fr,
            ],
            5e-4,
        );
    }
}

#[test]
fn foliage_wind_and_octahedral_round_trip_match_f64_reference() {
    let mut f = Fixture::new(FIXTURE);
    let mut r = Random(0xF011A6);
    for _ in 0..60 {
        let dir_x = r.unit() * 2.0 - 1.0;
        let dir_z = r.unit() * 2.0 - 1.0;
        let strength = 0.2 + r.unit() * 2.5;
        let freq = 0.05 + r.unit() * 0.5;
        let speed = 0.5 + r.unit() * 3.0;
        let turb = r.unit() * 0.8;
        let wx = r.unit() * 10.0 - 5.0;
        let wy = 0.0;
        let wz = r.unit() * 10.0 - 5.0;
        let h = 0.1 + r.unit() * 0.9;
        let stiff = 0.4 + r.unit() * 2.0;
        let t = r.unit() * 8.0;
        let mut vx = r.unit() * 2.0 - 1.0;
        let mut vy = r.unit() * 2.0 - 1.0;
        let mut vz = r.unit() * 2.0 - 1.0;
        let vlen = (vx * vx + vy * vy + vz * vz).sqrt().max(1e-3);
        vx /= vlen;
        vy /= vlen;
        vz /= vlen;
        let got = f.floats(
            "foliage_eval",
            [
                dir_x, dir_z, strength, freq, speed, turb, wx, wy, wz, h, stiff, t, vx, vy, vz,
            ],
        );
        let len = dir_x.hypot(dir_z).max(1e-6);
        let (dx, dz) = (dir_x / len, dir_z / len);
        let along = wx * dx + wz * dz;
        let across = wz * dx - wx * dz;
        let primary = 0.5 + 0.5 * (along * freq - t * speed).sin();
        let flutter = (along * freq * 2.7 + across * 1.3 - t * speed * 2.1).sin();
        let gust = (primary + flutter * turb * 0.25).max(0.0);
        let bend = strength * gust * h * h / stiff;
        let cp = (t * (speed * 1.7 + 1.0) + wx * 0.7 + wz * 0.9).sin();
        let ca = bend * turb * 0.2;
        let ox = dx * bend - dz * ca * cp;
        let oz = dz * bend + dx * ca * cp;
        let hsq = ox * ox + oz * oz;
        let oy = -hsq / (2.0 * (1.0 + hsq.sqrt()).max(1.0));
        near_all(&got, &[ox, oy, oz, vx, vy, vz, vx, vy.abs(), vz], 1e-3);
    }
}
