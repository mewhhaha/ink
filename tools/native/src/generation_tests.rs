use crate::generate::{behavior as b, codec as c, dataflow as d};
use crate::*;
use serde_json::{Value as Json, json};
fn parse<T: serde::de::DeserializeOwned>(v: Json) -> T {
    serde_json::from_value(v).unwrap()
}
fn source_fixture(source: &str) -> Fixture {
    let path = root().join("tests/native_generated.blot");
    Fixture::from_module(&compiled(
        path.to_str().unwrap(),
        &[Overlay {
            path: path.to_string_lossy().into(),
            contents: Some(source.into()),
        }],
    ))
}
fn graph() -> Json {
    json!({"name":"decision","version":1,"entry":0,"local":"U32","action":"U32","condition":"U32","act":"act","ready":"ready","cleanup":"cleanup","nodes":[{"id":0,"kind":"choose","condition":"0","yes":1,"no":2},{"id":1,"kind":"choose","condition":"0","yes":3,"no":99},{"id":2,"kind":"choose","condition":"1","yes":4,"no":5},{"id":99,"kind":"choose","condition":"99","yes":3,"no":4},{"id":3,"kind":"act","action":"7","next":10},{"id":4,"kind":"act","action":"11","next":10},{"id":5,"kind":"act","action":"13","next":10},{"id":10,"kind":"stop"}]})
}
#[test]
fn selectors_preserve_lazy_branches_and_reject_nonselectors() {
    let g: b::Graph = parse(graph());
    let source = format!(
        "import * as _behavior from \"ink/behavior\"\nfunc ready (condition: U32) -> (local: U32) => if condition == 99 then panic \"unreachable condition was evaluated\" else (local >> condition) & 1 != 0\nfunc act (action: U32) -> (tick: _behavior.Tick) -> (_: U32) => $_behavior.Done {{ local: action, remaining: tick.seconds }}\nfunc cleanup (_: U32) -> (local: U32) => local\n{}\n{}\nentry const selected = decision_select\nentry func resumable (local: U32) =>\n  let frames: #[_behavior.Frame] = #[]\n  let visited: #[U32] = #[]\n  let (found, _) = decision_advance (_behavior.start decision_program local) frames visited 0.0 16 0\n  let $Some result = found else:\n    return panic \"graph failed\"\n  return result.state.local\n",
        b::compile(&g).unwrap(),
        b::selector(&g).unwrap()
    );
    let mut f = source_fixture(&source);
    for i in 0..1024 {
        let expected = if i & 1 != 0 {
            7.
        } else if i & 2 != 0 {
            11.
        } else {
            13.
        };
        assert_eq!(f.number("selected", i), expected);
        assert_eq!(f.number("resumable", i), expected);
    }
    for nodes in [
        json!([{"id":0,"kind":"stop"}]),
        json!([{"id":0,"kind":"choose","condition":"0","yes":0,"no":0}]),
        json!([{"id":0,"kind":"delay","seconds":0.1,"next":0}]),
        json!([{"id":0,"kind":"act","action":"7","next":0}]),
    ] {
        let mut g = graph();
        g["nodes"] = nodes;
        assert!(b::selector(&parse(g)).is_err());
    }
    let mut nodes = (0..65)
        .map(|id| json!({"id":id,"kind":"choose","condition":"0","yes":id+1,"no":65}))
        .collect::<Vec<_>>();
    nodes.extend([
        json!({"id":65,"kind":"act","action":"7","next":66}),
        json!({"id":66,"kind":"stop"}),
    ]);
    let mut g = graph();
    g["nodes"] = json!(nodes);
    assert!(b::selector(&parse(g)).is_err());
}
#[test]
fn behavior_generation_matches_checked_fixture_and_validates_graphs() {
    let base = root().join("tests/fixtures/behavior");
    let json: Json =
        serde_json::from_str(&std::fs::read_to_string(base.join("graph.json")).unwrap()).unwrap();
    let g: b::Graph = parse(json.clone());
    let source = std::fs::read_to_string(base.join("actions.blot")).unwrap();
    let generated = format!(
        "// Generated checked behavior; graph IDs are saved-state identity.\nimport * as _behavior from \"ink/behavior\"\n{source}\n{}",
        b::compile(&g).unwrap()
    );
    assert_eq!(
        generated,
        std::fs::read_to_string(base.join("actions_derived.blot")).unwrap()
    );
    let target = base.join("actions_derived.blot");
    compiled(
        "tests/compiled-behavior.blot",
        &[Overlay {
            path: target.to_string_lossy().into(),
            contents: Some(generated),
        }],
    );
    for (field, value) in [
        ("entry", json!(999)),
        ("version", json!(-1)),
        (
            "nodes",
            json!(g.nodes.iter().map(|_| 0).collect::<Vec<_>>()),
        ),
        ("nodes", json!([{"id":10,"kind":"again","owner":10}])),
    ] {
        let mut bad = json.clone();
        bad[field] = value;
        assert!(
            serde_json::from_value::<b::Graph>(bad)
                .map_err(anyhow::Error::from)
                .and_then(|g| b::compile(&g))
                .is_err()
        );
    }
    let mut bad = g.clone();
    bad.nodes.push(bad.nodes[0].clone());
    assert!(b::compile(&bad).is_err());
    bad = g;
    bad.nodes = vec![b::Node {
        id: 10,
        op: b::Op::Delay {
            seconds: f64::INFINITY,
            next: 10,
        },
    }];
    assert!(b::compile(&bad).is_err());
}
fn dataflow() -> Json {
    json!({"name":"prepared","input":{"name":"snapshot","type":"U32"},"result":"U32","steps":[{"id":"joined","call":"sum","args":["a","b"]},{"id":"a","call":"twice","args":["snapshot"]},{"id":"b","call":"next","args":["snapshot"]}],"finish":{"call":"identity","args":["joined"]}})
}
#[test]
fn dataflow_dependency_order_results_and_effect_rejection() {
    let r = d::compile(&parse(dataflow())).unwrap();
    assert_eq!(r.waves, vec![vec![1, 2], vec![0]]);
    let mut f = source_fixture(&format!(
        "func twice (x: U32) => return x * 2\nfunc next (x: U32) => return x + 1\nfunc sum (a: U32) -> (b: U32) => return a + b\n{}\nentry const run = prepared\n",
        r.source
    ));
    for i in 0..1024 {
        assert_eq!(f.number("run", i), (3 * i + 1) as f64);
    }
    let path = root().join("tests/native_effectful.blot");
    let source = format!(
        "type Observed is effect = U32 -> U32\nfunc twice (x: U32) => return Observed x\nfunc next (x: U32) => return x + 1\nfunc sum (a: U32) -> (b: U32) => return a + b\n{}\nentry func run (x: U32) => return do (@effect.provider Observed (func n => return n)):\n  return prepared x\n",
        r.source
    );
    let result = build(
        path.to_str().unwrap(),
        &[Overlay {
            path: path.to_string_lossy().into(),
            contents: Some(source),
        }],
    );
    assert!(
        matches!(result,BuildResult::Rejected(ref e) if format!("{e:?}").contains("let_effect"))
    );
    for choice in 0..5 {
        let mut g = dataflow();
        match choice {
            0 => {
                let step = g["steps"][0].clone();
                g["steps"].as_array_mut().unwrap().push(step);
            }
            1 => g["steps"]
                .as_array_mut()
                .unwrap()
                .push(json!({"id":"extra","call":"twice","args":["snapshot"]})),
            2 => g["finish"]["args"] = json!(["unknown"]),
            3 => {
                g["steps"] = json!([{"id":"loop","call":"next","args":["loop"]}]);
                g["finish"]["args"] = json!(["loop"]);
            }
            _ => g["finish"]["args"] = json!(["(panic)"]),
        }
        assert!(d::compile(&parse(g)).is_err());
    }
}
fn codec_source() -> (String, c::Schema, c::Published) {
    let base = root().join("tests/fixtures/derived");
    (
        std::fs::read_to_string(base.join("model.blot")).unwrap(),
        serde_json::from_slice(&std::fs::read(base.join("schema.json")).unwrap()).unwrap(),
        serde_json::from_slice(&std::fs::read(base.join("published.json")).unwrap()).unwrap(),
    )
}
#[test]
fn codec_generation_reproducible_layout_stable_and_reordering_preserves_words() {
    let (source, mut plan, previous) = codec_source();
    let (code, _) = c::generate(&source, &plan, &previous, true).unwrap();
    let old = std::fs::read_to_string(root().join("tests/fixtures/derived/model_derived.blot"))
        .unwrap()
        .replacen(
            "// Generated by Ink using upstream checked derivation.",
            "// Generated by Ink; checked by Pen's native Blot compiler.",
            1,
        );
    assert_eq!(code, old);
    let path = root().join("tests/fixtures/derived/model_derived.blot");
    let mut f = Fixture::from_module(&compiled(
        "tests/codec.blot",
        &[Overlay {
            path: path.to_string_lossy().into(),
            contents: Some(code),
        }],
    ));
    let expected = f.words("encoded", u32::MAX);
    let reordered = source.replace(
        "ring: U32, sector: U32, kind: U32, age: F32, work: U32, impact: F32, delivered: U32",
        "delivered: U32, impact: F32, work: U32, age: F32, kind: U32, sector: U32, ring: U32",
    );
    assert_ne!(reordered, source);
    let (code, _) = c::generate(&reordered, &plan, &previous, true).unwrap();
    let mut f = Fixture::from_module(&compiled(
        "tests/codec.blot",
        &[Overlay {
            path: path.to_string_lossy().into(),
            contents: Some(code),
        }],
    ));
    assert_eq!(f.words("encoded", u32::MAX), expected);
    *plan
        .types
        .get_mut("Site")
        .unwrap()
        .variants
        .get_mut("Site")
        .unwrap()
        .fields
        .get_mut("kind")
        .unwrap() = 31;
    let error = c::generate(&source, &plan, &previous, true).err().unwrap();
    assert!(error.to_string().contains("without a codec version change"));
}
#[test]
fn specialized_codecs_agree_with_generic_framing_for_corrupt_inputs() {
    let (source, plan, previous) = codec_source();
    let (code, _) = c::generate(&source, &plan, &previous, false).unwrap();
    let path = root().join("tests/fixtures/derived/model_derived.blot");
    let mut reference = Fixture::from_module(&compiled(
        "tests/codec.blot",
        &[Overlay {
            path: path.to_string_lossy().into(),
            contents: Some(code),
        }],
    ));
    let mut f = Fixture::new("tests/codec.blot");
    for choice in 0..5u32 {
        let saved = f.words("sample_words", choice);
        assert_eq!(saved, reference.words("sample_words", choice));
        let mut compare = |words: Vec<u32>| {
            let packet = [vec![choice], words].concat();
            assert_eq!(
                f.words("read_sample", packet.clone()),
                reference.words("read_sample", packet)
            );
        };
        compare(saved.clone());
        for end in 0..saved.len() {
            compare(saved[..end].to_vec());
        }
        compare([saved.clone(), vec![0]].concat());
        for at in 0..saved.len() {
            for value in [0, 1, 0x7f800000, u32::MAX] {
                let mut bad = saved.clone();
                bad[at] = value;
                compare(bad);
            }
        }
    }
}
#[test]
fn primitive_codec_booleans_full_ids_negative_zero_and_invalid_words() {
    let source = "type Primitives is data = $Primitives { flag: Bool, value: F32, id: U32 }\n";
    let plan: c::Schema = parse(
        json!({"types":{"Primitives":{"version":1,"key":7,"variants":{"Primitives":{"tag":1,"fields":{"flag":30,"value":10,"id":20}}}}}}),
    );
    let (code, _) = c::generate(source, &plan, &c::Published::default(), true).unwrap();
    let mut f = source_fixture(
        &(code
            + "\nentry func encode (flag: U32) => _derive_codec.encode ($Primitives {flag: flag != 0, value: -0.0, id: 4294967295})\nentry func decode (words: #[U32]) =>\n  let result: Maybe Primitives = _derive_codec.Codec.decode words\n  let $Some value = result else:\n    return #[]\n  return _derive_codec.encode value\n"),
    );
    for flag in [0u32, 1] {
        let words = f.words("encode", flag);
        assert_eq!(
            words,
            vec![1, 1, 3, 10, 1, 0x80000000, 20, 1, u32::MAX, 30, 1, flag]
        );
        assert_eq!(f.words("decode", words.clone()), words);
        for (at, bits) in [
            (11, 2),
            (11, u32::MAX),
            (5, 0x7fc00001),
            (5, 0x7f800000),
            (4, 2),
            (9, 20),
        ] {
            let mut bad = words.clone();
            bad[at] = bits;
            assert!(f.words("decode", bad).is_empty());
        }
    }
}
