use crate::*;
#[test]
fn frozen_pen_bindings_record_schema_generator_and_content_hashes() {
    use sha2::{Digest, Sha256};
    let dir = root().join("tests/fixtures/pen");
    let p: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("provenance.json")).unwrap()).unwrap();
    assert_eq!(
        p["contract"],
        serde_json::json!({"magic":4670534,"header_lanes":219,"event_lanes":5,"draw_lanes":24,"inset_lanes":48,"ui_head_lanes":24})
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
    assert_eq!(p.len(), 643 + HEADER_GROWTH);
    for (offset, expected) in [
        (
            0,
            vec![4670534., 3., 0., 1., 1., 6., 1., 1., 1., 1., 1., 15.],
        ),
        (157, vec![1., 11., 0., 0., 1., 10., 5., 1.]),
        (174, vec![1., 1.]),
        // The exposure and grade at the header's end: a fixed exposure of nothing, auto
        // exposure's usual limits and speeds, and a grade that changes nothing.
        (
            181,
            vec![
                0.,
                0.,
                -6.,
                6.,
                3.,
                1.,
                f32(0.1),
                f32(0.9),
                0.,
                -10.,
                6.,
                f32(0.18),
                0.,
                0.,
                0.,
                0.,
                0.,
                1.,
                f32(0.18),
                1.,
                0.,
                0.,
                0.,
                0.,
                1.,
                1.,
                1.,
                1.,
                1.,
                1.,
                0.,
                0.,
                0.,
                1.,
                0.,
                0.5,
                // Screen-space reflections off (the player's tier is off), and the budget's default.
                0.,
                2.,
            ],
        ),
        (180 + HEADER_GROWTH, vec![0., 0.]),
        (
            182 + HEADER_GROWTH,
            vec![
                1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
            ],
        ),
        (198 + HEADER_GROWTH, vec![4., 1., 2., 3., 4., 32.]),
        (204 + HEADER_GROWTH, vec![1., 0., 1., 0., 1., 0.]),
        (
            228 + HEADER_GROWTH,
            vec![0., 2., 0.5, 0., 1.25, 20000., 0.25],
        ),
        (299 + HEADER_GROWTH, vec![1.]),
        (
            339 + HEADER_GROWTH,
            vec![0., 2., 2., 0., 0., 2., 2., 1., 2., 3., 4.],
        ),
        (
            350 + HEADER_GROWTH,
            vec![7., 1., 0., 1., 2., 3., 4., 2., 65., 66.],
        ),
        (
            360 + HEADER_GROWTH,
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
            375 + HEADER_GROWTH,
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
    // std/kernel fnv1a64_f32s matches Rust FNV-1a over little-endian IEEE-754 bits bit-for-bit.
    let sample: Vec<f32> = vec![0.0, -0.0, 1.0, 2.0, -42.5, 16_777_216.0];
    let mut rust_hash: u64 = 0xcbf2_9ce4_8422_2325;
    for v in &sample {
        for byte in v.to_bits().to_le_bytes() {
            rust_hash ^= u64::from(byte);
            rust_hash = rust_hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    let blot_hash = f.words(
        "kernel_fnv1a64_f32s",
        sample.iter().map(|v| f64::from(*v)).collect::<Vec<_>>(),
    );
    assert_eq!(
        blot_hash,
        vec![(rust_hash & 0xffff_ffff) as u32, (rust_hash >> 32) as u32]
    );
    // Shared host.measure_frame_floats matches 1 + encoded.length with & without extensions.
    for with_ext in [0u32, 1u32] {
        let pair = f.words("measure_matches_encoded", with_ext);
        assert_eq!(pair.len(), 2);
        assert_eq!(pair[0], pair[1], "with_ext={with_ext}");
    }
    // Separate canonical (0x800000) & kernel (request == 0 / service == 15) transport lanes.
    assert_eq!(
        f.floats("kernel_and_canonical_separation", 0),
        vec![
            8_388_607., 8_388_608., 2., 99., 77., 1., 5., 123.5, 456.5, 0., 1., 3., 42.,
        ]
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
            &p[HEADER_LANES..HEADER_LANES + 14],
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
                &p[HEADER_LANES..HEADER_LANES + 14],
                &[
                    1., 0., preferred, 0., 0., 0., 0., 1., 0., 0.5, 0.75, 0.25, 0., 0.
                ]
            );
        }
    }
    let p = f.floats("render_scale_packet", [2., 0.5, 0.]);
    assert_eq!((p[69], p[11], p.len()), (0.5, 0., 195 + HEADER_GROWTH));
}
#[test]
fn shadow_settings_cascades_and_a_shadow_casting_spot_light_survive_the_encoder() {
    use crate::shadow::{Case, check_fit};
    let mut f = Fixture::new("tests/pen.blot");
    // Header lanes of the generated protocol: the shadow view, then texels,
    // filter, softness, contact steps, contact length, local casters and their
    // map size; the light and cascade counts follow the quality lanes.
    let (shadow_view, shadow_texels, light_count, cascade_count) = (128, 144, 168, 169);
    // The light's two rows: a spot light that casts shadows, then a point light.
    let (cos_inner, cos_outer) = ((0.25f64).cos(), (0.5f64).cos());
    let lights = [
        [
            1., 3., -2., 12., 2., 1.5, 1., 0., -1., 0., cos_inner, cos_outer, 1., 77.,
        ],
        [
            -1., 1., 0.5, 4., 0.5, 0.25, 0.125, 0., 1., 0., 1., -1., 0., 0.,
        ],
    ]
    .concat();
    // The player's tier decides what is asked of the host: 0 off, then 1024
    // low, 2048 medium, 4096 high.
    for (tier, cascades, filter, contact, local, local_texels) in [
        (0., 0, 0., 0., 0., 0.),
        (1024., 2, 1., 0., 0., 0.),
        (2048., 3, 2., 12., 2., 512.),
        (4096., 4, 2., 20., 4., 1024.),
    ] {
        let p = f.floats("shadow_packet", tier);
        assert_eq!((p[light_count], p[cascade_count]), (2., cascades as f64));
        let settings = if cascades == 0 {
            [0., 0., 0., 0., 0., 0., 0.]
        } else {
            [
                tier,
                filter,
                f32(0.06),
                contact,
                f32(0.75),
                local,
                local_texels,
            ]
        };
        assert_eq!(&p[shadow_texels..shadow_texels + 7], &settings);
        // The lights follow the header's sections, and the cascades the lights.
        let row = p
            .windows(lights.len())
            .position(|w| {
                w.iter()
                    .zip(&lights)
                    .all(|(a, b)| (a - b).abs() <= 1e-6 * b.abs().max(1.))
            })
            .expect("both lights are in the packet, in order");
        assert!(row >= HEADER_LANES);
        assert_eq!(p[row + 12], 1., "the spot light asks for shadows");
        assert_eq!(p[row + 13], 77.);
        assert_eq!((p[row + 26], p[row + 27]), (0., 0.));
        if cascades == 0 {
            assert_eq!(&p[shadow_view..shadow_view + 16], &identity());
            continue;
        }
        // The same case through the f64 reference: pose, a 60 degree lens
        // 1.5 wide, the sun, then the plan the quality tier and frame make.
        let case = Case::new(&[
            0.,
            2.,
            5.,
            0.3,
            -0.2,
            0.,
            std::f64::consts::PI / 3.,
            1.5,
            0.1,
            200.,
            0.,
            -0.4,
            -1.,
            -0.3,
            cascades as f64,
            tier,
            60.,
            0.75,
        ]);
        let rows = &p[row + lights.len()..row + lights.len() + 18 * cascades];
        let outside = check_fit(&case, &p[shadow_view..shadow_view + 16], rows);
        assert!(outside <= 1e-6, "{outside}");
    }
}
fn identity() -> [f64; 16] {
    std::array::from_fn(|i| (i % 5 == 0) as u8 as f64)
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
#[test]
fn probe_volumes_encode_their_header_and_each_probes_twenty_eight_lanes() {
    let mut f = Fixture::new("tests/pen.blot");
    let values: Vec<f64> = (0..56).map(|i| (i as f64) * 0.25 - 3.0).collect();
    let p = f.floats("probe_packet", values.clone());
    assert_eq!(&p[117..125], &[7., 2., 1., 1., 2.5, 1., 2., 3.]);
    assert_eq!(p[170], 2.);
    let start = p
        .windows(56)
        .position(|w| w.iter().zip(&values).all(|(a, b)| a == b))
        .expect("the probes are in the packet, in order");
    assert!(start > HEADER_LANES);
    // Without probes the volume is still described and the count is zero.
    let none = f.floats("occlusion_packet", 0);
    assert_eq!((none[118], none[170]), (0., 0.));
}

#[test]
fn reflection_probes_encode_their_fields_and_the_quality_tiers_cap_the_march() {
    let mut f = Fixture::new("tests/pen.blot");
    let p = f.floats("reflection_packet", vec![2., 1., 3.]);
    // The header: two probes, the lower of the game's and the player's march, the budget.
    assert_eq!((p[171], p[217], p[218]), (2., 1., 3.));
    let first = [
        // id, revision, priority, capture, position, centre, extent, blend, parallax, far.
        70000., 3., 2., 1., 1., 2., 3., 1.5, 2.5, 3.5, 4., 5., 6., 0.75, -1., -2., -3., 7., 8., 9.,
        40.,
    ];
    let second = [
        9., 1., 0., 0., 0., 1., 0., 0., 1., 0., 2., 1., 2., 0., 0., 1., 0., 2., 1., 2., 6.,
    ];
    let both: Vec<f64> = first
        .iter()
        .chain(&second)
        .copied()
        .map(|v| f64::from(v as f32))
        .collect();
    let start = p
        .windows(42)
        .position(|w| w == both.as_slice())
        .expect("the probes are in the packet, in order");
    assert!(start >= HEADER_LANES);
    // The game asks for less than the player allows, and the player for none.
    assert_eq!(f.floats("reflection_packet", vec![1., 2., 6.])[217], 1.);
    assert_eq!(f.floats("reflection_packet", vec![2., 0., 6.])[217], 0.);
    assert_eq!(f.floats("reflection_packet", vec![2., 2., 6.])[217], 2.);
    // No probes: none are counted, and the default budget stays.
    let none = f.floats("occlusion_packet", 0);
    assert_eq!((none[171], none[217], none[218]), (0., 0., 2.));
}

/// One retained instance as the wire holds it: its id's two halves, its order, mesh and
/// material 0, a translation of (1.5, -2.5, 3.5), and the optional parameters (-0, 2, -3,
/// 4 behind their count) when it has them.
fn instance_lanes(id: u32, order: f64, parameters: bool) -> Vec<f64> {
    let mut lanes = vec![(id & 65535) as f64, (id >> 16) as f64, order, 0., 0.];
    lanes.extend([
        1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 1.5, -2.5, 3.5, 1.,
    ]);
    lanes.extend(if parameters {
        vec![4., -0.0, 2., -3., 4.]
    } else {
        vec![0.; 5]
    });
    lanes
}

/// The packet `encoded` makes of `count` updates of one instance and `removed` removals: its
/// length, then (when it is built) the retained header lanes and the packet's last sixty.
fn encoded(
    f: &mut Fixture,
    id: u32,
    order: f64,
    extra: f64,
    count: f64,
    removed: f64,
    parameters: bool,
) -> Vec<f64> {
    f.floats(
        "encoded",
        [
            (id & 65535) as f64,
            (id >> 16) as f64,
            order,
            extra,
            count,
            removed,
            parameters as u8 as f64,
        ],
    )
}

fn traps_with(f: &mut Fixture, what: &str, input: [f64; 7]) {
    let error = f.call("encoded", input.to_vec()).expect_err(what);
    assert_eq!(
        error.downcast_ref::<wasmtime::Trap>(),
        Some(&wasmtime::Trap::UnreachableCodeReached),
        "{what}: {error:#}"
    );
}

#[test]
fn a_retained_instance_keeps_every_bit_of_its_id_and_order_in_the_encoder() {
    let mut f = Fixture::new("tests/pen-instances.blot");
    // Ids are full width: both 16-bit halves travel, whatever the id; orders reach 2^24 - 1.
    for id in [
        0u32,
        1,
        2,
        3,
        65535,
        65536,
        65537,
        0x00ff_ffff,
        0x0100_0000,
        0x8000_0000,
        u32::MAX - 1,
        u32::MAX,
    ] {
        for (order, parameters) in [(0., false), (16_777_215., true), (1., id & 1 == 1)] {
            let p = encoded(&mut f, id, order, 0., 1., 0., parameters);
            let instance = &p[p.len() - 26..];
            assert_eq!(
                instance,
                instance_lanes(id, order, parameters),
                "id {id} order {order}"
            );
            // The retained header lanes: enabled, not reset, after no draws, one update, no removals.
            assert_eq!(&p[1..6], [1., 0., 0., 1., 0.], "id {id}");
            // The sign of the zero in the optional parameters survives.
            if parameters {
                assert!(
                    p[p.len() - 4].is_sign_negative() && p[p.len() - 4] == 0.0,
                    "id {id}"
                );
            }
        }
    }
    // Removals name their ids' two halves too.
    for gone in [1u32, 2] {
        let p = encoded(&mut f, 0x0123_4567, 5., 0., 1., gone as f64, false);
        let n = p.len();
        for index in 0..gone as usize {
            let id = u32::MAX - index as u32;
            let at = n - 2 * gone as usize + 2 * index;
            assert_eq!(&p[at..at + 2], [(id & 65535) as f64, (id >> 16) as f64]);
        }
        assert_eq!(
            &p[n - 2 * gone as usize - 26..n - 2 * gone as usize],
            instance_lanes(0x0123_4567, 5., false)
        );
    }
}

#[test]
fn the_encoder_traps_on_an_order_extra_data_or_counts_the_wire_cannot_hold() {
    let mut f = Fixture::new("tests/pen-instances.blot");
    let (updates, removals) = (100_000., 100_000.);
    // At the limits it encodes: the last order, the most updates, the most removals.
    let one = encoded(&mut f, 7, 16_777_215., 0., 1., 0., false);
    assert_eq!(&one[1..6], [1., 0., 0., 1., 0.]);
    // (The packet's other sections, the buses here, are the same size whatever the instances.)
    let most = encoded(&mut f, 7, 0., 0., updates, removals, false);
    assert_eq!(most[0] - one[0], 26. * (updates - 1.) + 2. * removals);
    assert_eq!(&most[1..6], [1., 0., 0., updates, removals]);
    // One past traps instead of rounding or truncating; the next frame is unharmed.
    for (what, input) in [
        ("an order of 2^24", [7., 0., 16_777_216., 0., 1., 0., 0.]),
        (
            "an order of 2^24 + 1",
            [7., 0., 16_777_217., 0., 1., 0., 0.],
        ),
        (
            "the largest order",
            [7., 0., 4_294_967_295., 0., 1., 0., 0.],
        ),
        ("one extra vector", [7., 0., 0., 1., 1., 0., 0.]),
        ("two extra vectors", [7., 0., 0., 2., 1., 0., 1.]),
        (
            "one update past the limit",
            [7., 0., 0., 0., updates + 1., 0., 0.],
        ),
        (
            "one removal past the limit",
            [7., 0., 0., 0., 1., removals + 1., 0.],
        ),
    ] {
        traps_with(&mut f, what, input);
        assert_eq!(
            encoded(&mut f, 7, 16_777_215., 0., 1., 0., true).len(),
            1 + 5 + 60,
            "after {what}"
        );
    }
}

#[test]
fn attach_rejects_the_same_streams_before_they_reach_the_encoder() {
    let mut f = Fixture::new("tests/pen-instances.blot");
    let (updates, removals) = (100_000., 100_000.);
    // It accepts what fits, up to the limits, and refuses the rest without touching the frame:
    // the answer is whether it was accepted, then the frame's updates, removals and retained flag.
    let mut attached = |count: f64, order: f64, extra: f64, removed: f64| {
        f.floats("attached", [count, order, extra, removed])
    };
    assert_eq!(attached(1., 0., 0., 0.), [1., 1., 0., 1.]);
    assert_eq!(attached(3., 16_777_215., 0., 2.), [1., 3., 2., 1.]);
    assert_eq!(
        attached(updates, 0., 0., removals),
        [1., updates, removals, 1.]
    );
    for (what, rejected) in [
        (
            "an update past the limit",
            attached(updates + 1., 0., 0., 0.),
        ),
        (
            "a removal past the limit",
            attached(1., 0., 0., removals + 1.),
        ),
        ("an order of 2^24", attached(3., 16_777_216., 0., 0.)),
        ("one extra vector", attached(3., 0., 1., 0.)),
        ("two extra vectors", attached(3., 0., 2., 0.)),
    ] {
        assert_eq!(rejected, [0., 0., 0., 0.], "{what}");
    }
}

#[test]
fn exposure_and_the_grade_reach_the_packets_header_as_the_game_set_them() {
    let mut f = Fixture::new("tests/pen.blot");
    let p = f.floats("look_packet", 0);
    // Exposure: auto, compensation, least, most, brighten, darken, low, high, centre, the
    // histogram's range, middle grey, the game's seconds, and a cut.
    assert_eq!(
        &p[181..195],
        &[
            1., 0.5, -3., 4., 2., 0.5, 0.0625, 0.9375, 0.25, -8., 8., 0.25, 0.0625, 1.
        ]
    );
    // The grade: white balance, exposure, contrast, pivot, saturation, vibrance, lift, gamma,
    // gain, the tables (1 plus their materials), their blend and weight, the vignette.
    assert_eq!(
        &p[195..HEADER_LANES - 2],
        &[
            0.25, -0.125, 0.5, 1.5, 0.25, 0.75, 0.5, 0.0625, 0.125, 0.1875, 1.5, 2., 0.5, 1.25,
            1.5, 2., 1., 8., 0.375, 0.875, 0.5, 0.25,
        ]
    );
}
