use crate::*;
#[test]
fn codec_records_variants_nested_collections_and_validation() {
    let mut f = Fixture::new("tests/codec.blot");
    assert_eq!(
        f.words("persistence", ()),
        vec![16777219, u32::MAX, 16777217, 3, 3]
    );
    assert_eq!(f.words("inspection", ()), vec![30]);
    assert_eq!(f.words("migration", ()), vec![u32::MAX, 0, u32::MAX]);
    let mut words = f.words("delivery_encode", ());
    assert_eq!(f.number("delivery_decode", words.clone()), 1.);
    *words.last_mut().unwrap() = 0;
    assert_eq!(f.number("delivery_decode", words), 0.);
}
#[test]
fn codec_bit_exact_words_floats_and_invalid_framing() {
    let mut f = Fixture::new("tests/codec.blot");
    let words = vec![0, 16777217, 0x80000000, u32::MAX];
    let packed = f.floats("packed", words.clone());
    assert_eq!(f.words("unpacked", packed.clone()), words);
    for value in [-0., 0., -0.125, 0.375, f32(1e-40), f32(3e38)] {
        let encoded = f.words("float_bits", value);
        assert_eq!(encoded, vec![(value as f32).to_bits()]);
        let read = f.floats("float_read", encoded);
        assert_eq!(read[0], 1.);
        assert_eq!((read[1] as f32).to_bits(), (value as f32).to_bits());
    }
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        f.traps("float_bits", value)
    }
    for bits in [0x7f800000u32, 0xff800000, 0x7fc00001] {
        assert_eq!(f.floats("float_read", vec![bits]), vec![0.]);
    }
    for value in [f64::NAN, f64::INFINITY, -1., 65536., 0.5] {
        let mut bad = packed.clone();
        bad[3] = value;
        assert!(f.words("unpacked", bad).is_empty());
    }
    let saved = f.words("encoded", u32::MAX);
    assert_eq!(
        f.words("decoded", saved.clone()),
        vec![1, u32::MAX, 16777217]
    );
    for end in 0..saved.len() {
        assert_eq!(f.words("decoded", saved[..end].to_vec()), vec![0]);
    }
    assert_eq!(
        f.words("decoded", [saved.clone(), vec![0]].concat()),
        vec![0]
    );
    for (at, value) in [
        (0, 2),
        (1, 9),
        (2, 8),
        (3, 99),
        (4, u32::MAX),
        (14, 0x7f800000),
    ] {
        let mut bad = saved.clone();
        bad[at] = value;
        assert_eq!(f.words("decoded", bad), vec![0]);
    }
}
