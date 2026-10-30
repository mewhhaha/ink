use ink_tools::{Fixture, compiled, root};
use pen_plugins::Overlay;
use serde_json::json;
use std::time::Instant;

fn main() {
    std::fs::create_dir_all(".cache/next-six").unwrap();
    let snapshot: serde_json::Value = match std::fs::read(".cache/next-six/before.json") {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap(),
        Err(_) => serde_json::from_slice::<serde_json::Value>(
            &std::fs::read("tools/audits/2026-10-25-next-six.json").unwrap(),
        )
        .unwrap()["baseline"]
            .clone(),
    };
    let overlays: Vec<_> = snapshot["sources"].as_object().unwrap().iter().map(|(path, source)| {
        let mut contents = source.as_str().unwrap().to_owned();
        if path == "lib/scene.blot" {
            contents.push_str("\nconst count = func (scene: Scene) => return scene.proxies.length\nconst proxy = func (scene: Scene) -> i => return scene.proxies[i]\nconst proxies = func (scene: Scene) => return scene.proxies\n");
        }
        if path == "lib/ui/tree.blot" {
            contents.push_str("\nconst from_nodes = func nodes => return $Tree {nodes}\n");
        }
        Overlay {path: root().join(path).display().to_string(), contents: Some(contents)}
    }).collect();
    let mut report = vec![];
    let filter = std::env::args().nth(1).unwrap_or_default();
    for (path, mut cases) in [
        (
            "tools/library-bench.blot",
            vec![
                ("spatial_batch", vec![256, 2048, 4096]),
                ("scene_batch", vec![256, 2048, 4096]),
                ("spatial_dense", vec![256, 2048, 4096]),
                ("scene_dense_update", vec![256, 2048, 4096]),
                ("scene_sparse_update", vec![256, 4096, 65536]),
                ("physics_sparse", vec![64, 128, 256]),
                ("physics_dense", vec![16, 32, 64]),
            ],
        ),
        ("tests/nearest.blot", vec![("batched", vec![32, 256, 2048])]),
        (
            "tests/prepared-physics.blot",
            vec![("workload", vec![256, 2048, 8192])],
        ),
    ] {
        cases.retain(|(entry, _)| path.contains(&filter) || entry.contains(&filter));
        if cases.is_empty() {
            continue;
        }
        let mut guests = [
            Fixture::from_module(&compiled(path, &overlays)),
            Fixture::from_module(&compiled(path, &[])),
        ];
        for (entry, sizes) in cases {
            for size in sizes {
                let expected = guests[0].call(entry, size).unwrap();
                for _ in 0..8 {
                    for guest in &mut guests {
                        assert_eq!(expected, guest.call(entry, size).unwrap());
                    }
                }
                let memory_before = guests.each_ref().map(|g| g.guest.memory_bytes());
                let mut samples = [vec![], vec![]];
                for round in 0..15 {
                    for mode in if round % 2 == 0 { [0, 1] } else { [1, 0] } {
                        let start = Instant::now();
                        let actual = guests[mode].call(entry, size).unwrap();
                        let elapsed = start.elapsed().as_secs_f64() * 1000.;
                        assert_eq!(expected, actual);
                        samples[mode].push(elapsed);
                    }
                }
                let memory_after = guests.each_ref().map(|g| g.guest.memory_bytes());
                assert_eq!(memory_before, memory_after);
                let medians: Vec<_> = samples
                    .iter()
                    .map(|s| {
                        let mut s = s.clone();
                        s.sort_by(f64::total_cmp);
                        s[s.len() / 2]
                    })
                    .collect();
                println!(
                    "{entry} {size}: {:.4} -> {:.4} ms ({:.2}x)",
                    medians[0],
                    medians[1],
                    medians[0] / medians[1]
                );
                report.push(json!({"fixture":path,"entry":entry,"size":size,"medianMs":medians,"samplesMs":samples,"memoryBytes":memory_after,"replayGrowthBytes":[0,0]}));
            }
        }
    }
    std::fs::write(if filter.is_empty() { ".cache/next-six/storage.json" } else { ".cache/next-six/storage-control.json" }, serde_json::to_vec_pretty(&json!({"baseline":"Exact pre-task sources from before.json; compatibility accessors only","includes":"Fixture construction, guest execution, result decoding; 8 warmups, 15 alternating pairs","results":report})).unwrap()).unwrap();
}
