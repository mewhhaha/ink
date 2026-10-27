use ink_tools::{Fixture, compiled};
use serde_json::json;
use std::time::Instant;

fn main() {
    std::fs::create_dir_all(".cache/six-more").unwrap();
    let module = compiled("tests/perf/queue_bulk.blot", &[]);
    let mut guest = Fixture::from_module(&module);
    let mut report = vec![];
    for (scalar, vector, sizes) in [("individual", "bulk", vec![256u32, 1024, 4096])] {
        for size in sizes {
            let expected = guest.call(scalar, size).unwrap();
            assert_eq!(expected, guest.call(vector, size).unwrap());
            for entry in [scalar, vector] {
                let catalog = ink_tools::workloads::workloads();
                let workload = catalog
                    .iter()
                    .find(|w| w.name == format!("six-more-queue-{entry}"))
                    .unwrap();
                let witness = ink_tools::workloads::witness(&mut guest, workload, size as usize);
                ink_tools::workloads::check(workload, size as usize, &witness);
            }
            for _ in 0..5 {
                assert_eq!(expected, guest.call(scalar, size).unwrap());
                assert_eq!(expected, guest.call(vector, size).unwrap());
            }
            let memory_before = guest.guest.memory_bytes();
            let mut samples = [vec![], vec![]];
            for round in 0..11 {
                for mode in if round % 2 == 0 { [0, 1] } else { [1, 0] } {
                    let name = if mode == 0 { scalar } else { vector };
                    let start = Instant::now();
                    let actual = guest.call(name, size).unwrap();
                    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                    assert_eq!(actual, expected);
                    samples[mode].push(elapsed);
                }
            }
            let memory_after = guest.guest.memory_bytes();
            assert_eq!(memory_before, memory_after);
            let medians: Vec<_> = samples
                .iter()
                .map(|v| {
                    let mut v = v.clone();
                    v.sort_by(f64::total_cmp);
                    v[v.len() / 2]
                })
                .collect();
            println!(
                "{scalar} {size}: {:.4} -> {:.4} ms ({:.2}x)",
                medians[0],
                medians[1],
                medians[0] / medians[1]
            );
            report.push(json!({"scalar":scalar,"vector":vector,"size":size,"medianMs":medians,"samplesMs":samples,"committedMemoryBytes":memory_after,"replayGrowthBytes":memory_after-memory_before}));
        }
    }
    std::fs::write(".cache/six-more/queue-paired.json",serde_json::to_vec_pretty(&json!({"includes":"fixture construction, guest execution and complete result decoding; alternating paired order; 5 warmups and 11 samples; complete output equality outside timings","results":report})).unwrap()).unwrap();
}
