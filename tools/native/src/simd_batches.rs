use crate::*;
use blot_host::{
    Argument,
    kernels::{KernelConfig, KernelPool},
};
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn prepared_client_executes_ordered_waves_and_validates_before_effects() {
    let module = compiled("tests/fixtures/simd_workers.blot", &[]);
    let mut cfg = KernelConfig::default();
    cfg.workers = 4;
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
                    Ok(Value::ArrayF32(words.into_iter().map(|w| w as f32).collect()))
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
