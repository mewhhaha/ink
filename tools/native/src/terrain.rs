use super::*;
pub fn hash(x: u32, y: u32, z: u32, seed: u32) -> u32 {
    let mut h = x.wrapping_mul(2747636419)
        ^ y.wrapping_mul(2654435769)
        ^ z.wrapping_mul(2246822519)
        ^ seed.wrapping_mul(3266489917);
    h ^= h >> 15;
    h = h.wrapping_mul(2246822507);
    h ^= h >> 13;
    h = h.wrapping_mul(3266489909);
    h ^ (h >> 16)
}
pub fn fade(t: f64) -> f64 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}
pub fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}
pub fn perlin(seed: u32, x: f64, y: f64, z: f64) -> f64 {
    let lattice = [x.floor(), y.floor(), z.floor()];
    let f = [x - lattice[0], y - lattice[1], z - lattice[2]];
    let g = |i: i32, j: i32, k: i32| {
        let h = hash(
            (lattice[0] as i32).wrapping_add(i) as u32,
            (lattice[1] as i32).wrapping_add(j) as u32,
            (lattice[2] as i32).wrapping_add(k) as u32,
            seed,
        ) % 12;
        let mut u = if h < 8 {
            f[0] - i as f64
        } else {
            f[1] - j as f64
        };
        let mut v = if h < 4 {
            f[1] - j as f64
        } else {
            f[2] - k as f64
        };
        if h & 1 != 0 {
            u = -u;
        }
        if h & 2 != 0 {
            v = -v;
        }
        u + v
    };
    let [u, v, w] = f.map(fade);
    lerp(
        lerp(
            lerp(g(0, 0, 0), g(1, 0, 0), u),
            lerp(g(0, 1, 0), g(1, 1, 0), u),
            v,
        ),
        lerp(
            lerp(g(0, 0, 1), g(1, 0, 1), u),
            lerp(g(0, 1, 1), g(1, 1, 1), u),
            v,
        ),
        w,
    )
}
pub fn noise(seed: u32, octaves: u32, x: f64, z: f64) -> f64 {
    let (mut sum, mut total, mut amplitude, mut frequency) = (0.0, 0.0, 1.0, 1.0);
    for octave in 0..octaves {
        sum += amplitude
            * perlin(
                seed.wrapping_add(octave * 101),
                x * frequency,
                z * frequency,
                0.5,
            );
        total += amplitude;
        amplitude *= 0.5;
        frequency *= 2.0;
    }
    if total == 0.0 { 0.0 } else { sum / total }
}
#[derive(Clone)]
struct Field {
    cells: usize,
    heights: Vec<f64>,
}
impl Field {
    fn new(cells: usize) -> Self {
        Self {
            cells,
            heights: vec![0.0; (cells + 1) * (cells + 1)],
        }
    }
    fn sample(&self, x: f64, z: f64) -> f64 {
        let cx = x.clamp(0.0, self.cells as f64);
        let cz = z.clamp(0.0, self.cells as f64);
        let x0 = (cx.floor() as usize).min(self.cells - 1);
        let z0 = (cz.floor() as usize).min(self.cells - 1);
        let fx = cx - x0 as f64;
        let fz = cz - z0 as f64;
        let stride = self.cells + 1;
        let i = z0 * stride + x0;
        lerp(
            lerp(self.heights[i], self.heights[i + 1], fx),
            lerp(self.heights[i + stride], self.heights[i + stride + 1], fx),
            fz,
        )
    }
}
#[derive(Clone, Copy)]
struct Detail {
    seed: u32,
    amplitude: f64,
    wavelength: f64,
    octaves: u32,
}
#[derive(Clone)]
struct Scene {
    origin: [f64; 3],
    field: Field,
    size: f64,
    scale: f64,
    detail: Detail,
    cells: usize,
    grid: Vec<f64>,
}
impl Scene {
    fn new(origin: [f64; 3], cells: usize, size: f64, scale: f64, detail: Detail) -> Self {
        let mut field = Field::new(cells);
        for z in 0..=cells {
            for x in 0..=cells {
                field.heights[z * (cells + 1) + x] = f32(6.0
                    * (x as f64 * 0.21 + size).sin()
                    * (z as f64 * 0.17 - size).cos()
                    + 0.8 * (x as f64 * 1.3 + z as f64 * 0.9).sin()
                    + 0.02 * x as f64);
            }
        }
        let mut s = Self {
            origin,
            field,
            size,
            scale,
            detail,
            cells,
            grid: vec![],
        };
        s.regrid();
        s
    }
    fn regrid(&mut self) {
        self.grid = (0..=self.cells)
            .flat_map(|z| (0..=self.cells).map(move |x| (x, z)))
            .map(|(x, z)| {
                f32(self.field.sample(
                    x as f64 * self.field.cells as f64 / self.cells as f64,
                    z as f64 * self.field.cells as f64 / self.cells as f64,
                ) * self.scale)
            })
            .collect();
    }
    fn detail(&self, x: f64, z: f64) -> f64 {
        if self.detail.amplitude == 0.0 || self.detail.octaves == 0 {
            return 0.0;
        }
        let f = 1.0 / self.detail.wavelength.max(1e-3);
        self.detail.amplitude * noise(self.detail.seed, self.detail.octaves, x * f, z * f)
    }
    fn height(&self, x: f64, z: f64) -> f64 {
        let x = x - f32(self.origin[0]);
        let z = z - f32(self.origin[2]);
        let f = self.field.cells as f64 / self.size;
        self.origin[1]
            + self
                .field
                .sample((x + self.size / 2.0) * f, (z + self.size / 2.0) * f)
                * self.scale
            + self.detail(x, z)
    }
    fn normal(&self, x: f64, z: f64, step: f64) -> [f64; 3] {
        let nx = -(self.height(x + step, z) - self.height(x - step, z)) / (2.0 * step);
        let nz = -(self.height(x, z + step) - self.height(x, z - step)) / (2.0 * step);
        let length = (nx * nx + 1.0 + nz * nz).sqrt();
        [nx / length, 1.0 / length, nz / length]
    }
    fn lanes(&self, rows: &[Vec<f64>], extra: [f64; 2]) -> Vec<f64> {
        let mut out = vec![
            self.origin[0],
            self.origin[1],
            self.origin[2],
            self.size,
            self.cells as f64,
            self.detail.amplitude,
            self.detail.wavelength,
            self.detail.octaves as f64,
            self.detail.seed as f64,
            rows.len() as f64,
            rows.first().map_or(0, Vec::len) as f64,
            extra[0],
            extra[1],
            0.0,
            0.0,
            0.0,
        ];
        out.extend(rows.iter().flatten());
        out.extend(&self.grid);
        out
    }
    fn locals(&self, n: usize) -> Vec<[f64; 2]> {
        let half = self.size / 2.0;
        let cell = self.size / self.cells as f64;
        let mut out = vec![
            [0.0, 0.0],
            [-half, -half],
            [half, half],
            [-half, half],
            [half, -half],
            [half - cell, -half + cell],
            [cell * 0.5, cell * 0.5],
            [-cell * 0.25, cell * 3.75],
            [-half * 1.5, 0.0],
            [0.0, half * 2.5],
            [half * 3.0, -half * 3.0],
            [-half - 0.001, half + 0.001],
            [1e-4, -1e-4],
        ];
        for (i, j) in [(0, 0), (1, 0), (0, 1), (5, 7), (self.cells, self.cells)] {
            out.push([-half + i as f64 * cell, -half + j as f64 * cell]);
            out.push([
                -half + (i as f64 + 0.5) * cell,
                -half + (j as f64 + 0.5) * cell,
            ]);
        }
        let mut rng = Random(self.cells as u32 * 31 + self.detail.seed);
        while out.len() < n {
            out.push([
                (rng.unit() * 1.4 - 0.7) * self.size,
                (rng.unit() * 1.4 - 0.7) * self.size,
            ]);
        }
        out
    }
    fn world(&self, p: [f64; 2]) -> [f64; 2] {
        [
            f32(f32(self.origin[0]) + p[0]),
            f32(f32(self.origin[2]) + p[1]),
        ]
    }
}
fn scenes() -> Vec<Scene> {
    vec![
        Scene::new(
            [0.0; 3],
            64,
            512.0,
            2.0,
            Detail {
                seed: 1,
                amplitude: 1.0,
                wavelength: 6.0,
                octaves: 3,
            },
        ),
        Scene::new(
            [10.0, 5.0, -20.0],
            32,
            100.0,
            0.5,
            Detail {
                seed: 77,
                amplitude: 1.0,
                wavelength: 3.7,
                octaves: 5,
            },
        ),
        Scene::new(
            [-300.0, -2.0, 400.0],
            128,
            2048.0,
            1.0,
            Detail {
                seed: 123456,
                amplitude: 0.35,
                wavelength: 11.0,
                octaves: 1,
            },
        ),
        Scene::new(
            [3.0, 1.0, 3.0],
            16,
            64.0,
            1.5,
            Detail {
                seed: 9,
                amplitude: 0.0,
                wavelength: 6.0,
                octaves: 3,
            },
        ),
        Scene::new(
            [0.0; 3],
            16,
            64.0,
            1.0,
            Detail {
                seed: 9,
                amplitude: 1.0,
                wavelength: 6.0,
                octaves: 0,
            },
        ),
        Scene::new(
            [-40.0, 12.0, 25.0],
            48,
            300.0,
            1.0,
            Detail {
                seed: 4093,
                amplitude: 1.0,
                wavelength: 20.0,
                octaves: 6,
            },
        ),
    ]
}
#[test]
fn terrain_noise_and_hashes_match_double_precision_reference() {
    let mut f = Fixture::new("tests/terrain.sq");
    let mut rng = Random(5);
    for seed in [0, 1, 7, 4093] {
        let mut rows = Vec::new();
        for i in 0..250 {
            let big = if i % 10 == 0 { 400.0 } else { 20.0 };
            rows.push([
                (rng.unit() * 2.0 - 1.0) * big,
                (rng.unit() * 2.0 - 1.0) * big,
                (rng.unit() * 2.0 - 1.0) * 3.0,
            ]);
        }
        rows.extend([
            [0.0, 0.0, 0.0],
            [-1.0, -1.0, 0.5],
            [3.0, -7.0, 0.5],
            [-0.25, 0.75, -0.5],
        ]);
        for octaves in [1, 3, 6] {
            let input = [
                vec![seed as f64, octaves as f64, rows.len() as f64],
                rows.iter().flatten().copied().collect(),
            ]
            .concat();
            let out = f.floats("noises", input);
            for (i, p) in rows.iter().enumerate() {
                let [x, y, z] = p.map(f32);
                near(out[i * 2], perlin(seed, x, y, z), 1e-4);
                near(out[i * 2 + 1], noise(seed, octaves, x, y), 1e-4);
            }
        }
    }
    let rows: Vec<[u32; 2]> = (0..40)
        .flat_map(|x| (0..40).map(move |y| [x * 37 % 2000, y * 53 % 2000]))
        .collect();
    for seed in [0, 1, 101, 202, 4093] {
        let input = [
            vec![seed as f64, rows.len() as f64],
            rows.iter().flatten().map(|x| *x as f64).collect(),
        ]
        .concat();
        let out = f.floats("hashes", input);
        for (i, [x, y]) in rows.iter().enumerate() {
            assert_eq!(
                out[i],
                f32((hash(*x, *y, 0, seed) >> 8) as f64 / 16777216.0)
            );
        }
    }
}
#[test]
fn terrain_heights_normals_and_footprints() {
    let mut f = Fixture::new("tests/terrain.sq");
    for s in scenes() {
        let queries: Vec<_> = s.locals(160).into_iter().map(|p| s.world(p)).collect();
        let rows: Vec<_> = queries
            .iter()
            .map(|[x, z]| vec![*x, *z, s.origin[1] + 5.0])
            .collect();
        let out = f.floats("heights", s.lanes(&rows, [0.0; 2]));
        for (i, [x, z]) in queries.iter().enumerate() {
            near(out[i * 4], s.height(*x, *z), 1e-3);
            assert_eq!(out[i * 4 + 2], out[i * 4]);
            near(out[i * 4 + 3], s.origin[1] + 5.0 - out[i * 4], 1e-4);
        }
        let queries: Vec<_> = s.locals(100).into_iter().map(|p| s.world(p)).collect();
        let rows: Vec<_> = queries.iter().map(|p| p.to_vec()).collect();
        for step in [0.5, 2.0, 0.1] {
            let out = f.floats("normals", s.lanes(&rows, [step, 0.0]));
            let tol = if step < 0.2 { 0.05 } else { 2e-3 };
            for (i, [x, z]) in queries.iter().enumerate() {
                let n = s.normal(*x, *z, step);
                let o = i * 9;
                near_all(&out[o..o + 3], &n, tol);
                near(
                    out[o..o + 3].iter().map(|x| x * x).sum::<f64>().sqrt(),
                    1.0,
                    1e-5,
                );
                near(out[o + 6], -n[0] / n[1], tol * 4.0);
                near(out[o + 7], -n[2] / n[1], tol * 4.0);
                if step == 0.5 {
                    assert_eq!(&out[o..o + 3], &out[o + 3..o + 6]);
                    near(out[o + 8], n[0].hypot(n[2]) / n[1], 8e-3);
                }
            }
        }
    }
    let s = &scenes()[1];
    let h = s.size / 2.0;
    let [ox, _, oz] = s.origin;
    let cases = [
        (ox, oz, true),
        (ox + h, oz + h, true),
        (ox - h, oz - h, true),
        (ox + h + 0.01, oz, false),
        (ox, oz - h - 0.01, false),
        (ox + 3.0 * h, oz - 3.0 * h, false),
        (ox - h * 0.5, oz + h * 0.5, true),
    ];
    let rows = cases
        .iter()
        .map(|&(x, z, _)| vec![x, z, 0.0])
        .collect::<Vec<_>>();
    let out = f.floats("heights", s.lanes(&rows, [0.0; 2]));
    for (i, (_, _, inside)) in cases.iter().enumerate() {
        assert_eq!(out[i * 4 + 1] == 1.0, *inside);
    }
    let mut s = Scene::new(
        [0.0, 3.0, 0.0],
        8,
        32.0,
        1.0,
        Detail {
            seed: 1,
            amplitude: 0.0,
            wavelength: 6.0,
            octaves: 3,
        },
    );
    s.field.heights.fill(2.0);
    s.regrid();
    let out = f.floats(
        "normals",
        s.lanes(
            &[vec![1.0, 2.0], vec![-30.0, 30.0], vec![100.0, 100.0]],
            [0.5, 0.0],
        ),
    );
    for i in 0..3 {
        assert_eq!(&out[i * 9..i * 9 + 3], [0.0, 1.0, 0.0]);
        assert_eq!(out[i * 9 + 8], 0.0);
    }
}
#[test]
fn terrain_coarse_grid_follows_fine_field() {
    let mut f = Fixture::new("tests/terrain.sq");
    let mut s = Scene::new(
        [0.0; 3],
        64,
        1024.0,
        1.5,
        Detail {
            seed: 3,
            amplitude: 0.7,
            wavelength: 9.0,
            octaves: 4,
        },
    );
    s.field = Field::new(256);
    for z in 0..=256 {
        for x in 0..=256 {
            s.field.heights[z * 257 + x] =
                f32(4.0 * (x as f64 * 0.03).sin() * (z as f64 * 0.025).cos() + 0.01 * z as f64);
        }
    }
    s.regrid();
    assert_eq!(s.grid.len(), 65 * 65);
    let queries: Vec<_> = s.locals(200).into_iter().map(|p| s.world(p)).collect();
    let rows: Vec<_> = queries.iter().map(|p| vec![p[0], p[1], 0.0]).collect();
    let out = f.floats("heights", s.lanes(&rows, [0.0; 2]));
    let mut same = s.clone();
    same.field = Field {
        cells: 64,
        heights: s.grid.iter().map(|v| f32(v / 1.5)).collect(),
    };
    for (i, [x, z]) in queries.iter().enumerate() {
        near(out[i * 4], same.height(*x, *z), 1e-3);
        near(out[i * 4], s.height(*x, *z), 0.03);
    }
}
#[test]
fn terrain_stand_stick_and_moving_characters() {
    let mut f = Fixture::new("tests/terrain.sq");
    let s = &scenes()[1];
    let lift = 0.9;
    let spots: Vec<_> = s.locals(40).into_iter().map(|p| s.world(p)).collect();
    let heights = [10.0, 0.05, 0.0, -0.2, -30.0];
    let mut rows = Vec::new();
    for [x, z] in &spots {
        for dy in heights {
            rows.push(vec![*x, s.height(*x, *z) + lift + dy, *z]);
        }
    }
    let out = f.floats("stands", s.lanes(&rows, [lift, 0.2]));
    for (spot, [x, z]) in spots.iter().enumerate() {
        for (j, dy) in heights.into_iter().enumerate() {
            let o = (spot * heights.len() + j) * 9;
            let resting = s.height(*x, *z) + lift;
            assert_eq!(out[o], *x);
            assert_eq!(out[o + 2], *z);
            if dy > 0.002 {
                assert_eq!(out[o + 3], 0.0);
                near(out[o + 1], resting + dy, 1e-3);
                assert_eq!(&out[o + 4..o + 7], [0.0, 1.0, 0.0]);
            } else {
                assert_eq!(out[o + 3], 1.0);
                near(out[o + 1], resting, 1e-3);
                assert!(out[o + 5] > 0.0 && out[o + 5] <= 1.0);
            }
            assert_eq!(out[o + 8], if dy <= 0.2 { 1.0 } else { 0.0 });
            near(
                out[o + 7],
                if dy <= 0.2 { resting } else { resting + dy },
                1e-3,
            );
        }
    }
    let mut ramp = Scene::new(
        [0.0; 3],
        32,
        64.0,
        1.0,
        Detail {
            seed: 1,
            amplitude: 0.0,
            wavelength: 6.0,
            octaves: 3,
        },
    );
    for z in 0..=32 {
        for x in 0..=32 {
            ramp.field.heights[z * 33 + x] = f32(-0.3 * (x as f64 * 2.0 - 32.0));
        }
    }
    ramp.regrid();
    let rows = [vec![-20.0, 8.0, 3.0, 6.0, 0.5, 300.0]];
    let held = f.floats("walk", ramp.lanes(&rows, [0.9, 0.25]));
    let hopping = f.floats("walk", ramp.lanes(&rows, [0.9, 0.0]));
    near(held[0], 10.0, 0.05);
    near(held[2], 5.5, 0.05);
    near(held[1] - 0.9, -0.3 * held[0], 2e-3);
    assert_eq!(held[4], 0.0);
    assert_eq!(held[5], 1.0);
    assert!(hopping[4] > 20.0);
    let hill = Scene::new(
        [5.0, 1.0, -3.0],
        16,
        64.0,
        1.0,
        Detail {
            seed: 11,
            amplitude: 0.5,
            wavelength: 5.0,
            octaves: 3,
        },
    );
    let out = f.floats(
        "walk",
        hill.lanes(&[vec![-8.0, 20.0, 4.0, 3.0, 1.0, 400.0]], [0.9, 0.3]),
    );
    near(out[0], -8.0 + 3.0 * 400.0 / 60.0, 0.05);
    near(out[2], 4.0 + 400.0 / 60.0, 0.05);
    assert_eq!(out[5], 1.0);
    near(out[1] - 0.9, hill.height(out[0], out[2]), 2e-3);
}
#[test]
fn terrain_range_contains_sampled_ground_and_missing_grids() {
    let mut f = Fixture::new("tests/terrain.sq");
    for s in scenes() {
        let half = s.size / 2.0;
        let mut rng = Random(s.cells as u32 + 11);
        let mut rects = vec![
            [-half, -half, half, half],
            [-half * 2.0, -half * 2.0, half * 2.0, half * 2.0],
            [half * 1.2, 0.0, half * 2.0, 5.0],
            [0.0; 4],
            [-half, -half, -half, -half],
        ];
        for _ in 0..60 {
            let x = (rng.unit() * 1.6 - 0.8) * half;
            let z = (rng.unit() * 1.6 - 0.8) * half;
            let w = rng.unit() * rng.unit() * half * 0.6;
            let d = rng.unit() * rng.unit() * half * 0.6;
            rects.push([x, z, x + w, z + d]);
        }
        let rows: Vec<Vec<f64>> = rects
            .iter()
            .map(|r| {
                [
                    s.world([r[0], r[1]]).to_vec(),
                    s.world([r[2], r[3]]).to_vec(),
                ]
                .concat()
            })
            .collect();
        let out = f.floats("ranges", s.lanes(&rows, [0.0; 2]));
        for (i, r) in rows.iter().enumerate() {
            let lo = out[2 * i];
            let hi = out[2 * i + 1];
            assert!(lo <= hi);
            for a in 0..=8 {
                for b in 0..=8 {
                    let x = r[0] + (r[2] - r[0]) * a as f64 / 8.0;
                    let z = r[1] + (r[3] - r[1]) * b as f64 / 8.0;
                    let h = s.height(x, z);
                    assert!(h >= lo - 1e-3 && h <= hi + 1e-3, "{h} outside [{lo}, {hi}]");
                }
            }
        }
    }
    let s = &scenes()[3];
    let cell = s.size / s.cells as f64;
    let half = s.size / 2.0;
    let x = s.origin[0] - half + 4.2 * cell;
    let z = s.origin[2] - half + 6.3 * cell;
    let out = f.floats(
        "ranges",
        s.lanes(&[vec![x, z, x + cell * 0.5, z + cell * 0.4]], [0.0; 2]),
    );
    let corners =
        [(4, 6), (5, 6), (4, 7), (5, 7)].map(|(i, j)| s.origin[1] + s.grid[j * (s.cells + 1) + i]);
    near(
        out[0],
        corners.into_iter().fold(f64::INFINITY, f64::min),
        1e-4,
    );
    near(
        out[1],
        corners.into_iter().fold(f64::NEG_INFINITY, f64::max),
        1e-4,
    );
    let mut s = Scene::new(
        [0.0; 3],
        8,
        4096.0,
        1.0,
        Detail {
            seed: 21,
            amplitude: 3.0,
            wavelength: 5.0,
            octaves: 4,
        },
    );
    s.field.heights.fill(0.0);
    s.regrid();
    let mut rng = Random(2);
    let rows: Vec<_> = (0..4000)
        .map(|_| {
            vec![
                (rng.unit() - 0.5) * 3000.0,
                (rng.unit() - 0.5) * 3000.0,
                0.0,
            ]
        })
        .collect();
    let out = f.floats("heights", s.lanes(&rows, [0.0; 2]));
    let range = f.floats(
        "ranges",
        s.lanes(&[vec![-2048.0, -2048.0, 2048.0, 2048.0]], [0.0; 2]),
    );
    let lo = out.iter().step_by(4).copied().fold(f64::INFINITY, f64::min);
    let hi = out
        .iter()
        .step_by(4)
        .copied()
        .fold(f64::NEG_INFINITY, f64::max);
    assert!(lo >= range[0] && hi <= range[1] && hi > 1.5 && lo < -1.5);
    let s = &scenes()[1];
    for grid in [vec![], vec![7.0; 5], s.grid[..33 * 33 - 1].to_vec()] {
        let mut short = s.clone();
        short.grid = grid;
        let rows = vec![
            vec![s.origin[0], s.origin[2], 0.0],
            vec![s.origin[0] + 9.0, s.origin[2] - 4.0, 0.0],
        ];
        let out = f.floats("heights", short.lanes(&rows, [0.0; 2]));
        for (i, r) in rows.iter().enumerate() {
            near(
                out[i * 4],
                s.origin[1] + s.detail(r[0] - s.origin[0], r[1] - s.origin[2]),
                1e-3,
            );
        }
        let range = f.floats(
            "ranges",
            short.lanes(&[vec![-50.0, -50.0, 50.0, 50.0]], [0.0; 2]),
        );
        near(range[0], s.origin[1] - 1.04 * s.detail.amplitude, 1e-4);
        near(range[1], s.origin[1] + 1.04 * s.detail.amplitude, 1e-4);
    }
}
