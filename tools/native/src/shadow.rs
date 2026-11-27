//! An f64 reference for `ink/render/shadow`: cascaded sun shadows fitted to a camera.
//!
//! The reference rebuilds a case from its lanes (see `tests/shadow_support.sq`:
//! pose, lens, light direction and plan), slices the camera's view at the
//! practical splits, finds each slice's smallest enclosing sphere by searching
//! the view axis rather than by the library's closed form, and snaps windows to
//! whole texels of the light's view. It then compares what Squid returns.
use crate::render_math::splits;
use crate::*;

type V3 = [f64; 3];
fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn scale(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn length(a: V3) -> f64 {
    dot(a, a).sqrt()
}
fn unit(a: V3) -> V3 {
    scale(a, 1. / length(a))
}
// Quaternions are x, y, z, w; `mul(a, b)` applies b first.
fn mul(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ]
}
fn rotate(q: [f64; 4], v: V3) -> V3 {
    let u = [q[0], q[1], q[2]];
    let t = scale(cross(u, v), 2.);
    add(add(v, scale(t, q[3])), cross(u, t))
}
fn yaw_pitch(yaw: f64, pitch: f64) -> [f64; 4] {
    mul(
        [0., (yaw / 2.).sin(), 0., (yaw / 2.).cos()],
        [(pitch / 2.).sin(), 0., 0., (pitch / 2.).cos()],
    )
}

/// The 18 lanes of a case: pose (x, y, z, yaw, pitch), lens (orthographic or
/// not, vertical field of view or height, aspect, near, far, reversed), the
/// light's direction, and the plan (cascades, map size, distance, blend).
/// Every lane is first rounded to F32, as the guest receives it.
#[derive(Clone, Debug)]
pub struct Case {
    pub position: V3,
    pub rotation: [f64; 4],
    pub orthographic: bool,
    pub size: f64,
    pub aspect: f64,
    pub near: f64,
    pub far: f64,
    pub light: V3,
    pub count: usize,
    pub texels: f64,
    pub distance: f64,
    pub blend: f64,
}
impl Case {
    pub fn new(lanes: &[f64]) -> Self {
        assert_eq!(lanes.len(), 18);
        let a: Vec<f64> = lanes.iter().map(|x| f32(*x)).collect();
        Self {
            position: [a[0], a[1], a[2]],
            rotation: yaw_pitch(a[3], a[4]),
            orthographic: a[5] > 0.5,
            size: a[6],
            aspect: a[7],
            near: a[8],
            far: a[9],
            light: [a[11], a[12], a[13]],
            count: a[14] as usize,
            texels: a[15],
            distance: a[16],
            blend: a[17],
        }
    }
    fn forward(&self) -> V3 {
        rotate(self.rotation, [0., 0., -1.])
    }
    /// The slice's eight corners, from the lens alone.
    fn corners(&self, near: f64, far: f64) -> Vec<V3> {
        let mut corners = Vec::new();
        for depth in [near, far] {
            let half_height = if self.orthographic {
                self.size / 2.
            } else {
                depth * (self.size / 2.).tan()
            };
            for y in [-1., 1.] {
                for x in [-1., 1.] {
                    let local = [x * half_height * self.aspect, y * half_height, -depth];
                    corners.push(add(self.position, rotate(self.rotation, local)));
                }
            }
        }
        corners
    }
    /// Where the first slice starts and where each slice ends.
    pub fn slices(&self) -> Option<(f64, Vec<f64>)> {
        let start = self.near.max(0.01);
        let end = self.distance.min(self.far);
        if self.count == 0
            || !(self.distance.is_finite() && end > start)
            || self.texels < 2.
            || length(self.light) == 0.
        {
            return None;
        }
        Some((start, splits(start, end, self.count, self.blend)))
    }
}

/// One cascade as the reference finds it, for a slice and a map size.
#[derive(Debug)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct Cascade {
    /// The radius of the smallest sphere holding the slice.
    pub sphere: f64,
    /// A texel's width, once the radius is rounded up to a sixteenth and
    /// enlarged to leave room for snapping.
    pub texel: f64,
    /// The sphere's centre in the light's view, in texels, before snapping.
    pub across: f64,
    pub up: f64,
    /// The centre's distance along the light from the light's eye.
    pub depth: f64,
}
/// The light's basis: right, up, the ray, and the eye the view is anchored at.
pub fn light_basis(light: V3) -> (V3, V3, V3, V3) {
    let ray = unit(light);
    let across = if ray[1].abs() > 0.99 {
        [0., 0., 1.]
    } else {
        [0., 1., 0.]
    };
    let right = unit(cross(ray, across));
    let up = cross(right, ray);
    (right, up, ray, scale(ray, -1000.))
}
/// The smallest sphere holding `points` centred on the line from `origin`
/// along `axis`, between depths `low` and `high`, by ternary search: the
/// farthest point's distance is convex in the centre's depth.
fn enclosing(points: &[V3], origin: V3, axis: V3, low: f64, high: f64) -> (f64, f64) {
    let reach = |c: f64| {
        let centre = add(origin, scale(axis, c));
        points
            .iter()
            .map(|p| length(sub(*p, centre)))
            .fold(0., f64::max)
    };
    let (mut a, mut b) = (low, high);
    for _ in 0..200 {
        let (x, y) = (a + (b - a) / 3., b - (b - a) / 3.);
        if reach(x) < reach(y) { b = y } else { a = x }
    }
    let c = (a + b) / 2.;
    (c, reach(c))
}
pub fn cascade(case: &Case, near: f64, far: f64) -> Cascade {
    let points = case.corners(near, far);
    let (along, sphere) = enclosing(&points, case.position, case.forward(), near, far);
    let centre = add(case.position, scale(case.forward(), along));
    let bound = (sphere * 16.).ceil().max(1.) / 16.;
    let texel = 2. * bound / (1. - 1. / case.texels) / case.texels;
    let (right, up, ray, origin) = light_basis(case.light);
    let from_eye = sub(centre, origin);
    Cascade {
        sphere,
        texel,
        across: dot(right, from_eye) / texel,
        up: dot(up, from_eye) / texel,
        depth: dot(ray, from_eye),
    }
}

/// The nearest of three 2048 texel cascades over 80 units for the frame the
/// `gizmos_graphics` workload sets: a camera at the origin looking down -Z
/// through a 60 degree lens 1.5 wide, the default sun straight down, at the
/// medium shadow tier. As F32, in world units.
pub fn gizmos_texel() -> f64 {
    let case = Case::new(&[
        0.,
        0.,
        0.,
        0.,
        0.,
        0.,
        std::f64::consts::PI / 3.,
        1.5,
        0.1,
        200.,
        0.,
        0.,
        -1.,
        0.,
        3.,
        2048.,
        80.,
        0.75,
    ]);
    let (start, ends) = case.slices().expect("a fit exists");
    f32(cascade(&case, start, ends[0]).texel)
}

#[cfg(test)]
fn near_integer(x: f64, tolerance: f64) -> f64 {
    let n = x.round();
    assert!(
        (x - n).abs() <= tolerance,
        "{x} is not within {tolerance} of a whole number"
    );
    n
}
/// A point through the light's view (16 lanes, column-major) and a window.
#[cfg(test)]
fn ndc(view: &[f64], window: &[f64], p: V3) -> V3 {
    let transform = |m: &[f64], v: [f64; 4]| -> [f64; 4] {
        std::array::from_fn(|row| (0..4).map(|col| m[col * 4 + row] * v[col]).sum())
    };
    let v = transform(view, [p[0], p[1], p[2], 1.]);
    let c = transform(window, v);
    [c[0] / c[3], c[1] / c[3], c[2] / c[3]]
}

/// Checks Squid's fit of a case against the reference. `view` holds the light's
/// view lanes and `rows` each cascade's 18 lanes: projection, texel, far.
/// Returns the worst overshoot of any slice corner beyond its window.
#[cfg(test)]
pub fn check_fit(case: &Case, view: &[f64], rows: &[f64]) -> f64 {
    let (start, ends) = case.slices().expect("a fit exists");
    assert_eq!(rows.len(), 18 * case.count);
    // The light's view: rotation columns exact to F32, the anchor 1000 back.
    let (right, up, ray, _) = light_basis(case.light);
    let expected_view = [
        right[0], up[0], -ray[0], 0., right[1], up[1], -ray[1], 0., right[2], up[2], -ray[2], 0.,
        0., 0., -1000., 1.,
    ];
    near_all(&view[..12], &expected_view[..12], 2e-6);
    near_all(&view[12..14], &[0., 0.], 1e-4);
    near(view[14], -1000., 1e-3);
    near(view[15], 1., 0.);
    // The perspective far plane is read back from the matrix to about
    // far / near times 6e-8, so a distance beyond it is held to that.
    let limited = case.distance >= case.far * 0.999;
    let mut worst = f64::MIN;
    let mut near_depth = start;
    for (i, row) in rows.chunks(18).enumerate() {
        // The splits, within the F32 library's exp2/log2.
        let tolerance = if limited && i == case.count - 1 {
            5e-4
        } else {
            3e-5
        };
        near(row[17], ends[i], tolerance * ends[i]);
        let far_depth = row[17];
        let c = cascade(case, near_depth, far_depth);
        // The radius is on the sixteenths grid, within the straddle of a boundary.
        let radius = 1. / row[0];
        let grid = radius * (1. - 1. / case.texels) * 16.;
        let m = near_integer(grid, 2e-4 * grid + 1e-3);
        let boundary = 1e-5 * c.sphere * 16. + 2e-3;
        assert!(
            m == (c.sphere * 16.).ceil().max(1.)
                || (c.sphere * 16. - m).abs() < boundary
                || (c.sphere * 16. - (m - 1.)).abs() < boundary,
            "radius {radius} for a sphere of {}",
            c.sphere
        );
        let texel = 2. * radius / case.texels;
        near(row[16], texel, 2e-6 * texel);
        near(row[0], 1. / radius, 2e-6 / radius);
        near(row[5], row[0], 0.);
        let scale = 1. / (2. * (radius + 60.));
        near(row[10], -scale, 2e-6 * scale);
        near(row[15], 1., 0.);
        for lane in [1, 2, 3, 4, 6, 7, 8, 9, 11] {
            assert_eq!(row[lane], 0., "lane {lane}");
        }
        // The window is on whole texels, no more than half a texel (and the
        // F32 error of the centre) from the sphere's centre.
        let step = 2. / case.texels;
        let (across, up) = (c.across * c.texel / texel, c.up * c.texel / texel);
        for (lane, wanted) in [(12, across), (13, up)] {
            let k = -row[lane] / step;
            let k = near_integer(k, 2e-7 * k.abs() + 1e-3);
            assert!(
                (k - wanted).abs() <= 0.5 + 1e-5 * wanted.abs() + 0.02,
                "lane {lane}: texel {k} for a centre at {wanted}"
            );
        }
        // The depth range reaches 60 beyond the sphere's own radius.
        let low = c.depth - radius - 60.;
        near(row[14], -low * scale, 2e-5);
        // Every corner of the slice, through Squid's own matrices.
        for corner in case.corners(near_depth, far_depth) {
            let n = ndc(view, &row[..16], corner);
            worst = worst
                .max(n[0].abs() - 1.)
                .max(n[1].abs() - 1.)
                .max(-n[2])
                .max(n[2] - 1.);
        }
        near_depth = far_depth;
    }
    worst
}

#[cfg(test)]
fn random_case(r: &mut Random) -> Vec<f64> {
    let mut between = |low: f64, high: f64| low + (high - low) * r.unit();
    let (x, y, z) = (
        between(-300., 300.),
        between(0.5, 120.),
        between(-300., 300.),
    );
    let (yaw, pitch) = (between(-3.1, 3.1), between(-1.45, 1.45));
    let orthographic = between(0., 1.) < 0.25;
    let lens = if orthographic {
        [
            1.,
            between(4., 80.),
            between(0.7, 2.4),
            between(0.05, 2.),
            between(200., 600.),
        ]
    } else {
        [
            0.,
            between(0.3, 2.2),
            between(0.7, 2.4),
            between(0.05, 1.),
            between(150., 1500.),
        ]
    };
    let reversed = f64::from(between(0., 1.) < 0.3);
    let vertical = between(0., 1.) < 0.2;
    let light = if vertical {
        [between(-0.05, 0.05), -1., between(-0.05, 0.05)]
    } else {
        [between(-1., 1.), between(-1., -0.05), between(-1., 1.)]
    };
    let count = (between(1., 5.) as usize).min(4) as f64;
    let texels = [1024., 2048., 4096., 1500., 777.][(between(0., 5.) as usize).min(4)];
    let distance = between(20., 140.);
    let blend = between(0., 1.);
    let mut lanes = vec![x, y, z, yaw, pitch];
    lanes.extend(lens);
    lanes.push(reversed);
    lanes.extend(light);
    lanes.extend([count, texels, distance, blend]);
    lanes
}

#[test]
fn cascades_match_the_f64_reference_and_hold_every_slice_corner() {
    let mut f = Fixture::new("tests/render-math.sq");
    let mut r = Random(0x5eed_1234);
    let mut cascades = 0;
    let mut worst = f64::MIN;
    for _ in 0..240 {
        let lanes = random_case(&mut r);
        let case = Case::new(&lanes);
        let out = f.floats("cascades", lanes.clone());
        if case.slices().is_none() {
            assert!(out.is_empty(), "{lanes:?}");
            continue;
        }
        assert_eq!(out.len(), 16 + 18 * case.count, "{lanes:?}");
        worst = worst.max(check_fit(&case, &out[..16], &out[16..]));
        cascades += case.count;
        // The worst overshoot Squid sees itself agrees.
        let reach = f.floats("cascade_reach", lanes);
        assert_eq!(reach[1] as usize, case.count);
        assert!(reach[0] <= 1e-5, "{reach:?}");
    }
    assert!(cascades > 500);
    // Every corner of every slice lies inside its window, with the reserve for
    // snapping to spare (about a texel in 1024 at least).
    assert!(worst <= 1e-6, "worst corner {worst} outside");
}

#[test]
fn a_known_orthographic_slice_has_the_hand_computed_window() {
    let mut f = Fixture::new("tests/render-math.sq");
    // A camera at the origin looking down -Z through a 6 by 6 box from depth 1
    // to 4.1, under a light shining along -Z. The slice's corners lie 3 and 3
    // from its axis, so the smallest sphere has radius sqrt(18 + 1.55^2) at
    // depth 2.55; 4.5169 rounds up to 4.5625 and the window to 4.5625 * 1024 / 1023.
    let lanes = [
        0., 0., 0., 0., 0., 1., 6., 1., 1., 4.1, 0., 0., 0., -1., 1., 1024., 100., 0.5,
    ];
    let out = f.floats("cascades", lanes.to_vec());
    assert_eq!(out.len(), 16 + 18);
    // The light's eye 1000 behind the origin along +Z.
    near_all(
        &out[..16],
        &[
            1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., -1000., 1.,
        ],
        1e-6,
    );
    let radius = 4.5625 * 1024. / 1023.;
    let texel = 2. * radius / 1024.;
    let row = &out[16..];
    near(row[0], 1. / radius, 1e-6);
    near(row[5], 1. / radius, 1e-6);
    near(row[16], texel, 1e-6);
    near(row[17], 4.1, 1e-6);
    // The centre lies on the axis, so it is the light's own x and y: zero.
    near_all(&row[12..14], &[0., 0.], 1e-6);
    // Its depth along the light: 1000 + 2.55, 60 and the radius either side.
    let low = 1002.55 - radius - 60.;
    near(row[10], -1. / (2. * (radius + 60.)), 1e-7);
    near(row[14], -low / (2. * (radius + 60.)), 1e-5);
    // And the reference agrees, to the bit that matters.
    let case = Case::new(&lanes);
    assert!(check_fit(&case, &out[..16], &out[16..]) <= 1e-6);
}

#[test]
fn windows_move_only_in_whole_texels_and_radius_ignores_pose() {
    let mut f = Fixture::new("tests/render-math.sq");
    let mut r = Random(0xc0ffee11);
    let mut moved = 0;
    for _ in 0..120 {
        let lanes = random_case(&mut r);
        let case = Case::new(&lanes);
        if case.slices().is_none() {
            continue;
        }
        let base = f.floats("cascades", lanes.clone());
        // A different camera position and heading, anywhere.
        let mut other = lanes.clone();
        for lane in 0..3 {
            other[lane] += (r.unit() - 0.5) * 0.002 * (1. + 9000. * r.unit().powi(3));
        }
        other[3] += (r.unit() - 0.5) * 0.01;
        other[4] = (other[4] + (r.unit() - 0.5) * 0.01).clamp(-1.45, 1.45);
        let next = f.floats("cascades", other.clone());
        assert_eq!(base.len(), next.len());
        // The light's view and every scale are bit for bit the same.
        assert_eq!(&base[..16], &next[..16], "{lanes:?}");
        let step = 2. / case.texels;
        for (a, b) in base[16..].chunks(18).zip(next[16..].chunks(18)) {
            for lane in [0, 5, 10, 15, 16, 17] {
                assert_eq!(a[lane], b[lane], "lane {lane} of {lanes:?}");
            }
            for lane in [12, 13] {
                let k = (a[lane] - b[lane]) / step;
                near_integer(k, 2e-7 * (a[lane] / step).abs() + 1e-3);
                moved += (a[lane] != b[lane]) as usize;
            }
        }
        check_fit(&Case::new(&other), &next[..16], &next[16..]);
    }
    assert!(moved > 50, "{moved} windows moved");
}
