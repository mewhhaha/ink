use ink_tools::{Fixture, compiled};
use serde_json::json;
use std::time::Instant;

fn main() {
    let module = compiled("tests/perf/simd_batches.blot", &[]);
    let mut guest = Fixture::from_module(&module);
    let mut report = vec![];
    for (scalar, vector) in [
        ("field_scalar", "field_simd"),
        ("pack_scalar", "pack_simd"),
        ("spring_scalar", "spring_prepared"),
        ("spring_scalar", "spring_simd"),
        ("spring_columns_unprepared", "spring_columns"),
        ("spring_columns", "spring_simd"),
        ("critical_scalar", "critical_simd"),
        ("over_scalar", "over_simd"),
        ("bounds_scalar", "bounds_simd"),
    ] {
        for size in [0u32, 1, 3, 4, 5, 63, 64, 65, 257] {
            if size == 0 && scalar.starts_with("field") {
                continue;
            }
            assert_eq!(
                guest.call(scalar, size).unwrap(),
                guest.call(vector, size).unwrap()
            );
        }
        for size in if scalar.starts_with("field") {
            [64u32, 256, 512]
        } else if scalar.starts_with("pack") {
            [256u32, 4096, 65539]
        } else {
            [64u32, 512, 4096]
        } {
            let expected = guest.call(scalar, size).unwrap();
            assert_eq!(expected, guest.call(vector, size).unwrap());
            for _ in 0..12 {
                assert_eq!(expected, guest.call(scalar, size).unwrap());
                assert_eq!(expected, guest.call(vector, size).unwrap());
            }
            let memory_before = guest.guest.memory_bytes();
            let mut samples = [vec![], vec![]];
            for round in 0..21 {
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
    std::fs::write(".cache/simd-five/simd-results.json",serde_json::to_vec_pretty(&json!({"includes":"fixture construction, guest execution and complete result decoding; alternating paired order; 12 warmups and 21 samples; complete output equality outside timings","results":report})).unwrap()).unwrap();
}
