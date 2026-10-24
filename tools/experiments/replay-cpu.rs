//! Linux CPU replay for a Pen main(host) module that seeds itself on Create.
//! Copy into pen/crates/blot-host/examples/ and run with WASM OUTPUT.json.
//! Complete frame/save hashing is outside the guest-thread timings.
use anyhow::{Result, ensure};
use blot_host::{Argument, Guest, GuestModule, Value};
use sha2::{Digest, Sha256};
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};
#[repr(C)]
struct Timespec {
    seconds: std::os::raw::c_long,
    nanos: std::os::raw::c_long,
}
unsafe extern "C" {
    fn clock_gettime(clock: std::os::raw::c_int, time: *mut Timespec) -> std::os::raw::c_int;
}
fn cpu() -> f64 {
    let mut t = Timespec { seconds: 0, nanos: 0 };
    // Linux CLOCK_THREAD_CPUTIME_ID; a writable timespec with the C layout.
    assert_eq!(unsafe { clock_gettime(3, &mut t) }, 0);
    t.seconds as f64 * 1000.0 + t.nanos as f64 / 1e6
}
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    ensure!(args.len() == 2, "replay-cpu WASM OUTPUT.json");
    let bytes = std::fs::read(&args[0])?;
    let wasm = format!("{:x}", Sha256::digest(&bytes));
    let engine = blot_host::engine()?;
    let module = GuestModule::new(&engine, &bytes, None)?;
    let captured = Arc::new(Mutex::new(serde_json::Value::Null));
    let output = captured.clone();
    let mut phase = 0;
    let mut tick = 0;
    let mut started = 0.0;
    let mut wall = Instant::now();
    let mut samples = Vec::new();
    let mut wall_samples = Vec::new();
    let mut packet_bytes = Vec::new();
    let mut frame_hash = Sha256::new();
    let callback = Box::new(move |value: Value| -> Result<Value> {
        let duration = cpu() - started;
        let wall_ms = wall.elapsed().as_secs_f64() * 1000.0;
        let packet = value.into_f32_array()?;
        let next = match phase {
            0 => {
                ensure!(packet[0] == 4670544.0, "handshake");
                phase = 1;
                vec![1.0, 1.0]
            }
            1 => {
                ensure!(packet[0] == 1.0, "create");
                phase = 2;
                vec![1.0, 2.0, 1.0 / 60.0, 1280.0, 720.0, 0.0, 0.0]
            }
            2 => {
                ensure!(packet[0] == 2.0, "frame");
                for value in &packet {
                    frame_hash.update(value.to_le_bytes());
                }
                if tick >= 120 {
                    samples.push(duration);
                    wall_samples.push(wall_ms);
                    packet_bytes.push(packet.len() * 4);
                }
                tick += 1;
                if tick == 600 {
                    phase = 3;
                    vec![1.0, 3.0]
                } else {
                    vec![1.0, 2.0, 1.0 / 60.0, 1280.0, 720.0, 0.0, 0.0]
                }
            }
            _ => {
                ensure!(packet[0] == 3.0, "snapshot");
                let saved: Vec<u8> = packet.iter().flat_map(|v| v.to_le_bytes()).collect();
                let mut sorted = samples.clone();
                sorted.sort_by(f64::total_cmp);
                *output.lock().unwrap() = serde_json::json!({"cpuMs":samples,"wallMs":wall_samples,"medianCpuMs":sorted[sorted.len()/2],"p95CpuMs":sorted[sorted.len()*95/100],"frameSha256": format!("{:x}", frame_hash.clone().finalize()), "saveSha256":format!("{:x}",Sha256::digest(&saved)),"packetBytes":packet_bytes});
                vec![1.0, 0.0]
            }
        };
        started = cpu();
        wall = Instant::now();
        Ok(Value::ArrayF32(next))
    });
    let mut guest = Guest::new(&engine, &module)?;
    guest.call("main", Argument::Callback(callback))?;
    guest.dispose()?;
    let mut result = captured.lock().unwrap().clone();
    result["wasm"] = serde_json::json!(wasm);
    std::fs::write(&args[1], serde_json::to_vec_pretty(&result)?)?;
    Ok(())
}
