use anyhow::{Result, ensure};
use blot_host::{
    Guest, Value,
    kernels::{KernelConfig, KernelPool},
};
use ink_tools::{compiled, engine};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::time::Instant;

fn reference(context: &[f32], queries: &[f32]) -> Vec<f32> {
    queries
        .chunks_exact(2)
        .map(|q| {
            let mut best = (f32::INFINITY, 0);
            for (i, p) in context.chunks_exact(2).enumerate() {
                let dx = p[0] - q[0];
                let dz = p[1] - q[1];
                let distance = dx * dx + dz * dz;
                if distance < best.0 {
                    best = (distance, i);
                }
            }
            best.1 as f32
        })
        .collect()
}

fn packet(context: &[f32], input: &[f32]) -> Vec<f32> {
    let mut p = vec![context.len() as f32];
    p.extend_from_slice(context);
    p.extend_from_slice(input);
    p
}

fn to_words(vals: &[f32]) -> Vec<u32> {
    vals.iter().map(|v| v.to_bits()).collect()
}

fn from_words(words: &[u32]) -> Vec<f32> {
    words.iter().map(|w| f32::from_bits(*w)).collect()
}

fn main() -> Result<()> {
    let engine = engine().clone();
    let module = compiled("tests/perf/worker_sessions.blot", &[]);
    let mut cfg = KernelConfig::default();
    cfg.workers = 4;
    let mut pool = KernelPool::open(&engine, &module, "nearest_points", cfg)?;
    let context = vec![0., 0., 10., 0., 0., 10., 10., 10.];
    let context_words = to_words(&context);
    let queries = vec![1., 1., 9., 1., 1., 9., 9., 9.];
    let query_words = to_words(&queries);

    pool.set_context(1, &context_words)?;
    for _ in 0..20 {
        let output = from_words(&pool.run_fixed(&query_words)?);
        ensure!(
            output == reference(&context, &queries),
            "stable ordered result"
        );
    }
    ensure!(
        pool.set_context(1, &to_words(&[1., 0., 10., 0., 0., 10., 10., 10.]))
            .is_err(),
        "same revision changed must reject"
    );
    pool.clear_context()?;
    ensure!(
        pool.run_fixed(&query_words).is_err(),
        "cleared context must reject run"
    );
    ensure!(
        pool.set_context(2, &to_words(&[1.])).is_err(),
        "failed context must reject"
    );
    pool.set_context(3, &context_words)?;
    ensure!(
        from_words(&pool.run_fixed(&query_words)?) == reference(&context, &queries),
        "restart after failed prepare"
    );
    drop(pool);

    let mut rows = vec![];
    for points in [256usize, 2048] {
        for jobs in [1usize, 8, 32] {
            let context: Vec<f32> = (0..points)
                .flat_map(|i| [(i % 64) as f32 * 0.5, (i / 64) as f32 * 0.5])
                .collect();
            let context_words = to_words(&context);
            let flat_queries: Vec<f32> = (0..jobs)
                .flat_map(|job| {
                    (0..32).flat_map(move |i| {
                        [
                            ((i * 37 + job * 11) % 300) as f32 * 0.125,
                            ((i * 13 + job * 23) % 120) as f32 * 0.125,
                        ]
                    })
                })
                .collect();
            let query_words = to_words(&flat_queries);
            let expected = reference(&context, &flat_queries);

            let mut cfg1 = KernelConfig::default();
            cfg1.workers = 1;
            cfg1.default_chunk_items = 32;
            let mut warm1 = KernelPool::open(&engine, &module, "nearest_points", cfg1)?;
            warm1.set_context(0, &context_words)?;

            let mut cfg4 = KernelConfig::default();
            cfg4.workers = 4;
            cfg4.default_chunk_items = 32;
            let mut warm4 = KernelPool::open(&engine, &module, "nearest_points", cfg4)?;
            warm4.set_context(0, &context_words)?;

            let mut direct = Guest::new(&engine, &module)?;
            for _ in 0..8 {
                ensure!(
                    from_words(&warm1.run_fixed(&query_words)?) == expected,
                    "warm1 witness"
                );
                ensure!(
                    from_words(&warm4.run_fixed(&query_words)?) == expected,
                    "warm4 witness"
                );
                let direct_out = direct
                    .call("fresh", Value::ArrayF32(packet(&context, &flat_queries)))?
                    .into_f32_array()?;
                ensure!(direct_out == expected, "direct witness");
            }

            let mut samples = [vec![], vec![], vec![]];
            for pair in 0..21 {
                let order = if pair % 2 == 0 { [0, 1, 2] } else { [2, 1, 0] };
                for m in order {
                    let started = Instant::now();
                    let found = match m {
                        0 => from_words(&warm1.run_fixed(&query_words)?),
                        1 => from_words(&warm4.run_fixed(&query_words)?),
                        _ => direct
                            .call("fresh", Value::ArrayF32(packet(&context, &flat_queries)))?
                            .into_f32_array()?,
                    };
                    samples[m].push(started.elapsed().as_secs_f64() * 1000.);
                    ensure!(found == expected, "measured witness");
                }
            }
            let median: Vec<_> = samples
                .iter()
                .map(|v| {
                    let mut v = v.clone();
                    v.sort_by(f64::total_cmp);
                    v[v.len() / 2]
                })
                .collect();
            let mut hash = Sha256::new();
            for value in &expected {
                hash.update(value.to_le_bytes());
            }
            rows.push(json!({
                "points": points,
                "jobs": jobs,
                "queriesPerJob": 32,
                "medianMs": median,
                "outputSha256": format!("{:x}", hash.finalize()),
            }));
            direct.dispose()?;
        }
    }
    if let Some(parent) = std::path::Path::new(".cache/simd-five/worker-results.json").parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(
        ".cache/simd-five/worker-results.json",
        serde_json::to_vec_pretty(&json!({
            "modes": [
                "one warm KernelPool worker, retained prepared context",
                "four warm KernelPool workers, retained prepared context",
                "direct serial, rebuild context once per batch"
            ],
            "rows": rows
        }))?,
    )?;
    Ok(())
}
