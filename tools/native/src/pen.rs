use crate::*;
#[test]
fn frozen_pen_bindings_record_schema_generator_and_content_hashes() {
    use sha2::{Digest, Sha256};
    let dir = root().join("tests/fixtures/pen");
    let p: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("provenance.json")).unwrap()).unwrap();
    assert_eq!(
        p["contract"],
        serde_json::json!({"magic":4670534,"header_lanes":151,"event_lanes":5,"draw_lanes":24,"inset_lanes":48,"ui_head_lanes":24})
    );
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(std::fs::read(root().join("tests/fixtures/pen.json")).unwrap())
        ),
        p["fixture_config_sha256"].as_str().unwrap()
    );
    for name in ["schema_sha256", "generator_sha256"] {
        let s = p[name].as_str().unwrap();
        assert!(
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
    }
    for (name, expected) in p["files"].as_object().unwrap() {
        let bytes = std::fs::read(dir.join(name)).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            expected.as_str().unwrap(),
            "{name}"
        );
        for line in std::str::from_utf8(&bytes)
            .unwrap()
            .lines()
            .filter(|l| l.starts_with("import "))
        {
            let imported = line
                .split(" from \"")
                .nth(1)
                .unwrap()
                .split('"')
                .next()
                .unwrap();
            assert!(
                [
                    "std/array",
                    "std/simd",
                    "./lanes",
                    "./protocol",
                    "./protocol_render",
                    "./types"
                ]
                .contains(&imported),
                "{imported}"
            );
        }
    }
}
#[test]
fn pen_packets_preserve_offsets_tails_and_record_meanings() {
    let mut f = Fixture::new("tests/pen.blot");
    let p = f.floats("frame_packet", 0);
    // Session2 render packets carry no opaque state; snapshots are explicit.
    assert_eq!(p.len(), 613);
    for (offset, expected) in [
        (
            0,
            vec![4670534., 3., 0., 1., 1., 6., 1., 1., 1., 1., 1., 14.],
        ),
        (130, vec![1., 11., 0., 0., 1., 10., 5., 1.]),
        (144, vec![1., 1.]),
        (151, vec![0., 0.]),
        (
            153,
            vec![
                1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
            ],
        ),
        (169, vec![4., 1., 2., 3., 4., 32.]),
        (175, vec![1., 0., 1., 0., 1., 0.]),
        (199, vec![0., 2., 0.5, 0., 1.25, 20000., 0.25]),
        (270, vec![1.]),
        (309, vec![0., 2., 2., 0., 0., 2., 2., 1., 2., 3., 4.]),
        (320, vec![7., 1., 0., 1., 2., 3., 4., 2., 65., 66.]),
        (
            330,
            vec![
                0.5,
                20000.,
                1.,
                0.25,
                20000.,
                0.,
                0.75,
                20000.,
                f32(0.12),
                0.75,
                20000.,
                0.,
                0.75,
                20000.,
                0.,
            ],
        ),
        (
            345,
            vec![9., 0., 1., 0.75, 0.5, 1., 12000., 0.25, 1., 0., 0.5, 0.25],
        ),
    ] {
        assert_eq!(
            &p[offset..offset + expected.len()],
            &expected,
            "offset {offset}"
        );
    }
    assert_eq!(&p[p.len() - 256..], &[5., 6., 7., 8.].repeat(64));
    let p = f.floats("ui_nodes_packet", 0);
    assert_eq!(p.len(), 1101);
    assert_eq!(&p[..2], &[11., 0.]);
    assert_eq!(&p[21..24], &[1024., 1024., 0.]);
    assert_eq!(&p[24..1048], &vec![65.; 1024]);
    assert_eq!(&p[1048..1050], &[12., 1.]);
    assert_eq!(&p[1075..1077], &[13., 0.]);
    assert_eq!(f.floats("events_packet", 0), vec![65., 7., 1., 2., 3.]);
    assert!(matches!(
        f.call("renderer_ready", 0).unwrap(),
        Value::Bool(true)
    ));
    for (x, w) in [(0, false), (1, true)] {
        assert!(matches!(f.call("session_started",x).unwrap(),Value::Bool(v) if v==w));
    }
    f.traps("session_started", 2);
    for op in 0..=6 {
        assert_eq!(f.number("commands_packet", [1., op as f64]), op as f64)
    }
    f.traps("commands_packet", [1., 7.]);
    f.traps("commands_packet", [2., 2.]);
    assert_eq!(
        (0..3)
            .map(|i| f.number("settings_back", i))
            .collect::<Vec<_>>(),
        vec![9., 3., 1.]
    );
    assert_eq!(
        f.floats("platform_packet", 0),
        vec![0., 255., 0., 0., 0., 0.]
    );
    assert_eq!(
        f.floats("service_packet", 0),
        vec![16777215., 5., 255., 1., 2., 3., 4., 2., -0.25, 0.5]
    );
}
#[test]
fn pen_preferences_and_scene_caps_stay_separate() {
    let mut f = Fixture::new("tests/pen.blot");
    assert!(matches!(
        f.call("occlusion_default", 0).unwrap(),
        Value::Bool(true)
    ));
    for flags in 0..4 {
        let p = f.floats("occlusion_packet", flags);
        let preferred = (flags / 2) as f64;
        assert_eq!(p[71], (flags % 2) as f64 * preferred);
        assert_eq!(
            &p[151..165],
            &[
                1., 0., 1., 0., 0., preferred, 0., 1., 0., 0.5, 0.75, 0.25, 0., 0.
            ]
        );
    }
    assert_eq!(f.number("render_scale_default", 0), 2.);
    for preferred in [0.5f64, 0.75, 1., 1.5, 2.] {
        for cap in [-1f64, 0.5, 0.75, 1., 1.5, 2., 3.] {
            let p = f.floats("render_scale_packet", [preferred, cap, 1.]);
            assert_eq!(p[69], preferred.min(cap.clamp(0.5, 2.)));
            assert_eq!(
                &p[151..165],
                &[
                    1., 0., preferred, 0., 0., 0., 0., 1., 0., 0.5, 0.75, 0.25, 0., 0.
                ]
            );
        }
    }
    let p = f.floats("render_scale_packet", [2., 0.5, 0.]);
    assert_eq!((p[69], p[11], p.len()), (0.5, 0., 166));
}
#[test]
fn adapter_parent_indices_and_presentation_snapshots() {
    let mut f = Fixture::new("tests/perf/adapters.blot");
    let pairs = vec![
        0u32,
        0,
        9,
        0,
        9,
        9,
        10,
        9,
        8,
        10,
        7,
        8,
        11,
        12,
        12,
        11,
        u32::MAX,
        0,
        13,
        u32::MAX,
        8,
        0,
        14,
        8,
    ];
    assert_eq!(
        f.words("parent_indices", pairs),
        vec![0, 0, 2, 2, 4, 5, 0, 7, 0, 9, 0, 5]
    );
    let mut f = Fixture::new("tests/perf/presentation.blot");
    for entry in ["render_columns", "render_meshes"] {
        assert_eq!(f.floats(entry, 0), vec![0.; 3]);
    }
    let old = (0..35).filter(|i| i % 4 != 0).collect::<Vec<_>>();
    let next = old
        .iter()
        .copied()
        .filter(|i| *i > 3)
        .chain([35])
        .collect::<Vec<_>>();
    let x = |i| if i == 35 { 999. } else { (i * 10 + 2) as f64 };
    let expected = [
        old.iter()
            .flat_map(|i| [*i as f64, (i * 10) as f64, *i as f64])
            .collect::<Vec<_>>(),
        next.iter()
            .flat_map(|i| [*i as f64, x(*i), *i as f64])
            .collect(),
        vec![100., 0., 101., 0.],
        next.iter().flat_map(|i| [*i as f64, x(*i)]).collect(),
        vec![102., 0.],
    ]
    .concat();
    assert_eq!(f.floats("render_snapshots", ()), expected);
}
