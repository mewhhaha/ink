use super::*;
#[test]
fn general_mechanisms_and_ring_snapshots() {
    let mut example = Fixture::new("examples/mechanisms.blot");
    assert_eq!(
        example.floats("dashboard", 0),
        [5.0, 1.0, 300.0, 48.0, 328.0, 48.0, 1.0, 2.0, 1.0]
    );
    let mut f = Fixture::new("tests/general-mechanisms.blot");
    for steps in 0..200 {
        let capacity = steps % 17;
        let mut values = Vec::new();
        let mut old = Vec::new();
        for i in 0..steps {
            values.push(i as f64);
            if values.len() > capacity {
                values.remove(0);
            }
            if i == steps / 2 {
                old = values.clone();
            }
        }
        let expected = [vec![values.len() as f64, old.len() as f64], values, old].concat();
        assert_eq!(f.floats("history_values", steps), expected);
    }
    for name in [
        "trap_history_backwards",
        "trap_field_dimensions",
        "trap_locale_request",
    ] {
        let arg = match f
            .guest
            .abi()
            .functions
            .iter()
            .find(|f| f.name == name)
            .unwrap()
            .parameter
        {
            Parameter::Value(ValueType::Unit) => Input::Unit,
            _ => 1.into(),
        };
        f.traps(name, arg);
    }
}
#[test]
fn ui_numeric_controls_and_settings_id_uniqueness() {
    let mut f = Fixture::new("tests/ui_boundaries.blot");
    for a in [
        [0.0, f64::NAN, 1.0, 0.0],
        [0.0, 1.0, -1.0, 0.0],
        [f64::NAN, 0.0, 1.0, 0.0],
        [0.0, 0.0, f64::INFINITY, 0.0],
    ] {
        assert!(f.floats("invalid_slider", a).iter().all(|x| x.is_finite()));
    }
    let mut f = Fixture::new("tests/tune.blot");
    assert_eq!(f.number("decode_ids", [9.0, 3.0, 5.0]), 3.0);
    assert_eq!(f.number("decode_ids", []), 0.0);
    for ids in [
        vec![3.0, 9.0, 3.0],
        vec![4.0, 4.0],
        vec![1.0, 2.0, 3.0, 2.0],
    ] {
        f.traps("decode_ids", ids);
    }
}
#[test]
fn migrated_geometry_boundaries_and_workload_witnesses() {
    let mut f = Fixture::new("tests/migrated_geometry.blot");
    assert_eq!(
        f.floats("clear_segments", ()),
        [0.0, 0.0, 1.0, 1.0, 1.0, 0.0]
    );
    let moved = f.floats("thin_step", ());
    assert_eq!(moved[0], 1.0);
    assert_eq!(moved[3], 1.0);
    assert!(moved[1] < 0.11);
    for count in [0, 3, 22, 1000] {
        assert_eq!(f.number("bad_brush", count), 0.0);
    }
    assert!(matches!(
        f.call("unbounded_brush", ()).unwrap(),
        Value::Bool(true)
    ));
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert!(matches!(
            f.call("invalid_brush", value).unwrap(),
            Value::Bool(true)
        ));
        assert!(matches!(
            f.call("invalid_path", value).unwrap(),
            Value::Bool(true)
        ));
    }
    let found = f.floats("small_path", ());
    near(found[0], 0.000005, 1e-10);
    near(found[1], std::f64::consts::FRAC_PI_2, 1e-6);
    assert_eq!(f.words("polar_boundaries", ()), [999, 0, 0, 1, 2, 999, 16]);
    assert_eq!(f.number("polar_roundtrip", ()), 66.0);
    assert_eq!(f.words("plots", 64), [64, 64]);
    assert_eq!(f.floats("brushes", 64), [512.0, 2080.0]);
    assert_eq!(f.words("ground_segments", 64), [64, 64]);
    let gizmos = f.floats("gizmos_graphics", 64);
    assert_eq!(gizmos[..4], [1152.0, 131072.0, 64.0, 192.0]);
    near(gizmos[4], crate::shadow::gizmos_texel(), 1e-8);
    assert_eq!(f.floats("picking_view", 64), [64.0, 256.0, 36160.0]);
    let light = f.floats("lighting", 64);
    assert_eq!(light[0], 64.0);
    near(light[1], 64.7443695, 1e-4);
    let route = f.floats("paths", 64);
    assert_eq!(route[0], 7.0);
    near(route[1], 286.83194, 1e-4);
    let orbit = f.floats("orbits", 64);
    assert!(orbit.iter().all(|x| x.is_finite()));
    assert!(orbit[0].hypot(orbit[2]) <= 10.001);
    near(orbit[4], 0.6320015, 1e-5);
    for far in [7, 60] {
        assert_eq!(
            f.floats("editor_level_plane", far),
            [13.0, far as f64, f32(0.001), far as f64, 3.0, 5.0]
        );
    }
}
