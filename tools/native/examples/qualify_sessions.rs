use anyhow::{Result, ensure};
use blot_host::{Guest, Value, worker_sessions, workers};
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
fn mode(
    mode: usize,
    _revision: u32,
    context: &[f32],
    inputs: &[Vec<f32>],
    fresh: &mut workers::Workers,
    warm: &mut [worker_sessions::Workers; 2],
    direct: &mut Guest,
) -> Result<Vec<Vec<f32>>> {
    if mode == 0 {
        return fresh
            .run(
                inputs
                    .iter()
                    .map(|input| Value::ArrayF32(packet(context, input)))
                    .collect(),
            )?
            .into_iter()
            .map(|value| value.map_err(anyhow::Error::msg)?.into_f32_array())
            .collect();
    }
    if mode == 3 {
        let flat: Vec<_> = inputs.iter().flatten().copied().collect();
        let result = direct
            .call("fresh", Value::ArrayF32(packet(context, &flat)))?
            .into_f32_array()?;
        return Ok(result
            .chunks(inputs[0].len() / 2)
            .map(|v| v.to_vec())
            .collect());
    }
    warm[mode - 1]
        .run_prepared(inputs.to_vec())?
        .into_iter()
        .map(|r| r.map_err(anyhow::Error::msg))
        .collect()
}
fn main() -> Result<()> {
    let engine = engine().clone();
    let module = compiled("tests/perf/worker_sessions.blot", &[]);
    let mut pool = worker_sessions::Workers::new(&engine, &module, "main", 4)?;
    let context = vec![0., 0., 10., 0., 0., 10., 10., 10.];
    let inputs = vec![vec![1., 1.], vec![9., 1.], vec![1., 9.], vec![9., 9.]];
    for _ in 0..20 {
        let output = pool.run(u32::MAX, &context, inputs.clone())?;
        ensure!(
            output
                .iter()
                .zip(&inputs)
                .all(|(a, q)| a.as_ref().is_ok_and(|a| *a == reference(&context, q))),
            "stable ordered result"
        );
    }
    ensure!(
        pool.stats().contexts == 4 && pool.stats().starts == 4,
        "contexts should prepare once per worker: {:?}",
        pool.stats()
    );
    ensure!(
        pool.run(
            u32::MAX,
            &[1., 0., 10., 0., 0., 10., 10., 10.],
            inputs.clone()
        )
        .is_err(),
        "same revision changed"
    );
    pool.reset();
    pool.run(u32::MAX, &context, inputs.clone())?;
    ensure!(pool.stats().contexts == 8, "reset must prepare");
    let result = pool.run(0, &context, vec![vec![1., 1.], vec![1.], vec![9., 9.]])?;
    ensure!(
        result[0].is_ok() && result[1].is_err() && result[2].is_ok(),
        "mixed failure order"
    );
    let result = pool.run(0, &context, inputs.clone())?;
    ensure!(
        result.iter().all(Result::is_ok),
        "restart after failed plan"
    );
    let result = pool.run(1, &[1.], inputs.clone())?;
    ensure!(
        result.iter().all(Result::is_err),
        "failed context must reject jobs"
    );
    let result = pool.run(2, &context, inputs.clone())?;
    ensure!(
        result.iter().all(Result::is_ok),
        "restart after failed prepare"
    );
    ensure!(
        pool.run(2, &context, vec![vec![f32::NAN]]).is_err(),
        "finite inputs"
    );
    ensure!(
        pool.run(2, &context, vec![vec![]; 33]).is_err(),
        "bounded batch"
    );
    ensure!(
        pool.run(2, &context, vec![vec![0.; 16385]]).is_err(),
        "bounded input"
    );
    let validation_stats = format!("{:?}", pool.stats());
    pool.close()?;
    pool.close()?;
    ensure!(pool.run(2, &context, inputs).is_err(), "closed pool");
    let mut rows = vec![];
    for points in [256usize, 2048] {
        for jobs in [1usize, 8, 32] {
            let context: Vec<_> = (0..points)
                .flat_map(|i| [(i % 64) as f32 * 0.5, (i / 64) as f32 * 0.5])
                .collect();
            let inputs: Vec<Vec<f32>> = (0..jobs)
                .map(|job| {
                    (0..32)
                        .flat_map(|i| {
                            [
                                ((i * 37 + job * 11) % 300) as f32 * 0.125,
                                ((i * 13 + job * 23) % 120) as f32 * 0.125,
                            ]
                        })
                        .collect()
                })
                .collect();
            let expected: Vec<_> = inputs.iter().map(|q| reference(&context, q)).collect();
            let mut fresh = workers::Workers::new(&engine, &module, "fresh", 4)?;
            let mut warm = [
                worker_sessions::Workers::new(&engine, &module, "main", 1)?,
                worker_sessions::Workers::new(&engine, &module, "main", 4)?,
            ];
            let mut direct = Guest::new(&engine, &module)?;
            for pool in &mut warm {
                pool.configure(0, &context)?;
            }
            for m in 0..4 {
                for _ in 0..12 {
                    ensure!(
                        mode(m, 0, &context, &inputs, &mut fresh, &mut warm, &mut direct)?
                            == expected,
                        "warmup witness"
                    );
                }
            }
            let memory_before: Vec<_> = warm.iter().map(|p| p.stats().memory_bytes).collect();
            let mut samples = [vec![], vec![], vec![], vec![]];
            for pair in 0..21 {
                for m in if pair % 2 == 0 {
                    [0, 1, 2, 3]
                } else {
                    [3, 2, 1, 0]
                } {
                    let started = Instant::now();
                    let found = mode(m, 0, &context, &inputs, &mut fresh, &mut warm, &mut direct)?;
                    samples[m].push(started.elapsed().as_secs_f64() * 1000.);
                    ensure!(found == expected, "measured witness");
                }
            }
            let memory_after: Vec<_> = warm.iter().map(|p| p.stats().memory_bytes).collect();
            assert_eq!(
                memory_before, memory_after,
                "warm memory grew during measured batches"
            );
            let median: Vec<_> = samples
                .iter()
                .map(|v| {
                    let mut v = v.clone();
                    v.sort_by(f64::total_cmp);
                    v[v.len() / 2]
                })
                .collect();
            let mut hash = Sha256::new();
            for value in expected.iter().flatten() {
                hash.update(value.to_le_bytes());
            }
            rows.push(json!({"points":points,"jobs":jobs,"queriesPerJob":32,"medianMs":median,"samplesMs":samples,"outputSha256":format!("{:x}",hash.finalize()),"warmOne":warm[0].stats(),"warmFour":warm[1].stats(),"memoryBefore":memory_before,"memoryAfter":memory_after}));
            fresh.close()?;
            for pool in &mut warm {
                pool.close()?;
            }
            direct.dispose()?;
        }
    }
    std::fs::write(
        ".cache/simd-five/worker-results.json",
        serde_json::to_vec_pretty(
            &json!({"validation":validation_stats,"modes":["four fresh workers, rebuild context per job","one warm worker, retained prepared context","four warm workers, retained prepared context","direct serial, rebuild context once per batch"],"rows":rows}),
        )?,
    )?;
    Ok(())
}
