use ink_tools::{Fixture, compiled, root, workloads};
use pen_plugins::Overlay;
use serde_json::json;
use std::time::Instant;

fn main() {
    std::fs::create_dir_all(".cache/six-more").unwrap();
    let baseline: serde_json::Value = match std::fs::read(".cache/six-more/before.json") {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap(),
        Err(_) => serde_json::from_slice::<serde_json::Value>(
            &std::fs::read("tools/audits/2026-10-26-six-more.json").unwrap(),
        )
        .unwrap()["baseline"]
            .clone(),
    };
    let overlays: Vec<_> = baseline["sources"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(path, source)| Overlay {
            path: root().join(path).display().to_string(),
            contents: Some(source.as_str().unwrap().to_owned()),
        })
        .collect();
    let filter = std::env::args().nth(1).unwrap_or_default();
    let mut results = vec![];
    for (fixture, mut cases, modes) in [
        (
            "tests/perf/six_more.blot",
            vec![
                ("point_grid_build", vec![256, 4096, 16384]),
                ("set_build", vec![256, 4096, 16384]),
                ("relation_remove", vec![256, 4096, 16384]),
                ("indices_sparse", vec![1024, 16384, 65536]),
                ("indices_dense", vec![256, 1024, 4096]),
                ("ecs_payload_edits", vec![4096, 32768, 131072]),
                ("ecs_membership_edits", vec![4096, 32768, 131072]),
                ("ecs_dense_edits", vec![4096, 32768, 65536]),
            ],
            0,
        ),
        (
            "tests/prepared-physics.blot",
            vec![
                ("reference", vec![256, 2048, 4096]),
                ("workload", vec![256, 2048, 8192]),
                ("walker_workload", vec![256, 2048, 8192]),
                ("walker_reference", vec![256, 2048, 4096]),
            ],
            56,
        ),
        ("tests/six-more-physics.blot", vec![("actual", vec![0])], 12),
        (
            "tools/library-bench.blot",
            vec![
                ("physics_sparse", vec![64, 128, 256]),
                ("physics_dense", vec![16, 32, 64]),
            ],
            0,
        ),
    ] {
        cases.retain(|(entry, _)| fixture.contains(&filter) || entry.contains(&filter));
        if cases.is_empty() {
            continue;
        }
        let mut guests = [
            Fixture::from_module(&compiled(fixture, &overlays)),
            Fixture::from_module(&compiled(fixture, &[])),
        ];
        if modes != 0 {
            for mode in 0..modes {
                let old_full = guests[0].call("expected", mode).unwrap();
                let old_prepared = guests[0].call("actual", mode).unwrap();
                let new_full = guests[1].call("expected", mode).unwrap();
                let new_prepared = guests[1].call("actual", mode).unwrap();
                assert_eq!(old_full, old_prepared, "old prepared {fixture} {mode}");
                assert_eq!(old_full, new_full, "full {fixture} {mode}");
                assert_eq!(old_full, new_prepared, "prepared {fixture} {mode}");
            }
            println!("{modes} complete replay scenarios passed: {fixture}");
        }
        for (entry, sizes) in cases {
            for size in sizes {
                let expected = guests[0].call(entry, size).unwrap();
                assert_eq!(expected, guests[1].call(entry, size).unwrap());
                if fixture == "tests/perf/six_more.blot" {
                    let catalog = workloads::workloads();
                    let workload = catalog
                        .iter()
                        .find(|w| w.name == format!("six-more-{entry}"))
                        .unwrap();
                    for guest in &mut guests {
                        let value = workloads::witness(guest, workload, size as usize);
                        workloads::check(workload, size as usize, &value);
                    }
                }
                for _ in 0..5 {
                    for guest in &mut guests {
                        assert_eq!(expected, guest.call(entry, size).unwrap());
                    }
                }
                let memory_before = guests.each_ref().map(|g| g.guest.memory_bytes());
                let mut samples = [vec![], vec![]];
                for round in 0..11 {
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
                results.push(json!({"fixture":fixture,"entry":entry,"size":size,"medianMs":medians,"samplesMs":samples,"memoryBytes":memory_after,"replayGrowthBytes":[0,0]}));
            }
        }
    }
    let report = json!({"includes":"Exact previous source overlays versus current sources; fixture construction, guest execution and complete result decoding; 5 warmups and 11 alternating pairs; equality and independent catalog witnesses outside timings","results":results});
    std::fs::write(
        ".cache/six-more/paired.json",
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
}
