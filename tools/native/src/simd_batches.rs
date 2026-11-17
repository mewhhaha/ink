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
                    recorded.lock().unwrap().push(packet[1] as u32);
                    worker.lock().unwrap().call(value)
                })),
            )
            .unwrap();
        assert_eq!(result, Value::ArrayF32(vec![0., 0., 1.]));
        assert_eq!(*trace.lock().unwrap(), [1, 2, 2, 0]);
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
                let command = packet[1] as u32;
                recorded.lock().unwrap().push(command);
                if command == 1 {
                    return Ok(Value::ArrayF32(vec![packet[0], 1.0]));
                }
                anyhow::bail!("dispatcher stopped at first wave");
            })),
        )
        .unwrap_err();
    assert!(format!("{error:#}").contains("dispatcher stopped at first wave"));
    assert_eq!(*trace.lock().unwrap(), [1, 2]);
    assert!(lease.upgrade().is_none());
    assert!(
        guest
            .guest
            .last_reclaimed_owners()
            .is_some_and(|owners| owners > 0)
    );
    pool.lock().unwrap().close().unwrap();
}
