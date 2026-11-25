//! Permanent deterministic adversarial fuzz & property suite for Ink.
//! Exercises extreme floats (±3.4e38, subnormals, NaN, ±Inf, -0.0), extreme
//! U32 values (0, 0x80000000, u32::MAX), and truncated/mutated wire packets
//! across Ink's Wasm-compiled library modules.

use crate::*;

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn u32(&mut self) -> u32 {
        (self.u64() >> 16) as u32
    }

    fn adversarial_f64(&mut self) -> f64 {
        const PALETTE: &[f32] = &[
            0.0,
            -0.0,
            1.0,
            -1.0,
            0.5,
            -0.5,
            2.0,
            -2.0,
            1e-44,
            -1e-44,
            f32::MIN_POSITIVE,
            -f32::MIN_POSITIVE,
            1e-25,
            -1e-25,
            1e-10,
            1e-5,
            1e5,
            1e10,
            2.0e20,
            -2.0e20,
            2.0e38,
            -2.0e38,
            3.4e38,
            -3.4e38,
            f32::MAX,
            -f32::MAX,
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::NAN,
            100000.0,
            -100000.0,
        ];
        let roll = self.u32() % 100;
        if roll < 70 {
            let idx = (self.u32() as usize) % PALETTE.len();
            f64::from(PALETTE[idx])
        } else if roll < 90 {
            let unit = (self.u32() >> 8) as f64 / 16777216.0;
            (unit * 2.0 - 1.0) * 50.0
        } else {
            let bits = self.u32();
            f64::from(f32::from_bits(bits))
        }
    }

    fn finite_extreme_f64(&mut self) -> f64 {
        loop {
            let v = self.adversarial_f64();
            if v.is_finite() {
                return v;
            }
        }
    }

    fn adversarial_u32(&mut self) -> u32 {
        const WORDS: &[u32] = &[
            0,
            1,
            2,
            3,
            4,
            7,
            8,
            15,
            16,
            255,
            65535,
            65536,
            0x5242_4B31, // rollback packet magic
            0x5250_4C31, // replication packet magic
            0x5250_4C41, // replication ack magic
            0x7FFF_FFFF,
            0x8000_0000,
            0xFFFF_FFFE,
            0xFFFF_FFFF,
        ];
        if self.u32() % 100 < 65 {
            WORDS[(self.u32() as usize) % WORDS.len()]
        } else {
            self.u32()
        }
    }

    fn floats(&mut self, len: usize) -> Vec<f64> {
        (0..len).map(|_| self.adversarial_f64()).collect()
    }

    fn finite_floats(&mut self, len: usize) -> Vec<f64> {
        (0..len).map(|_| self.finite_extreme_f64()).collect()
    }

    fn words(&mut self, len: usize) -> Vec<u32> {
        (0..len).map(|_| self.adversarial_u32()).collect()
    }
}

fn assert_all_finite(name: &str, iter: usize, input: &[f64], output: &[f64]) {
    assert!(
        output.iter().all(|v| v.is_finite()),
        "{name} produced non-finite output at iter {iter}:\n  input  = {input:?}\n  output = {output:?}"
    );
}

#[test]
fn fuzz_math_shapes_physics_and_acoustics_never_trap_or_poison() {
    let mut f = Fixture::new("tests/fuzz_harness.blot");
    let mut rng = Rng::new(0x1A2B_3C4D_5E6F_7789);

    for i in 0..200 {
        let xs = if i % 2 == 0 {
            rng.floats(26)
        } else {
            rng.finite_floats(26)
        };
        for entry in [
            "fuzz_math",
            "fuzz_shapes",
            "fuzz_physics2d",
            "fuzz_soft",
            "fuzz_net_interest",
        ] {
            let out = f.floats(entry, xs.clone());
            assert_all_finite(entry, i, &xs, &out);
        }
    }

    // Acoustics runs scene builds & ray loops: 64 adversarial iterations cover every float corner.
    for i in 0..64 {
        let xs = if i % 2 == 0 {
            rng.floats(26)
        } else {
            rng.finite_floats(26)
        };
        let out = f.floats("fuzz_acoustics", xs.clone());
        assert_all_finite("fuzz_acoustics", i, &xs, &out);
    }
}

#[test]
fn fuzz_nav_ai_anim_ui_audio_and_render_math_never_trap_or_poison() {
    let mut f = Fixture::new("tests/fuzz_harness.blot");
    let mut rng = Rng::new(0x9E37_79B9_7F4A_7C15);

    for i in 0..160 {
        let xs = if i % 2 == 0 {
            rng.floats(27)
        } else {
            rng.finite_floats(27)
        };
        for entry in [
            "fuzz_ai_goap",
            "fuzz_nav_links",
            "fuzz_motion_match",
            "fuzz_ui_layout",
            "fuzz_ui_rich_text",
            "fuzz_audio_mix",
            "fuzz_render_math",
            "fuzz_replication_floats",
        ] {
            let out = f.floats(entry, xs.clone());
            assert_all_finite(entry, i, &xs, &out);
        }
    }

    // Navigation flow fields on 4x4 grids with adversarial costs (0, negative, huge, subnormal, NaN).
    for i in 0..120 {
        let xs = rng.floats(16);
        let out = f.floats("fuzz_nav_flow", xs.clone());
        assert_all_finite("fuzz_nav_flow", i, &xs, &out);
    }
}

#[test]
fn fuzz_wire_packets_codecs_sort_and_frozen_map_differential() {
    let mut f = Fixture::new("tests/fuzz_harness.blot");
    let mut rng = Rng::new(0xD1B5_4A32_D192_ED03);

    // Wire decoders & codecs on arbitrary / truncated / extreme word buffers.
    for i in 0..240 {
        let len = (rng.u32() % 40) as usize;
        let ws = rng.words(len);
        let rep = f.words("fuzz_replication_words", ws.clone());
        assert_eq!(rep.len(), 3, "replication words iter {i}");
        let rbk = f.words("fuzz_rollback_packet", ws.clone());
        assert_eq!(rbk.len(), 3, "rollback packet iter {i}");
        let cod = f.words("fuzz_codec_words", ws.clone());
        assert_eq!(cod.len(), 2, "codec words iter {i}");
        assert_eq!(
            cod[1], 1,
            "codec pack/unpack roundtrip failed at iter {i}: {ws:?}"
        );

        let flen = (rng.u32() % 24) as usize;
        let xs = rng.floats(flen);
        let cfl = f.words("fuzz_codec_floats", xs);
        assert_eq!(cfl.len(), 3, "codec floats iter {i}");
    }

    // Differential oracle for `sort.order`: valid permutation, ascending non-NaN prefix, stable NaNs at end.
    for i in 0..160 {
        let len = (rng.u32() % 24) as usize;
        let xs = rng.floats(len);
        let ord = f.words("fuzz_sort", xs.clone());
        assert_eq!(ord.len(), len, "sort length mismatch at iter {i}");
        let mut seen = vec![false; len];
        for &idx in &ord {
            let u = idx as usize;
            assert!(
                u < len && !seen[u],
                "sort invalid permutation at iter {i}: {ord:?}"
            );
            seen[u] = true;
        }
        let mut seen_nan = false;
        let mut prev_val: Option<f64> = None;
        let mut prev_nan_idx: Option<u32> = None;
        for &idx in &ord {
            let v = xs[idx as usize];
            if v.is_nan() {
                seen_nan = true;
                if let Some(p) = prev_nan_idx {
                    assert!(idx > p, "NaN order unstable at iter {i}: {ord:?}");
                }
                prev_nan_idx = Some(idx);
            } else {
                assert!(
                    !seen_nan,
                    "non-NaN appeared after NaN at iter {i}: {xs:?} -> {ord:?}"
                );
                if let Some(p) = prev_val {
                    assert!(p <= v, "sort not ascending at iter {i}: {p} > {v}");
                }
                prev_val = Some(v);
            }
        }
    }

    // Differential oracle for `map/frozen` vs `map.Map`: exact key/value/order/collision parity.
    for i in 0..160 {
        let len = ((rng.u32() % 32) * 2) as usize;
        let ws = rng.words(len);
        let res = f.words("fuzz_frozen_map", ws.clone());
        assert_eq!(
            res[0], 1,
            "map/frozen diverged from map.Map at iter {i}: {ws:?}"
        );
    }
}
