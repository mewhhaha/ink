use super::*;

// Independent Rust reference for Ink's i18n CLDR cardinal plurals and BCP 47 RTL
// detection, plus a live witness check for the headless UI + role-testing suite.

const ZERO: u32 = 0;
const ONE: u32 = 1;
const TWO: u32 = 2;
const FEW: u32 = 3;
const MANY: u32 = 4;
const OTHER: u32 = 5;

#[test]
fn i18n_cldr_plurals_match_reference() {
    let mut f = Fixture::new("tests/ui_headless.sq");
    let cases: &[(&str, f32, u32)] = &[
        // English / German / Swedish
        ("en", 0.0, OTHER),
        ("en", 1.0, ONE),
        ("en", 1.5, OTHER),
        ("en", 2.0, OTHER),
        ("sv-SE", 1.0, ONE),
        ("sv-SE", 2.5, OTHER),
        // French / Portuguese vs pt-PT
        ("fr", 0.0, ONE),
        ("fr", 1.0, ONE),
        ("fr", 1.5, ONE),
        ("fr", 2.0, OTHER),
        ("fr", 1_000_000.0, MANY),
        ("pt-BR", 0.0, ONE),
        ("pt-PT", 0.0, OTHER),
        ("pt-PT", 1.0, ONE),
        ("pt-PT", 1_000_000.0, MANY),
        // Russian / Ukrainian
        ("ru", 1.0, ONE),
        ("ru", 21.0, ONE),
        ("ru", 2.0, FEW),
        ("ru", 4.0, FEW),
        ("ru", 5.0, MANY),
        ("ru", 11.0, MANY),
        ("ru", 12.0, MANY),
        ("ru", 14.0, MANY),
        ("ru", 1.5, OTHER),
        // Polish
        ("pl", 1.0, ONE),
        ("pl", 2.0, FEW),
        ("pl", 22.0, FEW),
        ("pl", 5.0, MANY),
        ("pl", 12.0, MANY),
        ("pl", 21.0, MANY),
        ("pl", 1.5, OTHER),
        // Czech
        ("cs", 1.0, ONE),
        ("cs", 3.0, FEW),
        ("cs", 1.5, MANY),
        ("cs", 5.0, OTHER),
        // Arabic (all 6 CLDR categories)
        ("ar", 0.0, ZERO),
        ("ar", 1.0, ONE),
        ("ar", 2.0, TWO),
        ("ar", 3.0, FEW),
        ("ar", 10.0, FEW),
        ("ar", 11.0, MANY),
        ("ar", 99.0, MANY),
        ("ar", 100.0, OTHER),
        ("ar", 103.0, FEW),
        // Hebrew / Welsh / Irish / Slovenian / Serbian
        ("he", 1.0, ONE),
        ("he", 2.0, TWO),
        ("he", 3.0, OTHER),
        ("cy", 0.0, ZERO),
        ("cy", 1.0, ONE),
        ("cy", 2.0, TWO),
        ("cy", 3.0, FEW),
        ("cy", 6.0, MANY),
        ("cy", 7.0, OTHER),
        ("sl", 101.0, ONE),
        ("sl", 102.0, TWO),
        ("sl", 103.0, FEW),
        ("sl", 105.0, OTHER),
        ("sr", 21.0, ONE),
        ("sr", 23.0, FEW),
        ("sr", 11.0, OTHER),
        // Root languages (ja, zh, ko)
        ("ja", 0.0, OTHER),
        ("ja", 1.0, OTHER),
        ("zh-Hant", 1.0, OTHER),
        ("ko", 2.0, OTHER),
    ];
    let mut packed: Vec<f64> = Vec::new();
    for (tag, count, _) in cases {
        packed.push(tag.chars().count() as f64);
        for ch in tag.chars() {
            packed.push((ch as u32) as f64);
        }
        packed.push(f64::from(*count));
    }
    let actual = f.floats("oracle_plural_cardinal", packed);
    assert_eq!(actual.len(), cases.len());
    for (idx, ((tag, count, expected), got)) in cases.iter().zip(&actual).enumerate() {
        assert_eq!(
            *got as u32, *expected,
            "case {idx}: tag={tag:?} count={count} expected={expected} got={got}"
        );
    }
}

#[test]
fn i18n_rtl_detection_matches_bcp47_scripts() {
    let mut f = Fixture::new("tests/ui_headless.sq");
    let cases: &[(&str, bool)] = &[
        ("ar", true),
        ("ar-EG", true),
        ("he", true),
        ("he-IL", true),
        ("fa-IR", true),
        ("ur", true),
        ("ur-Latn", false),
        ("pa-Arab", true),
        ("az-Arab", true),
        ("uz-Latn", false),
        ("ckb", true),
        ("sd", true),
        ("yi", true),
        ("dv", true),
        ("ug", true),
        ("en-US", false),
        ("sv_SE.UTF-8", false),
        ("zh-Hant-TW", false),
        ("ja", false),
    ];
    let mut packed: Vec<u32> = Vec::new();
    for (tag, _) in cases {
        packed.push(tag.chars().count() as u32);
        for ch in tag.chars() {
            packed.push(ch as u32);
        }
    }
    let actual = f.words("oracle_is_rtl", packed);
    assert_eq!(actual.len(), cases.len());
    for ((tag, expected), got) in cases.iter().zip(&actual) {
        assert_eq!(*got != 0, *expected, "tag={tag:?}");
    }
}
