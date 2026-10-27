use crate::*;
use blot_host::{Argument, worker_sessions::Workers};
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn prepared_client_executes_ordered_waves_and_validates_before_effects() {
    let module = compiled("tests/fixtures/simd_workers.blot", &[]);
    let pool = Arc::new(Mutex::new(
        Workers::new(engine(), &module, "service", 4).unwrap(),
    ));
    let mut guest = Fixture::from_module(&module);
    for _ in 0..8 {
        let pool = pool.clone();
        let result = guest
            .guest
            .call(
                "client",
                Argument::Callback(Box::new(move |value| pool.lock().unwrap().call(value))),
            )
            .unwrap();
        assert_eq!(result, Value::ArrayF32(vec![0., 0., 1.]));
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
    guest.traps("wrong_result_count", ());
    guest.traps("prepared_wrong_result_count", ());
    assert_eq!(guest.guest.ownership().roots, Some(0));
    assert_eq!(guest.guest.ownership().leases, Some(0));
    pool.lock().unwrap().close().unwrap();
}
