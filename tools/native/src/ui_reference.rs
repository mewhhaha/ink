use super::*;
fn pack(parts: &[Vec<u32>]) -> Vec<u32> {
    parts
        .iter()
        .flat_map(|part| std::iter::once(part.len() as u32).chain(part.iter().copied()))
        .collect()
}
type Node = [u32; 8];
fn make(id: u32, parent: u32) -> Node {
    [id, parent, 1, 0, 0, 0, 0, 3]
}
fn focus_reference(nodes: &[Node], focus: u32) -> Vec<u32> {
    let available = |node: &Node| {
        let mut at = node;
        for _ in 0..64 {
            if at[3] != 0 || at[4] != 0 {
                return false;
            }
            if at[1] == 0 {
                return true;
            }
            let Some(parent) = nodes.iter().find(|n| n[0] == at[1]) else {
                return false;
            };
            at = parent;
        }
        false
    };
    let hidden = |node: &Node| {
        let mut at = node;
        for _ in 0..64 {
            if at[3] != 0 {
                return true;
            }
            if at[1] == 0 {
                return false;
            }
            let Some(parent) = nodes.iter().find(|n| n[0] == at[1]) else {
                return true;
            };
            at = parent;
        }
        true
    };
    let within = |node: &Node, scope: u32| {
        let mut at = node;
        for _ in 0..64 {
            if at[0] == scope {
                return true;
            }
            let Some(parent) = nodes.iter().find(|n| n[0] == at[1]) else {
                return false;
            };
            at = parent;
        }
        false
    };
    let mut modal = 0;
    for node in nodes {
        if node[5] != 0 && available(node) {
            modal = node[0];
        }
    }
    let reached: Vec<u32> = nodes
        .iter()
        .filter(|n| n[0] != 0 && n[2] != 0 && available(n) && (modal == 0 || within(n, modal)))
        .map(|n| n[0])
        .collect();
    let order: Vec<u32> = nodes
        .iter()
        .filter(|n| {
            reached.contains(&n[0])
                && n[0] != 0
                && n[2] != 0
                && available(n)
                && (modal == 0 || within(n, modal))
                && (n[7] != 14 || n[6] != 1)
        })
        .map(|n| n[0])
        .collect();
    let current = if reached.contains(&focus) {
        focus
    } else if modal != 0 && !order.is_empty() {
        order[0]
    } else {
        0
    };
    let mut out = vec![current, modal];
    out.extend(pack(&[order, reached]));
    out.extend(
        nodes
            .iter()
            .map(|n| u32::from(hidden(n) || modal != 0 && !within(n, modal))),
    );
    out.extend(
        nodes
            .iter()
            .map(|n| u32::from(current != 0 && n[0] == current)),
    );
    out.extend(nodes.iter().map(|n| u32::from(n[3] != 0)));
    out
}
#[test]
fn indexed_ui_matches_bounded_ancestor_reference_and_snapshots() {
    let mut f = Fixture::new("tests/perf/ui-text.blot");
    let mut cases = vec![vec![], vec![make(0, 0)], vec![make(u32::MAX, 0)]];
    for depth in [1, 2, 16, 17, 63, 64, 65, 128] {
        let mut nodes: Vec<Node> = (0..depth).map(|i| make(u32::MAX - i as u32, 0)).collect();
        for i in 1..nodes.len() {
            nodes[i][1] = nodes[i - 1][0];
        }
        cases.push(nodes.clone());
        nodes[0][5] = 1;
        cases.push(nodes);
    }
    let mut inherited = vec![make(1, 0), make(2, 1), make(3, 0), make(4, 3), make(5, 99)];
    inherited[0][3] = 1;
    inherited[2][4] = 1;
    cases.extend([
        inherited,
        vec![make(2, 1), make(1, 0)],
        vec![make(1, 2), make(2, 1)],
    ]);
    let mut duplicates = vec![make(1, 0), make(1, 0), make(2, 1), make(3, 0), make(4, 3)];
    duplicates[0][4] = 1;
    duplicates[3][5] = 1;
    cases.push(duplicates);
    let mut many: Vec<Node> = (0..48).map(|i| make(u32::MAX - i % 8, 0)).collect();
    many[0][3] = 1;
    for node in &mut many[16..] {
        node[1] = u32::MAX;
    }
    cases.push(many);
    let mut zero = vec![make(0, 2), make(1, 0), make(2, 0)];
    zero[2][5] = 1;
    cases.push(zero);
    let mut tabs = vec![make(1, 0), make(2, 1), make(3, 1)];
    tabs[0][5] = 1;
    tabs[1][7] = 14;
    tabs[1][6] = 1;
    tabs[2][7] = 14;
    tabs[2][6] = 2;
    cases.push(tabs);
    let mut random = Random(813);
    for _ in 0..12 {
        let mut nodes: Vec<Node> = Vec::new();
        for i in 0..96 {
            let r = random.word();
            let mut node = make(u32::MAX - i, 0);
            if i > 0 && r % 3 != 0 {
                node[1] = nodes[(r % i) as usize][0];
            }
            node[2] = u32::from(r % 7 != 0);
            node[3] = u32::from(r % 19 == 0);
            node[4] = u32::from(r % 23 == 0);
            node[5] = u32::from(r % 29 == 0);
            nodes.push(node);
        }
        cases.push(nodes.clone());
        nodes.reverse();
        cases.push(nodes);
    }
    for nodes in cases {
        for focus in [0, nodes.last().map_or(1, |n| n[0]), 16777217] {
            let input = std::iter::once(focus)
                .chain(nodes.iter().flatten().copied())
                .collect::<Vec<u32>>();
            assert_eq!(f.words("focus", input), focus_reference(&nodes, focus));
        }
    }
}
#[test]
fn unicode_split_join_empty_chunks_and_snapshots() {
    let mut f = Fixture::new("tests/perf/ui-text.blot");
    let cases = vec![
        vec![],
        vec![32],
        vec![10],
        vec![32, 32, 10, 10, 32],
        vec![0, 65, 32, 128578, 32, 32, 66615, 10, 10],
        (0..4096).map(|i| [128578, 32, 10, 66615][i % 4]).collect(),
    ];
    for points in cases {
        let text: String = points.iter().map(|&x| char::from_u32(x).unwrap()).collect();
        let words: Vec<Vec<u32>> = text
            .split(' ')
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().map(u32::from).collect())
            .collect();
        let lines: Vec<Vec<u32>> = text
            .split('\n')
            .map(|s| s.chars().map(u32::from).collect())
            .collect();
        assert_eq!(f.words("words", points.clone()), pack(&words));
        assert_eq!(f.words("lines", points.clone()), pack(&lines));
        let joined: Vec<u32> = text
            .split(' ')
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .map(u32::from)
            .collect();
        assert_eq!(
            f.words("text_snapshots", points.clone()),
            pack(&[
                [points.clone(), vec![32], points.clone()].concat(),
                joined,
                points.clone(),
                vec![0; points.len()]
            ])
        );
        for separator in [vec![], vec![32], vec![128578, 10, 66615]] {
            for parts in [
                vec![],
                vec![vec![]],
                vec![vec![], vec![], vec![]],
                vec![points.clone(), vec![], points.clone()],
            ] {
                let input = [
                    vec![separator.len() as u32],
                    separator.clone(),
                    pack(&parts),
                ]
                .concat();
                let mut expected: Vec<u32> = Vec::new();
                for (i, part) in parts.iter().enumerate() {
                    if i > 0 {
                        expected.extend(&separator);
                    }
                    expected.extend(part);
                }
                assert_eq!(f.words("joined", input.clone()), expected);
                assert_eq!(f.words("joined", input), expected);
            }
        }
    }
}
#[test]
fn ui_and_text_adversarial_workloads_reuse_bounded_memory() {
    let sum: u32 = (0..4096).map(|i| 128578 + 97 + i % 26).sum();
    for (entry, size, expected, limit) in [
        (
            "ui_deep_tree",
            2048,
            vec![2048, 32, 32, u32::MAX - 2016, u32::MAX - 2016, 2016],
            4 * 1024 * 1024,
        ),
        (
            "text_join_many",
            4096,
            vec![4096, 16382, sum + 4095 * 66625],
            512 * 1024,
        ),
        (
            "text_words_long",
            4096,
            vec![4096, 4096, 8192, sum],
            1024 * 1024,
        ),
        (
            "text_lines_long",
            4096,
            vec![4096, 4097, 8192, sum],
            1024 * 1024,
        ),
    ] {
        let mut f = Fixture::new("tests/perf/ui-text.blot");
        let mut committed = 0;
        for replay in 0..3 {
            assert_eq!(f.words(entry, size), expected);
            let bytes = f.guest.memory_bytes();
            assert!(bytes <= limit, "{entry}: {bytes} bytes exceeds {limit}");
            if replay > 0 {
                assert_eq!(bytes, committed);
            }
            committed = bytes;
        }
    }
}
#[test]
fn semantic_json_preserves_unicode_ids_schemas_and_optional_values() {
    use serde_json::{Value as Json, json};
    let mut f = Fixture::new("tests/semantic.blot");
    let bytes: Vec<u8> = f
        .floats("observation", u32::MAX)
        .into_iter()
        .map(|x| x as u8)
        .collect();
    let v: Json = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["tick"], "4294967295");
    assert_eq!(v["objects"][0]["id"]["words"], json!([u32::MAX, 16777217]));
    assert_eq!(
        v["objects"][0]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["value"].clone())
            .collect::<Vec<_>>(),
        vec![
            json!({"kind":"unsigned","value":u32::MAX}),
            json!({"kind":"encoded","value":[2147483648u32,1]}),
            json!({"kind":"boolean","value":true})
        ]
    );
    assert_eq!(v["schema"]["types"][0]["label"], "Żuraw 👾");
    assert_eq!(v["decisions"][0]["reason"], "Quoted \"line\"\\path\n👾");
    let quoted: String = f
        .words("escaped", ())
        .into_iter()
        .map(|x| char::from_u32(x).unwrap())
        .collect();
    assert_eq!(
        serde_json::from_str::<String>(&quoted).unwrap(),
        "start 👾 end"
    );
    let bytes: Vec<u8> = f
        .floats("derived_observation", ())
        .into_iter()
        .map(|x| x as u8)
        .collect();
    let v: Json = serde_json::from_slice(&bytes).unwrap();
    let desc = &v["schema"]["types"][0]["descriptor"]["variants"][0];
    let obj = &v["objects"][0];
    assert_eq!(obj["tag"], desc["tag"]);
    assert_eq!(obj["id"]["words"], json!([u32::MAX]));
    for fields in [&desc["fields"], &obj["fields"]] {
        assert_eq!(
            fields
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["id"].clone())
                .collect::<Vec<_>>(),
            vec![
                json!(10),
                json!(20),
                json!(30),
                json!(40),
                json!(50),
                json!(60),
                json!(70)
            ]
        );
    }
    let expected = json!([{"kind":"unsigned","value":16777217},{"kind":"unsigned","value":7},{"kind":"unsigned","value":4294967295u32},{"kind":"encoded","value":[3187671040u32]},{"kind":"unsigned","value":100},{"kind":"encoded","value":[1052770304]},{"kind":"unsigned","value":4}]);
    assert_eq!(
        Json::Array(
            obj["fields"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["value"].clone())
                .collect()
        ),
        expected
    );
    let kinds = |v: &Json| {
        v["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["kind"].clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        kinds(desc),
        obj["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["value"]["kind"].clone())
            .collect::<Vec<_>>()
    );
}
