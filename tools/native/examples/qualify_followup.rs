use ink_tools::{Fixture, compiled};
use serde_json::json;
use std::time::Instant;

fn main() {
    std::fs::create_dir_all(".cache/followup-six").unwrap();
    let module = compiled("tests/perf/followup_six.blot", &[]);
    let mut guest = Fixture::from_module(&module);
    let mut report = vec![];
    for (scalar, vector, sizes) in [
        ("decode_before", "decode_after", vec![256u32, 1024, 4096]),
        ("publish_before", "publish_after", vec![256, 1024, 4096]),
        ("journal_before", "journal_after", vec![1024, 4096, 16384]),
        ("sparse_before", "sparse_after", vec![4096, 32768, 65536]),
        ("dense_before", "dense_after", vec![4096, 32768, 65536]),
        ("schedule_before", "schedule_after", vec![16, 256, 1024]),
        ("map_before", "map_after", vec![256, 4096, 16384]),
        (
            "map_edits_before",
            "map_edits_after",
            vec![256, 4096, 16384],
        ),
        ("broad_before", "broad_after", vec![256, 4096, 16384]),
        (
            "broad_dense_before",
            "broad_dense_after",
            vec![64, 256, 1024],
        ),
    ] {
        for size in sizes {
            let expected = guest.call(scalar, size).unwrap();
            assert_eq!(expected, guest.call(vector, size).unwrap());
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
    std::fs::write(".cache/followup-six/paired.json",serde_json::to_vec_pretty(&json!({"includes":"fixture construction, guest execution and complete result decoding; alternating paired order; 5 warmups and 11 samples; complete output equality outside timings","results":report})).unwrap()).unwrap();
}
