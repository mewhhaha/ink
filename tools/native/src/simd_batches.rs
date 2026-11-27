use crate::*;
use squid_host::{
    Argument,
    kernels::{KernelConfig, KernelPool},
};
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn prepared_client_executes_ordered_waves_and_validates_before_effects() {
    let module = compiled("tests/fixtures/simd_workers.sq", &[]);
    let mut cfg = KernelConfig::default();
    cfg.workers = 4;
    cfg.deadline = Some(std::time::Duration::from_secs(5));
    let pool = Arc::new(Mutex::new(
        KernelPool::open(engine(), &module, "nearest_points", cfg).unwrap(),
    ));
    let ctx_words: Vec<u32> = [0.0f32, 0.0, 2.0, 2.0]
        .into_iter()
        .map(f32::to_bits)
        .collect();
    pool.lock().unwrap().set_context(1, &ctx_words).unwrap();

    let mut guest = Fixture::from_module(&module);
    for _ in 0..8 {
        let worker = pool.clone();
        let captured = Arc::new(());
        let lease = Arc::downgrade(&captured);
        let trace = Arc::new(Mutex::new(Vec::new()));
        let recorded = trace.clone();
        let result = guest
            .guest
            .call(
                "client",
                Argument::Callback(Box::new(move |value| {
                    let _lease = &captured;
                    let Value::ArrayF32(packet) = &value else {
                        panic!("worker request must be a packet")
                    };
                    let queries: Vec<u32> = packet.iter().map(|v| v.to_bits()).collect();
                    recorded.lock().unwrap().push(queries.len() / 2);
                    let words = worker.lock().unwrap().run_fixed(&queries)?;
                    Ok(Value::ArrayF32(
                        words.into_iter().map(|w| w as f32).collect(),
                    ))
                })),
            )
            .unwrap();
        assert_eq!(result, Value::ArrayF32(vec![0., 0., 1.]));
        assert_eq!(*trace.lock().unwrap(), [2, 1]);
        assert!(lease.upgrade().is_none());
        assert_eq!(guest.guest.last_reclaimed_owners(), Some(0));
    }
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    assert_eq!(
        guest
            .guest
            .call(
                "invalid_plan",
                Argument::Callback(Box::new(move |_| {
                    count.fetch_add(1, Ordering::Relaxed);
                    anyhow::bail!("invalid plan reached host")
                }))
            )
            .unwrap(),
        Value::Bool(false)
    );
    assert_eq!(calls.load(Ordering::Relaxed), 0);
    assert_eq!(guest.guest.last_reclaimed_owners(), Some(0));
    for entry in ["wrong_result_count", "prepared_wrong_result_count"] {
        guest.traps(entry, ());
        assert!(
            guest
                .guest
                .last_reclaimed_owners()
                .is_some_and(|owners| owners > 0),
            "{entry}: the same call must reclaim its temporary owners after trapping"
        );
    }
    let captured = Arc::new(());
    let lease = Arc::downgrade(&captured);
    let trace = Arc::new(Mutex::new(Vec::new()));
    let recorded = trace.clone();
    let error = guest
        .guest
        .call(
            "client",
            Argument::Callback(Box::new(move |value| {
                let _lease = &captured;
                let Value::ArrayF32(packet) = value else {
                    panic!("worker request must be a packet")
                };
                recorded.lock().unwrap().push(packet.len() / 2);
                anyhow::bail!("dispatcher stopped at first wave");
            })),
        )
        .unwrap_err();
    assert!(format!("{error:#}").contains("dispatcher stopped at first wave"));
    assert_eq!(*trace.lock().unwrap(), [2]);
    assert!(lease.upgrade().is_none());
    assert!(
        guest
            .guest
            .last_reclaimed_owners()
            .is_some_and(|owners| owners > 0)
    );
}

#[test]
fn kernel_kits_match_scalar_references_on_four_worker_pool() {
    let module = compiled("tests/concurrency_kits.sq", &[]);
    let mut guest = Fixture::from_module(&module);

    let run_case = |guest: &mut Fixture,
                    kernel_name: &str,
                    scalar_entry: &str,
                    ctx_f32: &[f32],
                    items_f32: &[f32]| {
        let mut cfg = KernelConfig::default();
        cfg.workers = 4;
        cfg.deadline = Some(std::time::Duration::from_secs(5));
        let mut pool = KernelPool::open(engine(), &module, kernel_name, cfg).unwrap();
        let ctx_words: Vec<u32> = ctx_f32.iter().copied().map(f32::to_bits).collect();
        pool.set_context(1, &ctx_words).unwrap();
        let item_words: Vec<u32> = items_f32.iter().copied().map(f32::to_bits).collect();
        let parallel_words = pool.run_fixed(&item_words).unwrap();
        let parallel_f32: Vec<f32> = parallel_words.into_iter().map(f32::from_bits).collect();

        let mut packet = Vec::with_capacity(1 + ctx_f32.len() + items_f32.len());
        packet.push(ctx_f32.len() as f32);
        packet.extend_from_slice(ctx_f32);
        packet.extend_from_slice(items_f32);
        let Value::ArrayF32(scalar_f32) = guest
            .guest
            .call(scalar_entry, Argument::Value(Value::ArrayF32(packet)))
            .unwrap()
        else {
            panic!("{scalar_entry} must return #[F32]");
        };
        assert_eq!(
            parallel_f32.len(),
            scalar_f32.len(),
            "{kernel_name}: length mismatch"
        );
        for (idx, (p, s)) in parallel_f32.iter().zip(scalar_f32.iter()).enumerate() {
            assert!(
                (*p - *s).abs() <= 1e-6 && p.is_finite() && s.is_finite(),
                "{kernel_name}[{idx}]: parallel {p} != scalar {s}"
            );
        }
    };

    // 1. Terrain chunk evaluator (64 cells across 4 worker threads)
    let terrain_ctx = [
        (42u32 & 0xffff) as f32,
        (42u32 >> 16) as f32,
        -16.0,
        8.0,
        2.0,
        0.04,
        3.0,
        0.4,
        0.25,
        14.0,
    ];
    let mut terrain_items = Vec::with_capacity(64 * 2);
    for z in 0..8 {
        for x in 0..8 {
            terrain_items.push(x as f32);
            terrain_items.push(z as f32);
        }
    }
    run_case(
        &mut guest,
        "bake_terrain",
        "scalar_terrain_eval",
        &terrain_ctx,
        &terrain_items,
    );

    // 2. Spatial crowd steering (32 neighbors prepared into BVH, 48 agent queries)
    let mut crowd_ctx = vec![8.0f32, 32.0];
    for i in 0..32 {
        crowd_ctx.push((i % 8) as f32 * 1.75 - 6.0);
        crowd_ctx.push(0.0);
        crowd_ctx.push((i / 8) as f32 * 2.25 - 3.0);
    }
    let mut crowd_items = Vec::with_capacity(48 * 4);
    for i in 0..48 {
        crowd_items.push((i % 12) as f32 * 0.9 - 5.0);
        crowd_items.push(0.0);
        crowd_items.push((i / 12) as f32 * 1.4 - 2.5);
        crowd_items.push(3.5);
    }
    run_case(
        &mut guest,
        "steer_crowd",
        "scalar_crowd_eval",
        &crowd_ctx,
        &crowd_items,
    );

    // 3. Heightfield bilinear height + unit normal sampling (8x8 grid, 64 queries)
    let mut hf_ctx = vec![8.0f32, 8.0, 2.0, -4.0, -4.0];
    for z in 0..8 {
        for x in 0..8 {
            let fx = x as f32 * 0.4;
            let fz = z as f32 * 0.35;
            hf_ctx.push(fx.sin() * 2.5 + fz.cos() * 1.5);
        }
    }
    let mut hf_items = Vec::with_capacity(64 * 2);
    for i in 0..64 {
        hf_items.push(-3.5 + (i % 8) as f32 * 1.85);
        hf_items.push(-3.25 + (i / 8) as f32 * 1.75);
    }
    run_case(
        &mut guest,
        "sample_heightfield",
        "scalar_heightfield_eval",
        &hf_ctx,
        &hf_items,
    );
}
