// Independent f64 references for the surface lobes of ink/lighting: the dielectric
// f0 and f90, the clear coat (Kelemen visibility, Fresnel, layering and the
// image-based form), Charlie sheen with Neubelt visibility and its directional
// albedo table, anisotropic GGX with the bent reflection normal, refraction,
// Beer-Lambert volumes and the transmitted light, the subsurface diffuse and
// parallax occlusion mapping. They are written from the formulas of the
// materials contract (Pen's WGSL library follows the same ones), not from the
// Blot, and use f64 throughout: Blot's arithmetic is F32, so agreement is to
// F32's precision (and to its `color.power`'s, about 1e-6 relative) and not by
// construction. Blot blends `a + (b - a) t`; this blends `a (1 - t) + b t`.
use crate::*;
use std::f64::consts::PI;
use std::sync::OnceLock;

type V = [f64; 3];
const WHITE: V = [1.0; 3];
const BLACK: V = [0.0; 3];

fn f32_of(x: f64) -> f64 {
    f64::from(x as f32)
}
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
fn scale(a: V, s: f64) -> V {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn length(a: V) -> f64 {
    dot(a, a).sqrt()
}
/// A unit vector; a zero vector stays zero.
fn unit(a: V) -> V {
    let l = length(a);
    if l == 0.0 { a } else { scale(a, 1.0 / l) }
}
fn sat(x: f64) -> f64 {
    x.clamp(0.0, 1.0)
}
fn mix(a: f64, b: f64, t: f64) -> f64 {
    a * (1.0 - t) + b * t
}
fn max3(a: V) -> f64 {
    a[0].max(a[1]).max(a[2])
}

/// A surface's 29 lanes in the order `tests/surface.blot` reads them.
#[derive(Clone, Copy, Debug)]
struct Surface {
    base: V,
    metallic: f64,
    roughness: f64,
    ior: f64,
    specular: f64,
    specular_color: V,
    coat: f64,
    coat_roughness: f64,
    sheen_color: V,
    sheen_roughness: f64,
    anisotropy: f64,
    rotation: f64,
    transmission: f64,
    thickness: f64,
    attenuation_color: V,
    attenuation_distance: f64,
    subsurface: f64,
    subsurface_color: V,
    thin: f64,
}
impl Surface {
    /// A material with every extra lobe off (the glTF defaults).
    fn plain(base: V, metallic: f64, roughness: f64) -> Self {
        Surface {
            base,
            metallic,
            roughness,
            ior: 1.5,
            specular: 1.0,
            specular_color: WHITE,
            coat: 0.0,
            coat_roughness: 0.0,
            sheen_color: BLACK,
            sheen_roughness: 0.5,
            anisotropy: 0.0,
            rotation: 0.0,
            transmission: 0.0,
            thickness: 0.0,
            attenuation_color: WHITE,
            attenuation_distance: 0.0,
            subsurface: 0.0,
            subsurface_color: WHITE,
            thin: 1.0,
        }
    }
    fn lanes(&self) -> Vec<f64> {
        let mut a = Vec::new();
        a.extend(self.base);
        a.extend([self.metallic, self.roughness, self.ior, self.specular]);
        a.extend(self.specular_color);
        a.extend([self.coat, self.coat_roughness]);
        a.extend(self.sheen_color);
        a.extend([self.sheen_roughness, self.anisotropy, self.rotation]);
        a.extend([self.transmission, self.thickness]);
        a.extend(self.attenuation_color);
        a.extend([self.attenuation_distance, self.subsurface]);
        a.extend(self.subsurface_color);
        a.push(self.thin);
        assert_eq!(a.len(), 29);
        a
    }
}
/// The frame's 13 lanes: normal, coat normal, tangent, handedness, view.
#[derive(Clone, Copy, Debug)]
struct Frame {
    normal: V,
    coat_normal: V,
    tangent: V,
    handedness: f64,
    view: V,
}
impl Frame {
    fn new(normal: V, view: V) -> Self {
        Frame {
            normal,
            coat_normal: BLACK,
            tangent: BLACK,
            handedness: 1.0,
            view,
        }
    }
    fn lanes(&self) -> Vec<f64> {
        [
            self.normal.to_vec(),
            self.coat_normal.to_vec(),
            self.tangent.to_vec(),
            vec![self.handedness],
            self.view.to_vec(),
        ]
        .concat()
    }
}
/// The input of Blot's `surface` entry: surface, frame, light, radiance.
fn surface_input(s: &Surface, f: &Frame, light: V, radiance: V) -> Vec<f64> {
    [s.lanes(), f.lanes(), light.to_vec(), radiance.to_vec()].concat()
}

// ---------------------------------------------------------------- the base

/// The dielectric's face-on reflectance in one channel.
fn f0_dielectric(ior: f64, specular: f64, tint: f64) -> f64 {
    let n = ior.max(1.0);
    (((n - 1.0) / (n + 1.0)).powi(2) * tint).min(1.0) * specular
}
fn f0(s: &Surface, c: usize) -> f64 {
    mix(
        f0_dielectric(s.ior, s.specular, s.specular_color[c]),
        s.base[c],
        sat(s.metallic),
    )
}
fn f90(s: &Surface) -> f64 {
    mix(s.specular, 1.0, sat(s.metallic))
}
fn fresnel(s: &Surface, c: usize, vh: f64) -> f64 {
    f0(s, c) + (f90(s) - f0(s, c)) * (1.0 - vh).powi(5)
}
/// GGX's normal distribution and height-correlated Smith visibility, for the
/// `alpha` of the contract (perceptual roughness squared).
fn ggx_d(nh: f64, alpha: f64) -> f64 {
    let a2 = alpha * alpha;
    a2 / (PI * (nh * nh * (a2 - 1.0) + 1.0).powi(2))
}
fn smith_v(nl: f64, nv: f64, alpha: f64) -> f64 {
    let a2 = alpha * alpha;
    0.5 / (nl * (nv * nv * (1.0 - a2) + a2).sqrt() + nv * (nl * nl * (1.0 - a2) + a2).sqrt())
        .max(1e-6)
}

// ---------------------------------------------------------------- anisotropy

/// A unit vector perpendicular to the unit `n`: its cross product with the
/// coordinate axis it is least along (the first, on ties).
fn perpendicular(n: V) -> V {
    let axis = (0..3)
        .min_by(|&a, &b| n[a].abs().partial_cmp(&n[b].abs()).unwrap())
        .unwrap();
    let mut e = BLACK;
    e[axis] = 1.0;
    unit(cross(n, e))
}
/// The tangent and bitangent: the mesh tangent made perpendicular to `n`,
/// turned about it by `rho`, and `n x t` times the handedness.
fn tangent_frame(n: V, tangent: V, handedness: f64, rho: f64) -> (V, V) {
    let t0 = unit(tangent);
    let o = sub(t0, scale(n, dot(n, t0)));
    let o = if length(o) > 1e-6 {
        unit(o)
    } else {
        perpendicular(n)
    };
    let t = add(scale(o, rho.cos()), scale(cross(n, o), rho.sin()));
    (t, scale(cross(n, t), handedness))
}
fn aniso_d(at: f64, ab: f64, th: f64, bh: f64, nh: f64) -> f64 {
    1.0 / (PI * at * ab) / ((th / at).powi(2) + (bh / ab).powi(2) + nh * nh).powi(2)
}
fn aniso_v(at: f64, ab: f64, l: [f64; 3], v: [f64; 3]) -> f64 {
    // `l` and `v` are the (tangent, bitangent, normal) parts of the light and view.
    let ll = length([at * l[0], ab * l[1], l[2]]);
    let vl = length([at * v[0], ab * v[1], v[2]]);
    0.5 / (v[2] * ll + l[2] * vl).max(1e-6)
}
/// The direction image-based light is looked up in for anisotropy `a` (the
/// view reflected about the bent normal), and the bent normal.
fn bent_normal(n: V, v: V, t: V, b: V, a: f64, roughness: f64) -> V {
    let grain = if a >= 0.0 { b } else { t };
    let bent = cross(cross(grain, v), grain);
    let w = a.abs() * (5.0 * roughness.clamp(0.04, 1.0)).clamp(0.0, 1.0);
    let m = unit([
        mix(n[0], bent[0], w),
        mix(n[1], bent[1], w),
        mix(n[2], bent[2], w),
    ]);
    if length(m) == 0.0 { n } else { m }
}
fn reflect_about(v: V, n: V) -> V {
    sub(scale(n, 2.0 * dot(n, v)), v)
}

// ---------------------------------------------------------------- the sheen

fn charlie_d(nh: f64, alpha: f64) -> f64 {
    (2.0 + 1.0 / alpha) * (1.0 - nh * nh).max(0.0).powf(0.5 / alpha) / (2.0 * PI)
}
fn neubelt_v(nl: f64, nv: f64) -> f64 {
    1.0 / (4.0 * (nl + nv - nl * nv))
}
const TABLE_NV: usize = 32;
const TABLE_ROUGHNESS: usize = 16;
/// The sheen lobe's directional albedo for a white tint, `integral of D V nl`
/// over the hemisphere of lights, capped at 1, by midpoint quadrature in the
/// cosine of the light and its azimuth (the lobe is mirror symmetric about the
/// view's plane, so half the azimuths are summed and doubled), `steps` each.
fn sheen_albedo_exact(nv: f64, roughness: f64, steps: usize) -> f64 {
    let nv = nv.clamp(1e-5, 1.0);
    let alpha = roughness.clamp(0.07, 1.0).powi(2);
    let v = [(1.0 - nv * nv).sqrt(), 0.0, nv];
    let mut sum = 0.0;
    for i in 0..steps {
        let nl = (i as f64 + 0.5) / steps as f64;
        let ring = (1.0 - nl * nl).sqrt();
        for j in 0..steps {
            let phi = (j as f64 + 0.5) * PI / steps as f64;
            let l = [ring * phi.cos(), ring * phi.sin(), nl];
            let h = unit(add(v, l));
            sum += charlie_d(h[2].clamp(0.0, 1.0), alpha) * neubelt_v(nl, nv) * nl;
        }
    }
    (2.0 * sum * (PI / steps as f64) / steps as f64).min(1.0)
}
/// The node values of the table the Blot carries: 32 columns evenly spaced in
/// sqrt(nv) and 16 rows in sqrt((roughness - 0.07) / 0.93), row major.
fn sheen_table_node(row: usize, column: usize, steps: usize) -> f64 {
    let s = column as f64 / (TABLE_NV - 1) as f64;
    let t = row as f64 / (TABLE_ROUGHNESS - 1) as f64;
    sheen_albedo_exact(s * s, 0.07 + 0.93 * t * t, steps)
}
const TABLE_STEPS: usize = 256;
fn sheen_table() -> &'static Vec<f64> {
    static TABLE: OnceLock<Vec<f64>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let rows: Vec<Vec<f64>> = std::thread::scope(|scope| {
            (0..TABLE_ROUGHNESS)
                .map(|row| {
                    scope.spawn(move || {
                        (0..TABLE_NV)
                            .map(|column| sheen_table_node(row, column, TABLE_STEPS))
                            .collect::<Vec<f64>>()
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect()
        });
        rows.concat()
    })
}
/// The table read bilinearly at `nv` and `roughness`.
fn sheen_albedo(nv: f64, roughness: f64) -> f64 {
    let table = sheen_table();
    let x = sat(nv).sqrt() * (TABLE_NV - 1) as f64;
    let y = sat((roughness.clamp(0.07, 1.0) - 0.07) / 0.93).sqrt() * (TABLE_ROUGHNESS - 1) as f64;
    let (i, j) = (
        (x.floor() as usize).min(TABLE_NV - 2),
        (y.floor() as usize).min(TABLE_ROUGHNESS - 2),
    );
    let (fx, fy) = (x - i as f64, y - j as f64);
    let at = |row: usize, column: usize| table[row * TABLE_NV + column];
    mix(
        mix(at(j, i), at(j, i + 1), fx),
        mix(at(j + 1, i), at(j + 1, i + 1), fx),
        fy,
    )
}

// ---------------------------------------------------------------- the whole response

/// One light's response of a surface, per unit radiance with NoL included,
/// following the contract term by term: base lobes (the diffuse with its
/// subsurface wrap and back light, scaled by what the transmission passes, and
/// the specular lobe, isotropic or anisotropic), layered under the sheen and
/// the coat, then the sheen and the coat added. `grain` forces the anisotropic
/// specular lobe.
fn response_with(s: &Surface, f: &Frame, light: V, grain: bool) -> V {
    let n = unit(f.normal);
    let v = unit(f.view);
    let l = unit(light);
    let facing = dot(n, v);
    if facing <= 0.0 || length(l) == 0.0 {
        return BLACK;
    }
    let nv = facing.max(1e-5);
    let signed = dot(n, l);
    let nl = sat(signed);
    let h = unit(add(v, l));
    let nh = sat(dot(n, h));
    let vh = sat(dot(v, h));
    let alpha = s.roughness.clamp(0.04, 1.0).powi(2);
    // the specular distribution and visibility
    let a = s.anisotropy.clamp(-1.0, 1.0);
    let shape = if grain || a != 0.0 {
        let (t, b) = tangent_frame(n, f.tangent, f.handedness, s.rotation);
        let at = mix(alpha, 1.0, a * a);
        aniso_d(at, alpha, dot(t, h), dot(b, h), nh)
            * aniso_v(
                at,
                alpha,
                [dot(t, l), dot(b, l), nl],
                [dot(t, v), dot(b, v), nv],
            )
    } else {
        ggx_d(nh, alpha) * smith_v(nl, nv, alpha)
    };
    // the sheen and the coat
    let (mut sheen, mut sheen_keep) = (BLACK, 1.0);
    if max3(s.sheen_color) > 0.0 {
        let rs = s.sheen_roughness.clamp(0.07, 1.0);
        let lobe = charlie_d(nh, rs * rs) * neubelt_v(nl, nv) * nl;
        sheen = scale(
            [
                s.sheen_color[0].max(0.0),
                s.sheen_color[1].max(0.0),
                s.sheen_color[2].max(0.0),
            ],
            lobe,
        );
        sheen_keep = (1.0 - max3(s.sheen_color) * sheen_albedo(nv, rs)).max(0.0);
    }
    let (mut coat, mut coat_keep) = (0.0, 1.0);
    let weight = sat(s.coat);
    if weight > 0.0 {
        let nc = if length(f.coat_normal) == 0.0 {
            n
        } else {
            unit(f.coat_normal)
        };
        let (gloss, keep) = coat_lobe(weight, s.coat_roughness, nc, h, l, vh);
        coat = gloss;
        coat_keep = keep;
    }
    // the light the diffuse lobe takes from behind
    let back = if sat(s.subsurface) > 0.0 {
        sat(-dot(v, unit(add(l, scale(n, 0.2))))).powi(4)
    } else {
        0.0
    };
    let pass = sat(s.transmission);
    let mut out = BLACK;
    for c in 0..3 {
        let specular = fresnel(s, c, vh) * shape * nl;
        let inner = (diffuse_channel(s, c, vh, signed, back) * (1.0 - pass) + specular)
            * sheen_keep
            * coat_keep;
        out[c] = inner + sheen[c] + coat;
    }
    out
}
/// One channel of the diffuse lobe with its subsurface: Lambert's `base (1 -
/// F) (1 - metallic) / pi` times the lit part, running from the clamped cosine
/// to the wrapped one tinted by the subsurface colour as `amount` rises, plus
/// the light coming through, `amount tint (1 - thin) back base / pi 2`.
fn diffuse_channel(s: &Surface, c: usize, vh: f64, signed: f64, back: f64) -> f64 {
    let amount = sat(s.subsurface);
    let tint = s.subsurface_color[c];
    let lit =
        (1.0 - amount) * signed.max(0.0) + amount * wrap(signed, 0.5) * sat(tint + signed.max(0.0));
    s.base[c] * (1.0 - fresnel(s, c, vh)) * (1.0 - sat(s.metallic)) / PI * lit
        + amount * tint * (1.0 - sat(s.thin)) * back * s.base[c] / PI * 2.0
}
/// The diffuse lobe alone for one light, as `lighting.subsurface_response`.
fn subsurface_diffuse(s: &Surface, f: &Frame, light: V) -> V {
    let (n, v, l) = (unit(f.normal), unit(f.view), unit(light));
    if dot(n, v) <= 0.0 || length(l) == 0.0 {
        return BLACK;
    }
    let vh = sat(dot(v, unit(add(v, l))));
    let back = if sat(s.subsurface) > 0.0 {
        sat(-dot(v, unit(add(l, scale(n, 0.2))))).powi(4)
    } else {
        0.0
    };
    std::array::from_fn(|c| diffuse_channel(s, c, vh, dot(n, l), back))
}
fn response(s: &Surface, f: &Frame, light: V) -> V {
    response_with(s, f, light, false)
}
fn wrap(x: f64, w: f64) -> f64 {
    sat((x + w) / ((1.0 + w) * (1.0 + w)))
}
/// The clear coat's own response and what it leaves the layers below: Kelemen's
/// visibility 0.25 / max(vh^2, 1e-4), Fc = 0.04 + 0.96 (1 - vh)^5.
fn coat_lobe(weight: f64, roughness: f64, nc: V, h: V, l: V, vh: f64) -> (f64, f64) {
    let alpha = roughness.clamp(0.04, 1.0).powi(2);
    let fc = 0.04 + 0.96 * (1.0 - vh).powi(5);
    let d = ggx_d(sat(dot(nc, h)), alpha);
    let v = 0.25 / (vh * vh).max(1e-4);
    (weight * fc * d * v * sat(dot(nc, l)), 1.0 - weight * fc)
}

// ---------------------------------------------------------------- transmission

/// GLSL's and WGSL's `refract`: the zero vector at total internal reflection.
fn refract(i: V, n: V, eta: f64) -> V {
    let d = dot(n, i);
    let k = 1.0 - eta * eta * (1.0 - d * d);
    if k < 0.0 {
        BLACK
    } else {
        sub(scale(i, eta), scale(n, eta * d + k.sqrt()))
    }
}
/// The mip level of the opaque picture.
fn transmission_level(width: f64, last: f64, roughness: f64, ior: f64) -> f64 {
    let r = roughness.clamp(0.04, 1.0);
    (width.log2() * (r * (2.0 * ior - 2.0).clamp(0.0, 1.0)).clamp(0.0, 1.0)).min(last)
}
/// The share of the picture behind that shows through: `tr T` with
/// `T = behind base attenuation (1 - Fspec) (1 - metallic)` per channel and
/// Fspec = f0 * split.x + split.y.
fn transmitted(s: &Surface, behind: V, attenuation: V, split: [f64; 2]) -> V {
    std::array::from_fn(|c| {
        sat(s.transmission)
            * (behind[c]
                * s.base[c]
                * attenuation[c]
                * (1.0 - (f0(s, c) * split[0] + split[1]))
                * (1.0 - sat(s.metallic)))
    })
}
/// The split-sum table's value (scale on f0, bias) by importance-free
/// quadrature of the GGX lobe: `integral of V D nl (1 - Fc, Fc) dl`, Fc =
/// (1 - vh)^5, over the hemisphere of lights.
fn split_sum(nv: f64, roughness: f64, steps: usize) -> [f64; 2] {
    let nv = nv.clamp(1e-4, 1.0);
    let alpha = roughness.clamp(0.04, 1.0).powi(2);
    let v = [(1.0 - nv * nv).sqrt(), 0.0, nv];
    let (mut scale_sum, mut bias_sum) = (0.0, 0.0);
    for i in 0..steps {
        let nl = (i as f64 + 0.5) / steps as f64;
        let ring = (1.0 - nl * nl).sqrt();
        for j in 0..steps {
            let phi = (j as f64 + 0.5) * PI / steps as f64;
            let l = [ring * phi.cos(), ring * phi.sin(), nl];
            let h = unit(add(v, l));
            let vh = sat(dot(v, h));
            let lobe = ggx_d(sat(h[2]), alpha) * smith_v(nl, nv, alpha) * nl;
            let fc = (1.0 - vh).powi(5);
            scale_sum += lobe * (1.0 - fc);
            bias_sum += lobe * fc;
        }
    }
    let cell = 2.0 * (PI / steps as f64) / steps as f64;
    [scale_sum * cell, bias_sum * cell]
}

// ---------------------------------------------------------------- parallax

/// How many layers a march takes: floor(mix(32, 8, |cosine|)).
fn layers(cosine: f64) -> usize {
    mix(32.0, 8.0, cosine.abs().min(1.0)).floor() as usize
}
/// The displaced coordinates by the steep search and one linear refinement:
/// layer k of N lies at depth k / N and at (u, v) - view.xy / z * scale * k /
/// N; the first layer whose ray height 1 - k / N is at or below the sampled
/// height is the hit, refined along the segment from the layer before it.
fn parallax_uv(
    height: &dyn Fn(f64, f64) -> f64,
    u: f64,
    v: f64,
    view: V,
    scale: f64,
) -> (f64, f64) {
    let t = unit(view);
    if t[2] <= 0.0 {
        return (u, v);
    }
    let n = layers(t[2]);
    let z = t[2].max(1e-4);
    let at = |k: usize| {
        let step = k as f64 / n as f64;
        (u - t[0] / z * scale * step, v - t[1] / z * scale * step)
    };
    let gap = |k: usize| {
        let (cu, cv) = at(k);
        height(cu, cv).clamp(0.0, 1.0) - (1.0 - k as f64 / n as f64)
    };
    for k in 0..=n {
        let after = gap(k);
        if after >= 0.0 {
            if k == 0 {
                return at(0);
            }
            let before = gap(k - 1);
            let w = after / (after - before);
            let (a, b) = (at(k), at(k - 1));
            return (mix(a.0, b.0, w), mix(a.1, b.1, w));
        }
    }
    at(n)
}
/// The self-shadow of the point (u, v): the light's ray rises from the
/// surface height h over layers k = 1..N at (u, v) + light.xy / z * scale *
/// (1 - h) * k / N, and the shadow is `1 - saturate(8 * worst)` with `worst`
/// the most any sampled height stands above the ray, or 0.
fn parallax_shadow(height: &dyn Fn(f64, f64) -> f64, u: f64, v: f64, light: V, scale: f64) -> f64 {
    let t = unit(light);
    if t[2] <= 0.0 {
        return 0.0;
    }
    let n = layers(t[2]);
    let z = t[2].max(1e-4);
    let start = height(u, v).clamp(0.0, 1.0);
    let rise = 1.0 - start;
    let mut worst: f64 = 0.0;
    for k in 1..=n {
        let along = k as f64 / n as f64;
        let sampled = height(
            u + t[0] / z * scale * rise * along,
            v + t[1] / z * scale * rise * along,
        );
        worst = worst.max(sampled.clamp(0.0, 1.0) - (start + rise * along));
    }
    1.0 - sat(8.0 * worst)
}

// ---------------------------------------------------------------- quadrature

/// The albedo of a response: the sum over a midpoint grid of `n` cosines
/// (0 to 1, or -1 to 1 for the `sphere`) by `2n` azimuths about +Y, as the
/// Blot `albedo` entry sums it.
fn integrate(n: usize, sphere: bool, f: &dyn Fn(V) -> V) -> V {
    let low = if sphere { -1.0 } else { 0.0 };
    let mut total = BLACK;
    for i in 0..n {
        let cosine = low + (1.0 - low) * (i as f64 + 0.5) / n as f64;
        let radial = (1.0 - cosine * cosine).max(0.0).sqrt();
        for j in 0..2 * n {
            let phi = (j as f64 + 0.5) * PI / n as f64;
            total = add(total, f([phi.cos() * radial, cosine, phi.sin() * radial]));
        }
    }
    scale(total, (1.0 - low) * PI / (n * n) as f64)
}

// ---------------------------------------------------------------- the tests

fn fixture() -> Fixture {
    Fixture::new("tests/surface.blot")
}
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
    /// A value an F32 holds exactly, so that both sides see the same input.
    fn between(&mut self, low: f64, high: f64) -> f64 {
        f32_of(low + (high - low) * self.next())
    }
    fn chance(&mut self, p: f64) -> bool {
        self.next() < p
    }
    fn direction(&mut self) -> V {
        let z = self.between(-1.0, 1.0);
        let phi = self.between(0.0, 2.0 * PI);
        let r = (1.0 - z * z).sqrt();
        [f32_of(r * phi.cos()), f32_of(r * phi.sin()), f32_of(z)]
    }
    /// A direction above the plane with normal `n`, at most `spread` radians (cosine) from it.
    fn above(&mut self, n: V, floor: f64) -> V {
        loop {
            let d = self.direction();
            if dot(d, unit(n)) >= floor {
                return d;
            }
        }
    }
}
fn within(got: &[f64], want: &[f64], relative: f64, absolute: f64) -> bool {
    got.len() == want.len()
        && got
            .iter()
            .zip(want)
            .all(|(g, w)| (g - w).abs() <= relative * w.abs() + absolute)
}

/// A random surface; with `lobes` each extra group is on half the time.
fn random_surface(rng: &mut Lcg, lobes: bool) -> Surface {
    let mut s = Surface::plain(
        [
            rng.between(0.02, 1.0),
            rng.between(0.02, 1.0),
            rng.between(0.02, 1.0),
        ],
        if rng.chance(0.3) {
            f32_of(f64::from(rng.chance(0.5) as u8))
        } else {
            rng.between(0.0, 1.0)
        },
        if rng.chance(0.15) {
            f32_of(f64::from(rng.chance(0.5) as u8))
        } else {
            rng.between(0.0, 1.0)
        },
    );
    s.ior = rng.between(1.0, 2.6);
    s.specular = rng.between(0.0, 1.0);
    s.specular_color = [
        rng.between(0.0, 1.0),
        rng.between(0.0, 1.0),
        rng.between(0.0, 1.0),
    ];
    if lobes {
        if rng.chance(0.5) {
            s.coat = rng.between(0.05, 1.0);
        }
        s.coat_roughness = rng.between(0.0, 1.0);
        if rng.chance(0.5) {
            s.sheen_color = [
                rng.between(0.0, 1.0),
                rng.between(0.0, 1.0),
                rng.between(0.0, 1.0),
            ];
        }
        s.sheen_roughness = rng.between(0.0, 1.0);
        if rng.chance(0.5) {
            s.anisotropy = rng.between(-1.0, 1.0);
        }
        s.rotation = rng.between(-PI, PI);
        if rng.chance(0.5) {
            s.transmission = rng.between(0.05, 1.0);
        }
        s.thickness = rng.between(0.0, 2.0);
        s.attenuation_color = [
            rng.between(0.1, 1.0),
            rng.between(0.1, 1.0),
            rng.between(0.1, 1.0),
        ];
        s.attenuation_distance = rng.between(0.0, 3.0);
        if rng.chance(0.5) {
            s.subsurface = rng.between(0.05, 1.0);
        }
        s.subsurface_color = [
            rng.between(0.0, 1.0),
            rng.between(0.0, 1.0),
            rng.between(0.0, 1.0),
        ];
        s.thin = rng.between(0.0, 1.0);
    }
    s
}
/// A random frame seen from above (back-facing views now and then), with a
/// tangent that is sometimes missing or along the normal.
fn random_frame(rng: &mut Lcg) -> Frame {
    let normal = rng.direction();
    let view = if rng.chance(0.05) {
        rng.direction()
    } else {
        rng.above(normal, 0.02)
    };
    let mut f = Frame::new(normal, view);
    if rng.chance(0.4) {
        f.coat_normal = rng.above(normal, 0.6);
    }
    f.tangent = match rng.next() {
        x if x < 0.1 => BLACK,
        x if x < 0.2 => scale(normal, 1.0),
        _ => rng.direction(),
    };
    f.handedness = if rng.chance(0.5) { 1.0 } else { -1.0 };
    f
}
fn shade_one(f: &mut Fixture, s: &Surface, fr: &Frame, light: V) -> V {
    let r = f.floats("surface", surface_input(s, fr, light, WHITE));
    [r[0], r[1], r[2]]
}

fn sheen_table_block() -> String {
    let table = sheen_table();
    let mut block = String::from("const sheen_table: #[F32] = #[\n");
    for row in table.chunks(8) {
        let line: Vec<String> = row.iter().map(|x| format!("{x:.8}")).collect();
        block += &format!("  {},\n", line.join(", "));
    }
    block + "]\n"
}
const TABLE_BEGIN: &str = "// sheen-table:begin\n";
const TABLE_END: &str = "// sheen-table:end\n";
#[test]
fn sheen_table_in_the_source_is_the_quadrature() {
    let path = root().join("lib/lighting.blot");
    let source = std::fs::read_to_string(&path).unwrap();
    let begin = source.find(TABLE_BEGIN).unwrap() + TABLE_BEGIN.len();
    let end = source.find(TABLE_END).unwrap();
    let want = sheen_table_block();
    if std::env::var_os("INK_WRITE_SHEEN_TABLE").is_some() {
        std::fs::write(
            &path,
            format!("{}{}{}", &source[..begin], want, &source[end..]),
        )
        .unwrap();
        return;
    }
    let numbers = |block: &str| -> Vec<f64> {
        block
            .split(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
            .filter(|word| word.contains('.'))
            .map(|word| word.parse().unwrap())
            .collect()
    };
    let (found, expected) = (numbers(&source[begin..end]), numbers(&want));
    assert_eq!(found.len(), TABLE_NV * TABLE_ROUGHNESS);
    near_all(&found, &expected, 1e-8);
}

fn fnv(hash: &mut u64, x: f64) {
    for byte in (x as f32).to_bits().to_le_bytes() {
        *hash ^= u64::from(byte);
        *hash = hash.wrapping_mul(0x100000001b3);
    }
}
#[test]
fn plain_materials_keep_their_bits_and_f0_is_the_gltf_default() {
    let mut f = fixture();
    // 3888 brdf and shade results of the library before the lobes existed
    // (commit ddcdd2a), hashed over their F32 bits.
    let bases = [[0.8, 0.3, 0.05], [1., 1., 1.], [0.02, 0.5, 0.9]];
    let roughness = [0., 0.04, 0.2, 0.5, 1., 1.7];
    let normals = [[0., 1., 0.], [0.3, 0.9, -0.2], [0., 0., 0.]];
    let views = [[0., 1., 0.], [1., 0.1, 0.], [0.4, 0.3, 0.8], [0., -1., 0.]];
    let lights = [
        [0., 1., 0.],
        [0.3, 0.5, -0.2],
        [0., -1., 0.],
        [1., 0., 0.],
        [0., 0., 0.],
        [-0.5, 0.01, 0.2],
    ];
    let (mut hash, mut count) = (0xcbf29ce484222325u64, 0);
    for b in bases {
        for m in [0., 0.3, 1.] {
            for r in roughness {
                for n in normals {
                    for v in views {
                        for l in lights {
                            let a = [
                                b.to_vec(),
                                vec![m, r],
                                n.to_vec(),
                                v.to_vec(),
                                l.to_vec(),
                                vec![2., 1.5, 0.5],
                            ]
                            .concat();
                            let out = f.floats("plain", a);
                            if count == 0 {
                                assert_eq!(
                                    out,
                                    [
                                        1240.7335205078125,
                                        1240.5806884765625,
                                        1240.5042724609375,
                                        2481.467041015625,
                                        1860.87109375,
                                        620.2521362304688
                                    ]
                                );
                            }
                            out.iter().for_each(|x| fnv(&mut hash, *x));
                            count += 1;
                        }
                    }
                }
            }
        }
    }
    assert_eq!((count, hash), (3888, 0x9ec3b08da86b6657));
    // f0 = ((ior - 1) / (ior + 1))^2: exactly the F32 0.04 for 1.5 (and for the
    // default material), and the glTF numbers for other indices.
    let r = f.floats("f0", [1.5, 1., 1.]);
    assert_eq!(r, [f32_of(0.04), f32_of(0.04)]);
    for (ior, want) in [
        (1.0, 0.0),
        (0.5, 0.0),
        (1.33, 0.020059312199524774),
        (2.4, 0.1695501730103806),
    ] {
        near(f.floats("f0", [ior, 1., 1.])[0], want, 1e-7);
    }
    near(f.floats("f0", [1.5, 0.5, 0.5])[0], 0.01, 1e-8);
    near(f.floats("f0", [2.4, 0.5, 100.])[0], 0.5, 0.0);
    near(f.floats("f0", [1.5, 0., 1.])[0], 0.0, 0.0);
}

#[test]
fn surfaces_with_no_lobes_are_brdf_bit_for_bit() {
    let mut f = fixture();
    let mut rng = Lcg(11);
    let mut compared = 0;
    for case in 0..600 {
        // Every group at weight 0 though its other numbers are set: still brdf.
        let mut s = random_surface(&mut rng, true);
        s.coat = 0.0;
        s.sheen_color = BLACK;
        s.anisotropy = 0.0;
        s.transmission = 0.0;
        s.subsurface = 0.0;
        let fr = random_frame(&mut rng);
        let l = rng.direction();
        let r = f.floats("surface", surface_input(&s, &fr, l, [2.0, 1.5, 0.5]));
        let brdf = &r[6..9];
        assert_eq!(r[..3], *brdf, "case {case}: {s:?} {fr:?} {l:?}");
        // shade is the same response times the radiance, in the same order.
        for c in 0..3 {
            assert_eq!(
                r[3 + c],
                f64::from((brdf[c] as f32) * ([2.0, 1.5, 0.5][c] as f32)),
                "case {case}"
            );
        }
        compared += 1;
    }
    assert_eq!(compared, 600);
}

#[test]
fn every_lobe_matches_the_f64_reference_term_by_term() {
    let mut f = fixture();
    let mut rng = Lcg(5);
    let radiance = [2.0, 0.5, 1.5];
    let mut worst: f64 = 0.0;
    for case in 0..3000 {
        let s = random_surface(&mut rng, case % 4 != 0);
        let fr = random_frame(&mut rng);
        let l = rng.direction();
        let r = f.floats("surface", surface_input(&s, &fr, l, radiance));
        let want = response(&s, &fr, l);
        // The tolerance is F32's through the dots of unit vectors: a light
        // within a few thousandths of the horizon has a cosine good to
        // 1e-7 absolute, so a relative 1e-3.
        assert!(
            within(&r[..3], &want, 1e-3, 2e-6),
            "case {case}: {:?} != {want:?} for {s:?} {fr:?} light {l:?}",
            &r[..3]
        );
        let shaded: Vec<f64> = (0..3).map(|c| want[c] * radiance[c]).collect();
        assert!(
            within(&r[3..6], &shaded, 1e-3, 2e-6),
            "case {case}: shade {:?} != {shaded:?}",
            &r[3..6]
        );
        for c in 0..3 {
            worst = worst.max((r[c] - want[c]).abs() / (want[c].abs() + 1e-6));
        }
    }
    assert!(worst < 1e-3, "worst relative difference {worst:e}");
}

fn aniso_input(s: &Surface, fr: &Frame, light: V) -> Vec<f64> {
    [
        s.base.to_vec(),
        vec![s.metallic, s.roughness, s.anisotropy, s.rotation],
        fr.normal.to_vec(),
        fr.tangent.to_vec(),
        vec![fr.handedness],
        fr.view.to_vec(),
        light.to_vec(),
    ]
    .concat()
}
/// A bare material (the glTF defaults) with an anisotropy.
fn grain(base: V, metallic: f64, roughness: f64, strength: f64, rotation: f64) -> Surface {
    let mut s = Surface::plain(base, metallic, roughness);
    s.anisotropy = strength;
    s.rotation = rotation;
    s
}
#[test]
fn anisotropy_is_isotropic_at_zero_and_stretches_the_highlight_along_the_tangent() {
    let mut f = fixture();
    let mut rng = Lcg(21);
    // At strength 0 the anisotropic lobe is the isotropic one to F32 round-off
    // (the two forms differ by a few ulps through th^2 + bh^2 = 1 - nh^2).
    let mut worst: f64 = 0.0;
    for case in 0..800 {
        let mut s = grain(
            [
                rng.between(0.1, 1.0),
                rng.between(0.1, 1.0),
                rng.between(0.1, 1.0),
            ],
            rng.between(0.0, 1.0),
            rng.between(0.12, 1.0),
            0.0,
            rng.between(-PI, PI),
        );
        s.metallic = if case % 3 == 0 { 1.0 } else { s.metallic };
        let mut fr = random_frame(&mut rng);
        fr.view = rng.above(fr.normal, 0.05);
        let l = rng.above(fr.normal, 0.02);
        let r = f.floats("aniso", aniso_input(&s, &fr, l));
        for c in 0..3 {
            let e = (r[c] - r[3 + c]).abs() / (r[3 + c].abs() + 1e-6);
            worst = worst.max(e);
            assert!(
                e < 1e-4 || (r[c] - r[3 + c]).abs() < 1e-7,
                "case {case}: {:?} vs {:?}",
                &r[..3],
                &r[3..6]
            );
        }
    }
    eprintln!("anisotropy 0 against isotropic: worst relative {worst:e}");
    // Away from zero it follows the reference at several half vectors, with
    // the frame and the IBL direction the contract gives.
    let n = [0.0, 1.0, 0.0];
    let t0 = [1.0, 0.0, 0.0];
    let v = unit([0.3, 0.8, 0.2]);
    for strength in [0.8, -0.8, 1.0, 0.3] {
        let s = grain([0.9, 0.5, 0.2], 1.0, 0.45, strength, 0.0);
        let mut fr = Frame::new(n, v);
        fr.tangent = t0;
        for k in 0..24 {
            let angle = k as f64 * PI / 12.0;
            let l = unit([0.55 * angle.cos(), 0.6, 0.55 * angle.sin()]);
            let got = f.floats("aniso", aniso_input(&s, &fr, l));
            let want = response_with(&s, &fr, l, true);
            assert!(
                within(&got[..3], &want, 3e-4, 1e-7),
                "strength {strength} angle {k}: {:?} != {want:?}",
                &got[..3]
            );
        }
    }
    // The highlight is broader along the tangent (alpha_t = mix(alpha, 1, a^2))
    // than along the bitangent: a half vector tilted the same angle toward
    // each gives a larger lobe toward the tangent. View and light mirror about
    // the plane of the normal and tangent, so the half vector tilts toward the
    // bitangent; mirror about the plane of normal and bitangent for the other.
    let s = grain([1.0, 1.0, 1.0], 1.0, 0.4, 0.9, 0.0);
    let mut fr = Frame::new(n, unit([0.0, 1.0, 0.0]));
    fr.tangent = t0;
    let tilt = 0.25f64;
    let toward_t = unit([tilt.sin() * 2.0 * 0.5f64.sqrt(), 1.0, 0.0]); // light off the normal along +x
    let toward_b = unit([0.0, 1.0, tilt.sin() * 2.0 * 0.5f64.sqrt()]); // along +z
    let along_t = f.floats("aniso", aniso_input(&s, &fr, toward_t))[0];
    let along_b = f.floats("aniso", aniso_input(&s, &fr, toward_b))[0];
    assert!(along_t > 1.2 * along_b, "{along_t} vs {along_b}");
    // Turning the frame by a quarter turn swaps the roles of the tangent and
    // the bitangent: it is the same as handing in the bitangent (n x t) as the
    // tangent. Neither the handedness nor a tangent that is not perpendicular
    // to the normal changes anything.
    let mut rng = Lcg(77);
    for case in 0..200 {
        let strength = rng.between(0.2, 1.0);
        let s = grain([0.8, 0.6, 0.3], 1.0, rng.between(0.2, 0.9), strength, 0.0);
        let mut fr = random_frame(&mut rng);
        fr.view = rng.above(fr.normal, 0.2);
        let n = unit(fr.normal);
        fr.tangent = unit(sub(fr.tangent, scale(n, dot(n, fr.tangent)))); // perpendicular
        if length(fr.tangent) < 0.5 {
            continue;
        }
        let l = rng.above(fr.normal, 0.1);
        let base = f.floats("aniso", aniso_input(&s, &fr, l));
        let mut turned = s;
        turned.rotation = PI / 2.0;
        let quarter = f.floats("aniso", aniso_input(&turned, &fr, l));
        let mut swapped = fr;
        swapped.tangent = cross(n, fr.tangent);
        let handed = f.floats("aniso", aniso_input(&s, &swapped, l));
        assert!(
            within(&quarter[..3], &handed[..3], 2e-4, 1e-7),
            "case {case}: {:?} vs {:?}",
            &quarter[..3],
            &handed[..3]
        );
        let mut flipped = fr;
        flipped.handedness = -fr.handedness;
        assert_eq!(
            f.floats("aniso", aniso_input(&s, &flipped, l))[..3],
            base[..3],
            "handedness {case}"
        );
        let mut tilted = fr;
        tilted.tangent = add(fr.tangent, scale(n, 0.7));
        let skew = f.floats("aniso", aniso_input(&s, &tilted, l));
        assert!(
            within(&skew[..3], &base[..3], 1e-4, 1e-7),
            "case {case}: skew {:?} vs {:?}",
            &skew[..3],
            &base[..3]
        );
    }
    // The frame comes back perpendicular, unit and turned by the rotation; a
    // missing tangent or one along the normal is replaced, deterministically.
    for (tangent, rho) in [
        ([1.0, 0.0, 0.0], 0.0),
        ([0.3, 0.4, 0.9], 0.7),
        ([0.0, 0.0, 0.0], 0.0),
        ([0.0, 2.0, 0.0], 1.2),
    ] {
        let mut s = grain([1.0, 1.0, 1.0], 1.0, 0.5, 0.5, rho);
        let mut fr = Frame::new(unit([0.0, 1.0, 0.0]), unit([0.2, 0.9, 0.3]));
        fr.tangent = tangent;
        fr.handedness = -1.0;
        let r = f.floats("aniso", aniso_input(&s, &fr, [0.1, 1.0, 0.2]));
        let (t, b) = (&r[6..9], &r[9..12]);
        let (want_t, want_b) = tangent_frame([0.0, 1.0, 0.0], tangent, -1.0, rho);
        near_all(t, &want_t, 2e-6);
        near_all(b, &want_b, 2e-6);
        near(dot([t[0], t[1], t[2]], [0.0, 1.0, 0.0]), 0.0, 2e-6);
        near(length([t[0], t[1], t[2]]), 1.0, 2e-6);
        s.rotation = 0.0;
    }
    // Image-based light: the bent normal is the shading normal without
    // anisotropy, and the contract's blend with the view's part off the
    // grain otherwise; the reflection is the view mirrored about it.
    let mut rng = Lcg(3);
    for case in 0..300 {
        let strength = if case % 5 == 0 {
            0.0
        } else {
            rng.between(-1.0, 1.0)
        };
        let s = grain(
            [0.5; 3],
            rng.between(0.0, 1.0),
            rng.between(0.0, 1.0),
            strength,
            rng.between(-PI, PI),
        );
        let mut fr = random_frame(&mut rng);
        fr.view = rng.above(fr.normal, 0.05);
        let r = f.floats("aniso", aniso_input(&s, &fr, [0.0, 1.0, 0.0]));
        let (n, v) = (unit(fr.normal), unit(fr.view));
        let (t, b) = tangent_frame(n, fr.tangent, fr.handedness, s.rotation);
        let bent = bent_normal(n, v, t, b, strength, s.roughness);
        near_all(&r[12..15], &bent, 3e-6);
        near_all(&r[15..18], &reflect_about(v, bent), 6e-6);
        if strength == 0.0 {
            near_all(&r[12..15], &n, 2e-7);
        }
    }
}

/// A Blot `albedo` of a surface: its response summed over the hemisphere of
/// lights (the whole sphere when `sphere`) about +Y on an n x 2n grid.
fn albedo_blot(f: &mut Fixture, s: &Surface, fr: &Frame, n: usize, sphere: bool) -> V {
    let input = [
        s.lanes(),
        fr.lanes(),
        vec![f64::from(sphere as u8), n as f64],
    ]
    .concat();
    let r = f.floats("albedo", input);
    [r[0], r[1], r[2]]
}
fn coat_input(w: f64, rc: f64, fr: &Frame, light: V, split: [f64; 2], nvc: f64) -> Vec<f64> {
    [
        vec![w, rc],
        fr.normal.to_vec(),
        fr.coat_normal.to_vec(),
        fr.view.to_vec(),
        light.to_vec(),
        split.to_vec(),
        vec![nvc],
    ]
    .concat()
}
#[test]
fn clear_coat_is_kelemen_layered_over_the_base_and_conserves_energy() {
    let mut f = fixture();
    let up = [0.0, 1.0, 0.0];
    // Straight on with a matte coat everything is a number by hand: Fc = 0.04,
    // D = 1 / pi (alpha = 1), V = 0.25, so the coat is w * 0.04 * 0.25 / pi and
    // the layers below keep 1 - w * 0.04.
    let mut fr = Frame::new(up, up);
    fr.coat_normal = up;
    let r = f.floats("coat", coat_input(0.5, 1.0, &fr, up, [0.8, 0.1], 1.0));
    near(r[0], 0.5 * 0.04 * 0.25 / PI, 1e-9);
    near(r[1], 0.98, 1e-7);
    // The image-based form: w (0.04 sx + sy), and Fc from the view's cosine.
    near(r[2], 0.5 * (0.04 * 0.8 + 0.1), 1e-7);
    near(r[3], 0.98, 1e-7);
    for (nvc, fc) in [
        (0.0, 1.0),
        (0.5, 0.04 + 0.96 * 0.5f64.powi(5)),
        (1.0, 0.04),
        (-2.0, 1.0),
        (7.0, 0.04),
    ] {
        let r = f.floats("coat", coat_input(0.8, 0.3, &fr, up, [0.5, 0.2], nvc));
        near(r[3], 1.0 - 0.8 * fc, 1e-7);
    }
    // Weight 0 is nothing: no response and the layers below keep everything.
    let r = f.floats("coat", coat_input(0.0, 0.2, &fr, up, [0.5, 0.2], 0.7));
    assert_eq!(r, [0.0, 1.0, 0.0, 1.0]);
    // A weight above 1 counts as 1, below 0 as 0.
    let one = f.floats(
        "coat",
        coat_input(1.0, 0.4, &fr, [0.3, 1.0, 0.1], [0.5, 0.2], 0.7),
    );
    assert_eq!(
        f.floats(
            "coat",
            coat_input(3.0, 0.4, &fr, [0.3, 1.0, 0.1], [0.5, 0.2], 0.7)
        ),
        one
    );
    assert_eq!(
        f.floats(
            "coat",
            coat_input(-1.0, 0.4, &fr, [0.3, 1.0, 0.1], [0.5, 0.2], 0.7)
        )[..2],
        [0.0, 1.0]
    );
    // Random frames against the reference lobe, with the coat normal off the
    // shading normal now and then (the coat uses its own, the layers below
    // theirs; a zero coat normal is the shading normal).
    let mut rng = Lcg(9);
    for case in 0..400 {
        let mut fr = random_frame(&mut rng);
        if case % 3 == 0 {
            fr.coat_normal = BLACK;
        }
        let l = rng.direction();
        let (w, rc) = (rng.between(0.0, 1.0), rng.between(0.0, 1.0));
        let r = f.floats("coat", coat_input(w, rc, &fr, l, [0.5, 0.2], 0.7));
        let (n, v, l) = (unit(fr.normal), unit(fr.view), unit(l));
        let nc = if length(fr.coat_normal) == 0.0 {
            n
        } else {
            unit(fr.coat_normal)
        };
        let h = unit(add(v, l));
        let (response, keep) = coat_lobe(w, rc, nc, h, l, sat(dot(v, h)));
        assert!(
            within(&r[..2], &[response, keep], 5e-4, 1e-6),
            "case {case}: {:?} != {response} {keep}",
            &r[..2]
        );
        assert!(
            (0.0..=1.0).contains(&r[1]) && r[1] >= 1.0 - w - 1e-6,
            "keep {} for weight {w}",
            r[1]
        );
    }
    // Energy. A white dielectric under a coat: layered albedo is at most 1, at
    // most the base's albedo plus the coat alone, and at least the coat alone;
    // weight 0 changes nothing, to the bit.
    let mut white = Surface::plain(WHITE, 0.0, 0.4);
    let mut nothing = white;
    nothing.base = BLACK; // no base lobe at all (black albedo, specular 0)
    nothing.specular = 0.0;
    // Fc is taken per light at the half vector (Filament's attenuation, not the
    // view's directional albedo), so the sum is at most 1 for views within about
    // 45 degrees of the normal and over it at grazing ones, where Kelemen's
    // visibility also overestimates: 1.49 for a roughness of 0.3 at a cosine of
    // 0.05. The bound at a grazing view is that measured one.
    for (view, bound) in [
        ([0.0, 1.0, 0.0], 1.0 + 1e-3),
        ([0.6, 0.8, 0.0], 1.0 + 1e-3),
        ([0.7, 0.7, 0.0], 1.05),
        ([1.0, 0.12, 0.3], 1.55),
    ] {
        let fr = Frame::new(up, unit(view));
        let base = albedo_blot(&mut f, &white, &fr, 96, false);
        for (w, rc) in [(1.0, 0.3), (0.5, 0.6), (1.0, 1.0), (0.25, 0.45)] {
            let mut coated = white;
            coated.coat = w;
            coated.coat_roughness = rc;
            let mut alone = nothing;
            alone.coat = w;
            alone.coat_roughness = rc;
            let layered = albedo_blot(&mut f, &coated, &fr, 96, false);
            let coat_alone = albedo_blot(&mut f, &alone, &fr, 96, false);
            let want = integrate(96, false, &|l| response(&coated, &fr, l));
            for c in 0..3 {
                assert!(
                    layered[c] <= bound,
                    "albedo {} above {bound} for {view:?} w {w} rc {rc}",
                    layered[c]
                );
                assert!(
                    layered[c] <= base[c] + coat_alone[c] + 1e-5,
                    "{layered:?} {base:?} {coat_alone:?}"
                );
                assert!(layered[c] >= coat_alone[c]);
                assert!(
                    (layered[c] - want[c]).abs() <= 1e-3 * want[c] + 1e-5,
                    "{layered:?} vs {want:?}"
                );
            }
        }
        white.coat = 0.0;
        assert_eq!(albedo_blot(&mut f, &white, &fr, 96, false), base);
    }
}

#[test]
fn charlie_sheen_has_the_contract_values_a_table_and_layers_by_albedo() {
    let mut f = fixture();
    let up = [0.0, 1.0, 0.0];
    // By hand: n = up, v = l = (0.8, 0.6, 0), so nl = nv = nh = 0.6 and
    // 1 - nh^2 = 0.64; roughness 1 gives Ds = 3 * 0.8 / (2 pi), Vs = 1 / 3.36.
    let sheen_input = |tint: V, r: f64, n: V, v: V, l: V| {
        [tint.to_vec(), vec![r], n.to_vec(), v.to_vec(), l.to_vec()].concat()
    };
    let r = f.floats(
        "sheen",
        sheen_input([1.0, 0.5, 0.0], 1.0, up, [0.8, 0.6, 0.0], [0.8, 0.6, 0.0]),
    );
    near(r[0], 0.06820926132509801, 1e-7);
    near(r[1], 0.5 * 0.06820926132509801, 1e-7);
    near(r[2], 0.0, 0.0);
    let r = f.floats(
        "sheen",
        sheen_input([1.0, 1.0, 1.0], 0.5, up, [0.8, 0.6, 0.0], [0.8, 0.6, 0.0]),
    );
    near(r[0], 0.06984628359690036, 1e-6);
    // A black tint is no sheen and takes nothing from the layers below.
    let r = f.floats(
        "sheen",
        sheen_input(BLACK, 0.5, up, [0.8, 0.6, 0.0], [0.8, 0.6, 0.0]),
    );
    assert_eq!((r[..4].to_vec(), r[5]), (vec![0.0, 0.0, 0.0, 1.0], 1.0));
    // The table: its nodes are the quadrature and between them it is within
    // 0.006 of the exact integral (it is a 32 x 16 bilinear table); the
    // quadrature the nodes come from is converged to 0.002.
    let table = sheen_table();
    for row in 0..TABLE_ROUGHNESS {
        for column in 0..TABLE_NV {
            let s = column as f64 / (TABLE_NV - 1) as f64;
            let t = row as f64 / (TABLE_ROUGHNESS - 1) as f64;
            let got = f.floats("sheen_albedo", [f32_of(s * s), f32_of(0.07 + 0.93 * t * t)])[0];
            near(got, table[row * TABLE_NV + column], 4e-6);
        }
    }
    let mut rng = Lcg(31);
    let mut worst: f64 = 0.0;
    for _ in 0..60 {
        let (nv, rs) = (rng.between(0.0, 1.0), rng.between(0.07, 1.0));
        let got = f.floats("sheen_albedo", [nv, rs])[0];
        let exact = sheen_albedo_exact(nv, rs, 384);
        worst = worst.max((got - exact).abs());
        assert!(
            (got - exact).abs() <= 0.006,
            "albedo at {nv} {rs}: {got} vs {exact}"
        );
        near(got, sheen_albedo(nv, rs), 4e-6);
    }
    eprintln!("sheen table against the exact integral: worst {worst:e}");
    for (row, column) in [(0, 9), (3, 12), (8, 20), (15, 30), (15, 0), (7, 31)] {
        let fine = sheen_table_node(row, column, 1024);
        assert!(
            (fine - table[row * TABLE_NV + column]).abs() <= 0.002,
            "node {row} {column}: {fine} vs {}",
            table[row * TABLE_NV + column]
        );
    }
    // Outside its range the arguments clamp, never indexing past the table.
    for (nv, rs) in [
        (-1.0, 0.0),
        (2.0, 5.0),
        (1.0, 1.0),
        (0.0, 0.07),
        (0.9999999, 0.9999999),
    ] {
        near(
            f.floats("sheen_albedo", [nv, rs])[0],
            sheen_albedo(nv, rs),
            4e-6,
        );
    }
    // The response and what it leaves, against the reference, over random frames.
    for case in 0..400 {
        let tint = [
            rng.between(0.0, 1.0),
            rng.between(0.0, 1.0),
            rng.between(0.0, 1.0),
        ];
        let (rs, fr) = (rng.between(0.0, 1.0), random_frame(&mut rng));
        let l = rng.direction();
        let r = f.floats("sheen", sheen_input(tint, rs, fr.normal, fr.view, l));
        let (n, v, ln) = (unit(fr.normal), unit(fr.view), unit(l));
        let facing = dot(n, v);
        let (want, keep) = if facing <= 0.0 || max3(tint) <= 0.0 {
            (BLACK, 1.0)
        } else {
            let (nv, nl) = (facing.max(1e-5), sat(dot(n, ln)));
            let nh = sat(dot(n, unit(add(v, ln))));
            let rs = rs.clamp(0.07, 1.0);
            let lobe = charlie_d(nh, rs * rs) * neubelt_v(nl, nv) * nl;
            (
                scale(tint, lobe),
                (1.0 - max3(tint) * sheen_albedo(nv, rs)).max(0.0),
            )
        };
        assert!(
            within(&r[..3], &want, 1e-3, 1e-6),
            "case {case}: {:?} != {want:?}",
            &r[..3]
        );
        near(r[3], keep, 1e-5);
        near(
            r[5],
            if max3(tint) <= 0.0 {
                1.0
            } else {
                (1.0 - max3(tint) * sheen_albedo(facing.max(1e-5), rs)).max(0.0)
            },
            if facing > 0.0 { 2e-5 } else { 1.0 },
        );
    }
    // Furnace: a white dielectric under a white sheen. The sheen lobe's albedo
    // (the table's) is what the base gives up, so the sum stays at most 1 where
    // the lobe's integral is itself at most 1 (it is not at grazing views with
    // a low roughness: there the table is capped and the sheen alone exceeds 1).
    let white = Surface::plain(WHITE, 0.0, 0.5);
    for (view, rs) in [
        ([0.0, 1.0, 0.0], 0.5),
        ([0.0, 1.0, 0.0], 1.0),
        ([0.8, 0.6, 0.0], 0.8),
        ([1.0, 0.5, 0.0], 1.0),
    ] {
        let fr = Frame::new(up, unit(view));
        let base = albedo_blot(&mut f, &white, &fr, 96, false);
        let mut fuzzy = white;
        fuzzy.sheen_color = WHITE;
        fuzzy.sheen_roughness = rs;
        let layered = albedo_blot(&mut f, &fuzzy, &fr, 96, false);
        let want = integrate(96, false, &|l| response(&fuzzy, &fr, l));
        for c in 0..3 {
            // The base gives up the table's albedo, which is within 0.006 of the
            // lobe's integral, so the sum stays within that of the base's own
            // albedo (the GGX lobe is not exactly white: up to 1.01) or of 1.
            assert!(
                layered[c] <= base[c].max(1.0) + 6e-3,
                "{layered:?} {base:?} for {view:?} {rs}"
            );
            assert!(layered[c] >= base[c] * 0.4, "{layered:?} {base:?}");
            assert!(
                (layered[c] - want[c]).abs() <= 1e-3 * want[c] + 1e-5,
                "{layered:?} vs {want:?}"
            );
        }
        // The sheen's own integral is the table's albedo (to its quadrature).
        let mut alone = Surface::plain(BLACK, 0.0, 0.5);
        alone.specular = 0.0;
        alone.sheen_color = WHITE;
        alone.sheen_roughness = rs;
        let own = albedo_blot(&mut f, &alone, &fr, 192, false);
        let table_value = sheen_albedo(unit(view)[1], rs);
        assert!(
            (own[0] - table_value).abs() <= 0.01 + 0.02 * table_value,
            "sheen alone {own:?} against the table's {table_value} for {view:?} {rs}"
        );
    }
}

#[test]
fn refraction_follows_snell_and_volumes_absorb_by_beer_lambert() {
    let mut f = fixture();
    let n = [0.0, 1.0, 0.0];
    // Snell: sin(theta_t) = eta sin(theta_i), the ray bends toward the normal
    // entering a denser medium, and is the zero vector past the critical angle.
    for degrees in [0.0, 10.0, 40.0, 75.0, 89.0] {
        let theta: f64 = f64::to_radians(degrees);
        let incident = [f32_of(theta.sin()), f32_of(-theta.cos()), 0.0];
        let sin_i = length([incident[0], 0.0, 0.0]) / length(incident);
        for eta in [1.0 / 1.5, 1.0 / 1.33, 1.0 / 2.4, 1.0, 1.5, 1.33] {
            let r = f.floats(
                "refract",
                [incident.to_vec(), n.to_vec(), vec![f32_of(eta)]].concat(),
            );
            let want = refract(incident, n, f32_of(eta));
            near_all(&r, &want, 2e-6);
            let sin_t = eta * sin_i;
            if sin_t > 1.0 {
                assert_eq!(
                    r, [0.0; 3],
                    "total internal reflection at {degrees} degrees, eta {eta}"
                );
            } else {
                near(length([r[0], r[1], r[2]]), 1.0, 2e-6);
                near(r[0].abs() / length([r[0], r[1], r[2]]), sin_t, 3e-6);
                assert!(r[1] < 0.0 && r[2] == 0.0, "{r:?}");
                if eta < 1.0 && degrees > 0.0 {
                    assert!(r[0] < incident[0], "bends toward the normal");
                }
            }
        }
    }
    // A ray through a boundary between equal indices does not bend.
    let r = f.floats("refract", [0.6, -0.8, 0.0, 0.0, 1.0, 0.0, 1.0]);
    near_all(&r, &[0.6, -0.8, 0.0], 1e-7);
    // The volume entry: ior, normal, view, point, thickness, colour, distance, width, last, roughness.
    let volume = |ior: f64,
                  view: V,
                  point: V,
                  thickness: f64,
                  colour: V,
                  distance: f64,
                  width: f64,
                  last: f64,
                  roughness: f64| {
        [
            vec![ior],
            n.to_vec(),
            view.to_vec(),
            point.to_vec(),
            vec![thickness],
            colour.to_vec(),
            vec![distance, width, last, roughness],
        ]
        .concat()
    };
    let view = [f32_of(0.4f64.sin()), f32_of(0.4f64.cos()), 0.0];
    let r = f.floats(
        "volume",
        volume(
            1.5,
            view,
            [1.0, 2.0, 3.0],
            0.5,
            [0.5, 0.25, 1.0],
            2.0,
            1920.0,
            10.0,
            0.5,
        ),
    );
    // -v refracted by 1 / 1.5, then followed for the thickness.
    let ray = refract(scale(view, -1.0), n, 1.0 / 1.5);
    near_all(&r[..3], &ray, 2e-6);
    near_all(&r[3..6], &add([1.0, 2.0, 3.0], scale(ray, 0.5)), 2e-6);
    // Beer-Lambert: colour^(thickness / distance) per channel.
    near_all(
        &r[6..9],
        &[0.5f64.powf(0.25), 0.25f64.powf(0.25), 1.0],
        3e-6,
    );
    // The level: log2(width) * clamp(r * clamp(2 ior - 2, 0, 1), 0, 1), at most `last`.
    near(r[9], 1920f64.log2() * 0.5, 2e-4);
    for (ior, roughness, last, want) in [
        (1.0, 0.5, 10.0, 0.0),
        (1.25, 0.5, 20.0, 1920f64.log2() * 0.25),
        (2.0, 1.0, 10.0, 10.0),
        (1.5, 0.0, 20.0, 1920f64.log2() * 0.04),
        (1.5, 1.0, 20.0, 1920f64.log2()),
        (0.2, 0.7, 20.0, 0.0),
    ] {
        let r = f.floats(
            "volume",
            volume(
                ior, view, [0.0; 3], 1.0, [1.0; 3], 1.0, 1920.0, last, roughness,
            ),
        );
        near(r[9], want, 3e-4);
        near(r[9], transmission_level(1920.0, last, roughness, ior), 3e-4);
    }
    // A thin-walled surface (thickness 0) leaves where it entered and is not
    // attenuated, as is a medium with no distance; a ray in a medium of index
    // 1 or less goes straight on.
    let r = f.floats(
        "volume",
        volume(
            1.5,
            view,
            [1.0, 2.0, 3.0],
            0.0,
            [0.1; 3],
            2.0,
            512.0,
            9.0,
            0.3,
        ),
    );
    assert_eq!(
        (&r[3..6], &r[6..9]),
        (&[1.0, 2.0, 3.0][..], &[1.0, 1.0, 1.0][..])
    );
    let r = f.floats(
        "volume",
        volume(
            1.5,
            view,
            [1.0, 2.0, 3.0],
            2.0,
            [0.1; 3],
            0.0,
            512.0,
            9.0,
            0.3,
        ),
    );
    assert_eq!(&r[6..9], &[1.0, 1.0, 1.0]);
    let r = f.floats(
        "volume",
        volume(0.5, view, [0.0; 3], 1.0, [0.5; 3], 1.0, 512.0, 9.0, 0.3),
    );
    near_all(&r[..3], &scale(view, -1.0), 1e-6);
    // Colour 0 absorbs everything over any thickness; 1 nothing.
    let r = f.floats(
        "volume",
        volume(
            1.5,
            view,
            [0.0; 3],
            0.01,
            [0.0, 1.0, 0.5],
            4.0,
            512.0,
            9.0,
            0.3,
        ),
    );
    near_all(&r[6..9], &[0.0, 1.0, 0.5f64.powf(0.0025)], 2e-6);
    // The transmitted light: tr * behind * base * attenuation * (1 - Fspec) *
    // (1 - metallic), Fspec = f0 split.x + split.y, f0 from the ior; random
    // surfaces against the reference.
    let mut rng = Lcg(41);
    for case in 0..300 {
        let mut s = random_surface(&mut rng, true);
        if case % 7 == 0 {
            s.metallic = 0.0;
            s.transmission = 1.0;
        }
        let behind = [
            rng.between(0.0, 4.0),
            rng.between(0.0, 4.0),
            rng.between(0.0, 4.0),
        ];
        let atten = [
            rng.between(0.0, 1.0),
            rng.between(0.0, 1.0),
            rng.between(0.0, 1.0),
        ];
        let split = [rng.between(0.0, 1.0), rng.between(0.0, 0.3)];
        let input = [s.lanes(), behind.to_vec(), atten.to_vec(), split.to_vec()].concat();
        let got = f.floats("transmit", input);
        let want = transmitted(&s, behind, atten, split);
        assert!(
            within(&got, &want, 2e-5, 1e-7),
            "case {case}: {got:?} != {want:?} for {s:?}"
        );
    }
    // Fspec for ior 1 is the table's bias alone; opaque and metal pass nothing.
    let mut clear = Surface::plain([0.8, 0.9, 1.0], 0.0, 0.2);
    clear.ior = 1.0;
    clear.transmission = 1.0;
    let got = f.floats(
        "transmit",
        [clear.lanes(), vec![1.0; 3], vec![1.0; 3], vec![0.9, 0.1]].concat(),
    );
    near_all(&got, &[0.8 * 0.9, 0.9 * 0.9, 1.0 * 0.9], 2e-7);
    clear.transmission = 0.0;
    assert_eq!(
        f.floats(
            "transmit",
            [clear.lanes(), vec![1.0; 3], vec![1.0; 3], vec![0.9, 0.1]].concat()
        ),
        [0.0; 3]
    );
    clear.transmission = 1.0;
    clear.metallic = 1.0;
    assert_eq!(
        f.floats(
            "transmit",
            [clear.lanes(), vec![1.0; 3], vec![1.0; 3], vec![0.9, 0.1]].concat()
        ),
        [0.0; 3]
    );
    // The split-sum reference the random cases drew from is sane: a white lobe
    // reflects at most everything.
    for (nv, r) in [(1.0, 0.5), (0.3, 0.2), (0.05, 0.9)] {
        let [x, y] = split_sum(nv, r, 96);
        assert!(x >= 0.0 && y >= 0.0 && x + y <= 1.02, "{x} {y}");
    }
}

#[test]
fn subsurface_wraps_its_light_conserves_energy_and_glows_from_behind() {
    let mut f = fixture();
    let up = [0.0, 1.0, 0.0];
    // base 0-2, metallic 3, roughness 4, amount 5, colour 6-8, thin 9, normal
    // 10-12, view 13-15, light 16-18, specular 19.
    let input = |base: V, amount: f64, colour: V, thin: f64, view: V, light: V, specular: f64| {
        [
            base.to_vec(),
            vec![0.0, 0.5, amount],
            colour.to_vec(),
            vec![thin],
            up.to_vec(),
            view.to_vec(),
            light.to_vec(),
            vec![specular],
        ]
        .concat()
    };
    let at_cosine = |c: f64| [f32_of((1.0 - c * c).sqrt()), f32_of(c), 0.0];
    // No subsurface (and no specular, so no Fresnel): Lambert, zero behind.
    for c in [1.0, 0.5, 0.0, -0.3] {
        let r = f.floats(
            "subsurface",
            input([0.6, 0.3, 0.9], 0.0, WHITE, 1.0, up, at_cosine(c), 0.0),
        );
        let want: Vec<f64> = [0.6, 0.3, 0.9]
            .iter()
            .map(|b| b / PI * c.max(0.0))
            .collect();
        near_all(&r, &want, 2e-7);
    }
    // Full subsurface of white (no back light, thin 1): the wrapped cosine,
    // (x + 0.5) / 2.25 clamped, whatever the side of the light.
    for c in [1.0, 0.6, 0.0, -0.3, -0.5, -0.9] {
        let r = f.floats(
            "subsurface",
            input([1.0; 3], 1.0, WHITE, 1.0, up, at_cosine(c), 0.0),
        );
        near(r[1], sat((c + 0.5) / 2.25) / PI, 2e-7);
    }
    // A tint under the cosine: saturate(tint + max(x, 0)) of the wrap.
    let r = f.floats(
        "subsurface",
        input(
            [1.0; 3],
            1.0,
            [0.0, 0.5, 1.0],
            1.0,
            up,
            at_cosine(0.25),
            0.0,
        ),
    );
    near_all(
        &r,
        &[
            0.75 / 2.25 * 0.25 / PI,
            0.75 / 2.25 * 0.75 / PI,
            0.75 / 2.25 / PI,
        ],
        3e-7,
    );
    // The wrap loses no light: with a white tint the diffuse lobe integrates to
    // the albedo over the whole sphere, as Lambert's does, for any amount.
    for amount in [0.0, 0.3, 1.0] {
        let r = f.floats(
            "subsurface_albedo",
            [input([1.0; 3], amount, WHITE, 1.0, up, up, 0.0), vec![96.0]].concat(),
        );
        near_all(&r, &[1.0; 3], 2e-3);
        let mut s = Surface::plain(WHITE, 0.0, 0.5);
        s.specular = 0.0;
        s.subsurface = amount;
        let want = integrate(96, true, &|l| {
            subsurface_diffuse(&s, &Frame::new(up, up), l)
        });
        near_all(&r, &want, 1e-4);
    }
    // Light from behind, view in front: the back light only, a b c (1 - thin) 2 / pi.
    let r = f.floats(
        "subsurface",
        input([0.6; 3], 0.8, [0.5; 3], 0.25, up, [0.0, -1.0, 0.0], 0.0),
    );
    near_all(&r, &[0.8 * 0.5 * 0.75 * 0.6 * 2.0 / PI; 3], 2e-7);
    // Thin 1 (opaque), amount 0 or a view on the same side as the light give none.
    for (amount, thin, view, light) in [
        (0.8, 1.0, up, [0.0, -1.0, 0.0]),
        (0.0, 0.0, up, [0.0, -1.0, 0.0]),
        (0.8, 0.0, up, [0.0, 1.0, 0.0]),
    ] {
        let r = f.floats(
            "subsurface",
            input([0.6; 3], amount, [0.5; 3], thin, view, light, 0.0),
        );
        let bright = if light[1] > 0.0 { true } else { false };
        if !bright {
            assert_eq!(r, [0.0; 3], "amount {amount} thin {thin}");
        }
    }
    // Random surfaces, frames and lights against the reference, with the
    // Fresnel of a real specular and the back light.
    let mut rng = Lcg(57);
    for case in 0..400 {
        let mut s = random_surface(&mut rng, true);
        s.subsurface = rng.between(0.0, 1.0);
        let fr = random_frame(&mut rng);
        let l = rng.direction();
        let got = f.floats(
            "subsurface",
            [
                s.base.to_vec(),
                vec![s.metallic, s.roughness, s.subsurface],
                s.subsurface_color.to_vec(),
                vec![s.thin],
                fr.normal.to_vec(),
                fr.view.to_vec(),
                l.to_vec(),
                vec![1.0],
            ]
            .concat(),
        );
        // This entry's material has ior 1.5 and specular 1: the reference's too.
        let mut m = s;
        m.ior = 1.5;
        m.specular = 1.0;
        m.specular_color = WHITE;
        let want = subsurface_diffuse(&m, &fr, l);
        assert!(
            within(&got, &want, 5e-4, 1e-6),
            "case {case}: {got:?} != {want:?}"
        );
    }
}

/// The analytic height fields of `tests/surface.blot`'s `parallax` entry.
fn field_lanes(kind: f64, a: [f64; 4]) -> Vec<f64> {
    vec![kind, a[0], a[1], a[2], a[3]]
}
fn height_of(kind: f64, a: [f64; 4]) -> Box<dyn Fn(f64, f64) -> f64> {
    match kind as u32 {
        0 => Box::new(move |_, _| a[0]),
        1 => Box::new(move |u, _| a[0] + a[1] * u),
        2 => Box::new(move |u, _| if u < a[1] { a[0] } else { a[2] }),
        3 => Box::new(move |u, _| if (u - a[1]).abs() < a[3] { a[2] } else { a[0] }),
        _ => Box::new(move |u, _| 0.5 + 0.5 * (a[1] * u).sin()),
    }
}
fn parallax_input(kind: f64, a: [f64; 4], uv: [f64; 2], view: V, light: V, depth: f64) -> Vec<f64> {
    [
        field_lanes(kind, a),
        uv.to_vec(),
        view.to_vec(),
        light.to_vec(),
        vec![depth],
    ]
    .concat()
}
fn tilted(degrees: f64, azimuth: f64) -> V {
    let (theta, phi) = (f64::to_radians(degrees), f64::to_radians(azimuth));
    [
        f32_of(theta.sin() * phi.cos()),
        f32_of(theta.sin() * phi.sin()),
        f32_of(theta.cos()),
    ]
}
#[test]
fn parallax_marches_layers_refines_once_and_shadows_by_the_same_march() {
    let mut f = fixture();
    let straight = [0.0, 0.0, 1.0];
    // The layer count, floor(mix(32, 8, |cos|)): the rule written out in
    // `lighting.parallax_layers`, including its F32 rounding at whole values.
    for (cosine, want) in [
        (1.0, 8),
        (0.0, 32),
        (0.5, 20),
        (0.25, 26),
        (-0.5, 20),
        (0.99, 8),
        (0.01, 31),
        (2.0, 8),
    ] {
        let r = f.floats(
            "parallax",
            parallax_input(
                0.0,
                [0.5, 0.0, 0.0, 0.0],
                [0.5, 0.5],
                [(1.0f64 - cosine * cosine).max(0.0).sqrt(), 0.0, cosine],
                straight,
                0.1,
            ),
        );
        assert_eq!(r[3] as usize, want, "cosine {cosine}");
        assert_eq!(layers(cosine), want);
    }
    // Straight on nothing moves, over any field.
    for (kind, a) in [
        (0.0, [0.3, 0.0, 0.0, 0.0]),
        (1.0, [0.2, 0.5, 0.0, 0.0]),
        (2.0, [0.8, 0.5, 0.3, 0.0]),
        (4.0, [0.0, 9.0, 0.0, 0.0]),
    ] {
        let r = f.floats(
            "parallax",
            parallax_input(kind, a, [0.37, 0.61], straight, straight, 0.2),
        );
        assert_eq!(r[..2], [f32_of(0.37), f32_of(0.61)], "kind {kind}");
    }
    // A flat field at height h: the ray reaches it at depth 1 - h, a shift of
    // (1 - h) * p * tan(theta) against the view's direction, exactly (the
    // refinement is exact between two samples of a flat field).
    for h in [0.0, 0.25, 0.5, 0.9, 1.0] {
        for (degrees, azimuth) in [(20.0, 0.0), (45.0, 90.0), (60.0, 200.0), (75.0, -35.0)] {
            let view = tilted(degrees, azimuth);
            let (p, uv) = (0.08, [0.5, 0.5]);
            let r = f.floats(
                "parallax",
                parallax_input(0.0, [h, 0.0, 0.0, 0.0], uv, view, straight, p),
            );
            let reach = (1.0 - h) * p / view[2];
            near(r[0], uv[0] - view[0] * reach, 3e-6);
            near(r[1], uv[1] - view[1] * reach, 3e-6);
            near(
                (r[0] - uv[0]).hypot(r[1] - uv[1]),
                (1.0 - h) * p * f64::to_radians(degrees).tan(),
                3e-6,
            );
        }
    }
    // Two heights across a step: each side shifts by its own depth, so the
    // shifts differ by (h1 - h2) p tan(theta). Start far enough from the step.
    let (p, view) = (0.1, tilted(50.0, 0.0));
    let tan = f64::to_radians(50.0).tan();
    let high = f.floats(
        "parallax",
        parallax_input(2.0, [0.8, 0.5, 0.3, 0.0], [0.2, 0.5], view, straight, p),
    );
    let low = f.floats(
        "parallax",
        parallax_input(2.0, [0.8, 0.5, 0.3, 0.0], [0.9, 0.5], view, straight, p),
    );
    near(0.2 - high[0], 0.2 * p * tan, 4e-6);
    near(0.9 - low[0], 0.7 * p * tan, 4e-6);
    near(
        (0.9 - low[0]) - (0.2 - high[0]),
        (0.8 - 0.3) * p * tan,
        4e-6,
    );
    // A ray that starts beside the step and crosses it over the high side hits
    // there, within one layer's step of the analytic point.
    let crossing = f.floats(
        "parallax",
        parallax_input(
            2.0,
            [0.8, 0.5, 0.3, 0.0],
            [0.52, 0.5],
            tilted(45.0, 0.0),
            straight,
            0.2,
        ),
    );
    let layer_step = 0.2 * 1.0 / layers(f64::to_radians(45.0).cos()) as f64;
    assert!(
        (crossing[0] - 0.48).abs() <= layer_step * 1.01,
        "{} against 0.48 within {layer_step}",
        crossing[0]
    );
    // A ramp is a plane the ray meets once: the refinement is exact for any
    // layer count. h(u) = a + b u meets 1 - d at d = (1 - a - b u0) / (1 - b p tan).
    for (a, b) in [(0.5, 0.5), (0.3, -0.2), (0.6, 0.1)] {
        for (degrees, azimuth) in [(30.0, 0.0), (60.0, 0.0), (45.0, 180.0), (70.0, 40.0)] {
            let (view, p, u0) = (tilted(degrees, azimuth), 0.06, 0.45);
            let slope = view[0] / view[2];
            let d = (1.0 - a - b * u0) / (1.0 - b * p * slope);
            let r = f.floats(
                "parallax",
                parallax_input(1.0, [a, b, 0.0, 0.0], [u0, 0.3], view, straight, p),
            );
            near(r[0], u0 - slope * p * d, 5e-6);
            near(r[1], 0.3 - view[1] / view[2] * p * d, 5e-6);
        }
    }
    // Random smooth fields against the reference (the same steep search and
    // refinement in f64), displaced coordinates and shadow.
    let mut rng = Lcg(63);
    for case in 0..300 {
        let (kind, a) = if case % 2 == 0 {
            (
                1.0,
                [rng.between(0.3, 0.7), rng.between(-0.3, 0.3), 0.0, 0.0],
            )
        } else {
            (4.0, [0.0, rng.between(2.0, 20.0), 0.0, 0.0])
        };
        let view = tilted(rng.between(0.0, 80.0), rng.between(-180.0, 180.0));
        let light = tilted(rng.between(5.0, 80.0), rng.between(-180.0, 180.0));
        let (uv, p) = (
            [rng.between(0.3, 0.7), rng.between(0.3, 0.7)],
            rng.between(0.0, 0.2),
        );
        let got = f.floats("parallax", parallax_input(kind, a, uv, view, light, p));
        let height = height_of(kind, a);
        let (u, v) = parallax_uv(&*height, uv[0], uv[1], view, p);
        let shadow = parallax_shadow(&*height, u, v, light, p);
        assert!(
            within(&got[..3], &[u, v, shadow], 1e-4, 5e-5),
            "case {case}: {:?} != {:?}",
            &got[..3],
            [u, v, shadow]
        );
    }
    // Self-shadow. A pillar of the full height 1 at u = 0.5, half a width 0.02,
    // on a floor at 0.2 with the light toward +u at 45 degrees: the floor to
    // its left is shadowed out to 0.8 p, with a soft edge toward the end;
    // the floor to its right, and the pillar's top, are lit.
    let pillar = [0.2, 0.5, 1.0, 0.02];
    let light = tilted(45.0, 0.0);
    let p = 0.1;
    let lit = |f: &mut Fixture, u: f64| {
        f.floats(
            "parallax",
            parallax_input(3.0, pillar, [u, 0.5], straight_view(), light, p),
        )[2]
    };
    for u in [0.47, 0.45, 0.42] {
        assert!(
            lit(&mut f, u) <= 0.05,
            "u {u} inside the shadow: {}",
            lit(&mut f, u)
        );
    }
    for u in [0.3, 0.2, 0.53, 0.6, 0.8, 0.5] {
        assert_eq!(lit(&mut f, u), 1.0, "u {u} is lit");
    }
    // A flat field is lit; a light that is not above the surface shadows it all.
    let flat = [0.6, 0.0, 0.0, 0.0];
    assert_eq!(
        f.floats(
            "parallax",
            parallax_input(0.0, flat, [0.5; 2], straight, tilted(70.0, 30.0), 0.1)
        )[2],
        1.0
    );
    for light in [[0.5, 0.0, 0.0], [0.5, 0.0, -0.5], [0.0, 0.0, 0.0]] {
        assert_eq!(
            f.floats(
                "parallax",
                parallax_input(0.0, flat, [0.5; 2], straight, light, 0.1)
            )[2],
            0.0
        );
    }
    // A view that is not above the surface, or none, does not displace.
    for view in [[0.8, 0.0, 0.0], [0.5, 0.2, -0.5], [0.0, 0.0, 0.0]] {
        let r = f.floats(
            "parallax",
            parallax_input(0.0, flat, [0.25, 0.75], view, straight, 0.1),
        );
        assert_eq!(r[..2], [0.25, 0.75]);
    }
    // A grazing view stays finite (z is floored at 1e-4).
    let r = f.floats(
        "parallax",
        parallax_input(
            4.0,
            [0.0, 7.0, 0.0, 0.0],
            [0.5; 2],
            [1.0, 0.0, 1e-9],
            tilted(80.0, 0.0),
            0.05,
        ),
    );
    assert!(r.iter().all(|x| x.is_finite()), "{r:?}");
    // The height grid: texel centres read exactly, between them linearly, and
    // addressing repeats.
    let mut grid = |u: f64, v: f64| {
        f.floats(
            "grid",
            [
                vec![4.0, 2.0, u, v],
                vec![0.0, 0.2, 0.4, 0.6, 1.0, 0.8, 0.6, 0.4],
            ]
            .concat(),
        )[0]
    };
    near(grid(0.125, 0.25), 0.0, 1e-7);
    near(grid(0.375, 0.25), 0.2, 1e-7);
    near(grid(0.875, 0.75), 0.4, 1e-7);
    near(grid(0.25, 0.25), 0.1, 1e-7);
    near(grid(0.125, 0.5), 0.5, 1e-7);
    near(grid(1.125, 0.25), 0.0, 1e-6);
    near(grid(-0.125, 0.75), 0.4, 1e-6);
    near(grid(0.0, 0.5), 0.5, 1e-6);
}
fn straight_view() -> V {
    [0.0, 0.0, 1.0]
}

#[test]
fn surfaces_survive_adversarial_inputs() {
    let mut f = fixture();
    let mut loaded = Surface::plain([0.8, 0.5, 0.3], 0.3, 0.4);
    loaded.coat = 0.7;
    loaded.coat_roughness = 0.2;
    loaded.sheen_color = [0.9, 0.8, 0.7];
    loaded.sheen_roughness = 0.4;
    loaded.anisotropy = 0.6;
    loaded.rotation = 0.5;
    loaded.transmission = 0.4;
    loaded.thickness = 1.0;
    loaded.attenuation_distance = 2.0;
    loaded.subsurface = 0.6;
    loaded.subsurface_color = [0.9, 0.5, 0.3];
    loaded.thin = 0.3;
    let mut frame = Frame::new([0.0, 1.0, 0.0], [0.3, 0.9, 0.2]);
    frame.tangent = [1.0, 0.0, 0.0];
    frame.coat_normal = [0.1, 1.0, 0.0];
    let light = [0.2, 0.7, -0.4];
    let reference = |s: &Surface, fr: &Frame, l: V| response(s, fr, l);
    let got = shade_one(&mut f, &loaded, &frame, light);
    assert!(
        within(&got, &reference(&loaded, &frame, light), 1e-3, 1e-6)
            && got.iter().all(|x| *x > 0.0)
    );
    // A zero normal, view or light vector is no direction: no response, not NaN.
    for which in 0..3 {
        let (mut fr, mut l) = (frame, light);
        match which {
            0 => fr.normal = BLACK,
            1 => fr.view = BLACK,
            _ => l = BLACK,
        }
        assert_eq!(
            shade_one(&mut f, &loaded, &fr, l),
            [0.0; 3],
            "zero vector {which}"
        );
    }
    // NaN in any lane never traps. In the frame, the light and the radiance
    // it never turns a channel into some other plausible number either: each
    // channel is what it was (the lane does not reach it), zero, or NaN. The
    // material's numbers must be finite: `min` and `max` give the other
    // argument for a NaN, so a NaN index of refraction reads as a perfect
    // mirror's f0 (`specular`), and so on.
    let mut lanes = surface_input(&loaded, &frame, light, WHITE);
    let clean = f.floats("surface", lanes.clone());
    for lane in 0..lanes.len() {
        let saved = lanes[lane];
        lanes[lane] = f64::NAN;
        let r = f.floats("surface", lanes.clone());
        assert_eq!(r.len(), 9);
        for c in 0..3 {
            assert!(
                lane < 29 || r[c].is_nan() || r[c] == 0.0 || r[c] == clean[c],
                "NaN in lane {lane}: channel {c} is {} for {}",
                r[c],
                clean[c]
            );
        }
        lanes[lane] = saved;
    }
    // Roughness 0 and 1 and beyond, metallic and weights outside [0, 1]:
    // clamped, finite, and the clamped values' own results.
    let clamped = |s: &Surface| {
        let mut c = *s;
        c.roughness = c.roughness.clamp(0.04, 1.0);
        c.metallic = sat(c.metallic);
        c.coat = sat(c.coat);
        c.coat_roughness = c.coat_roughness.clamp(0.04, 1.0);
        c.sheen_roughness = c.sheen_roughness.clamp(0.07, 1.0);
        c.transmission = sat(c.transmission);
        c.subsurface = sat(c.subsurface);
        c.thin = sat(c.thin);
        c.anisotropy = c.anisotropy.clamp(-1.0, 1.0);
        c
    };
    for (roughness, metallic, weight) in [
        (0.0, -1.0, 4.0),
        (1.0, 2.0, -3.0),
        (9.0, 0.5, 1.0),
        (-2.0, 0.0, 0.0),
    ] {
        let mut s = loaded;
        s.roughness = roughness;
        s.metallic = metallic;
        s.coat = weight;
        s.coat_roughness = roughness;
        s.sheen_roughness = roughness;
        s.transmission = weight;
        s.subsurface = weight;
        s.thin = weight;
        s.anisotropy = weight;
        let got = shade_one(&mut f, &s, &frame, light);
        assert!(
            got.iter().all(|x| x.is_finite() && *x >= 0.0),
            "{got:?} for {roughness} {metallic} {weight}"
        );
        assert_eq!(
            got,
            shade_one(&mut f, &clamped(&s), &frame, light),
            "{roughness} {metallic} {weight}"
        );
    }
    // Grazing views (the view's cosine under the 1e-5 floor) and lights at
    // the horizon stay finite and match the reference; back-facing lights
    // light only the diffuse subsurface: a metal has nothing to show.
    for (view, l) in [
        ([1.0, 1e-7, 0.0], [0.0, 1.0, 0.0]),
        ([0.0, 1.0, 0.0], [1.0, 1e-9, 0.0]),
        ([1.0, 1e-4, 0.0], [-1.0, 1e-4, 0.0]),
        ([0.0, 1.0, 0.0], [1.0, 0.0, 0.0]),
    ] {
        let mut fr = frame;
        fr.view = view;
        let got = shade_one(&mut f, &loaded, &fr, l);
        assert!(
            got.iter().all(|x| x.is_finite() && *x >= 0.0),
            "{got:?} for {view:?} {l:?}"
        );
        assert!(
            within(&got, &reference(&loaded, &fr, l), 2e-3, 1e-5),
            "{got:?} vs {:?} for {view:?} {l:?}",
            reference(&loaded, &fr, l)
        );
    }
    let mut metal = loaded;
    metal.metallic = 1.0;
    metal.subsurface = 0.0;
    metal.sheen_color = BLACK;
    metal.transmission = 0.0;
    let mut behind = frame;
    behind.coat_normal = frame.normal;
    assert_eq!(
        shade_one(&mut f, &metal, &behind, [0.2, -0.7, 0.1]),
        [0.0; 3]
    );
    assert_eq!(
        shade_one(&mut f, &metal, &behind, [1.0, 0.0, 0.0]),
        [0.0; 3]
    );
    let wrapped = shade_one(&mut f, &loaded, &behind, [0.4, -0.3, 0.1]);
    assert!(wrapped.iter().all(|x| *x > 0.0));
    assert!(within(
        &wrapped,
        &reference(&loaded, &behind, [0.4, -0.3, 0.1]),
        1e-3,
        1e-6
    ));
    // An index of 1 has no dielectric reflection face on, a huge one is a mirror
    // (f0 clamps to 1): both finite.
    for ior in [1.0, 0.0, 1e30] {
        let mut s = loaded;
        s.ior = ior;
        let got = shade_one(&mut f, &s, &frame, light);
        assert!(got.iter().all(|x| x.is_finite()), "ior {ior}: {got:?}");
        assert!(within(&got, &reference(&s, &frame, light), 1e-3, 1e-6));
    }
}
