//! Native benchmark timing excludes compiler work and witness validation.
use crate::{
    Fixture, engine, plugins, root,
    workloads::{self, Workload},
};
use anyhow::{Context, Result, ensure};
use pen_plugins::BuildResult;
use serde::Serialize;
use sha2::{Digest, Sha256};
use squid_host::GuestModule;
use std::{
    collections::BTreeMap,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub median: f64,
    pub min: f64,
    pub max: f64,
    pub median_absolute_deviation: f64,
    pub samples: usize,
}
pub fn summary(samples: &[f64]) -> Result<Summary> {
    ensure!(
        !samples.is_empty() && samples.iter().all(|v| v.is_finite() && *v >= 0.),
        "finite nonnegative timing samples required"
    );
    let median = |v: &mut [f64]| {
        v.sort_by(f64::total_cmp);
        let m = v.len() / 2;
        if v.len() % 2 == 0 {
            (v[m - 1] + v[m]) / 2.
        } else {
            v[m]
        }
    };
    let mut sorted = samples.to_vec();
    let mid = median(&mut sorted);
    let mad = median(&mut samples.iter().map(|v| (v - mid).abs()).collect::<Vec<_>>());
    Ok(Summary {
        median: mid,
        min: sorted[0],
        max: *sorted.last().unwrap(),
        median_absolute_deviation: mad,
        samples: samples.len(),
    })
}
struct Compiled {
    module: GuestModule,
    report: serde_json::Value,
}
// Watch roots are directories as well as individual files. Record their entire
// source trees: a conservative inventory, including transitive fixture helpers
// and standard sources, rather than pretending the roots are files.
fn source_inventory(paths: &[std::path::PathBuf]) -> Result<BTreeMap<String, String>> {
    fn visit(path: &std::path::Path, result: &mut BTreeMap<String, String>) -> Result<()> {
        if path.is_dir() {
            for entry in std::fs::read_dir(path)? {
                let entry = entry?;
                if entry.file_type()?.is_dir()
                    && (entry.file_name().to_string_lossy().starts_with('.')
                        || entry.file_name() == "target"
                        || entry.file_name() == "node_modules")
                {
                    continue;
                }
                if entry.file_type()?.is_symlink() && entry.path().is_dir() {
                    continue;
                }
                visit(&entry.path(), result)?;
            }
        } else if path
            .extension()
            .is_some_and(|x| x == "sq" || x == "wgsl" || x == "json")
        {
            let path = path.canonicalize()?;
            result.insert(
                path.strip_prefix(root())
                    .unwrap_or(&path)
                    .display()
                    .to_string(),
                format!("{:x}", Sha256::digest(std::fs::read(&path)?)),
            );
        }
        Ok(())
    }
    let mut files = BTreeMap::new();
    for path in paths {
        visit(path, &mut files)?;
    }
    Ok(files)
}
fn toolchain() -> Result<serde_json::Value> {
    let config = plugins().config();
    let compiler = config.compiler.as_ref().context("compiler configuration")?;
    let program = compiler
        .settings
        .as_ref()
        .and_then(|s| s["program"].as_str())
        .unwrap_or("squidc");
    let binary = &config
        .plugins
        .get(&compiler.plugin)
        .context("compiler grant")?
        .run[program];
    let binary = root().join(binary).canonicalize()?;
    let hash = |p: &std::path::Path| -> Result<String> {
        Ok(format!("{:x}", Sha256::digest(std::fs::read(p)?)))
    };
    Ok(
        serde_json::json!({"compilerExecutable":binary,"compilerSha256":hash(&binary)?,"penConfigSha256":hash(&root().join("pen.json"))?,"rustDependenciesSha256":hash(&root().join("tools/native/Cargo.lock"))?,"nativeRunnerSha256":hash(&std::env::current_exe()?)?}),
    )
}
fn compile(w: &Workload) -> Result<Compiled> {
    let path = root().join("tools").join(&w.fixture).canonicalize()?;
    let start = Instant::now();
    let mut compiler = plugins().compiler(&path)?;
    let bytes = match compiler.build(&[])? {
        BuildResult::Built(bytes) => bytes,
        BuildResult::Rejected(errors) => anyhow::bail!("{}: {errors:#?}", w.fixture),
    };
    let compilation_ms = start.elapsed().as_secs_f64() * 1000.;
    let dependencies = source_inventory(&compiler.watched()?)?;
    compiler.close()?;
    let module_start = Instant::now();
    let module = GuestModule::new(engine(), &bytes, None)?;
    let report = serde_json::json!({"compileMs":compilation_ms,"hostCompileMs":module_start.elapsed().as_secs_f64()*1000.,"wasmBytes":bytes.len(),"wasmSha256":format!("{:x}",Sha256::digest(&bytes)),"dependencies":dependencies});
    Ok(Compiled { module, report })
}
fn bounded_call(f: &mut Fixture, w: &Workload, size: usize, deadline: Instant) -> Result<Vec<f64>> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .context("workload exceeded its total deadline")?;
    f.guest.set_deadline(remaining);
    // The Wasm call is interrupted by Pen's epoch timer even if it never returns.
    let result = f
        .call(&w.entry, size)
        .with_context(|| format!("{}({size})", w.name))?;
    ensure!(
        f.guest.memory_bytes() <= 256 * 1024 * 1024,
        "{} exceeded 256 MiB",
        w.name
    );
    Ok(match result {
        squid_host::Value::F32(v) => vec![v as f64],
        squid_host::Value::U32(v) => vec![v as f64],
        squid_host::Value::ArrayF32(v) => v.into_iter().map(f64::from).collect(),
        squid_host::Value::ArrayU32(v) => v.into_iter().map(f64::from).collect(),
        _ => anyhow::bail!("unsupported benchmark result"),
    })
}
pub fn run(filters: &[String]) -> Result<()> {
    let workloads: Vec<_> = workloads::workloads()
        .into_iter()
        .filter(|w| filters.is_empty() || filters.iter().any(|s| w.name.contains(s)))
        .collect();
    ensure!(!workloads.is_empty(), "no benchmark matches {filters:?}");
    let toolchain = toolchain()?;
    let mut compiled = BTreeMap::new();
    let mut reports = Vec::new();
    for w in workloads {
        if !compiled.contains_key(&w.fixture) {
            compiled.insert(w.fixture.clone(), compile(&w)?);
        }
        let module = &compiled[&w.fixture].module;
        let mut f = Fixture::from_module(module);
        let deadline = Instant::now() + Duration::from_secs(120);
        let warmup = if w.expensive { 3 } else { 20 };
        let samples = if w.expensive { 5 } else { 9 };
        let mut sizes = Vec::new();
        let mut witnesses = Vec::new();
        for &size in &w.sizes {
            let expected = bounded_call(&mut f, &w, size, deadline)?;
            workloads::check(&w, size, &expected);
            for _ in 0..warmup {
                ensure!(
                    bounded_call(&mut f, &w, size, deadline)? == expected,
                    "{} is not deterministic",
                    w.name
                );
            }
            let mut milliseconds = Vec::new();
            for _ in 0..samples {
                let started = Instant::now();
                let actual = bounded_call(&mut f, &w, size, deadline)?;
                milliseconds.push(started.elapsed().as_secs_f64() * 1000.);
                ensure!(actual == expected, "{} replay changed", w.name);
            }
            let stats = summary(&milliseconds)?;
            // One untimed witnessed call records ownership traffic independently
            // of wall-clock noise. Counters are wrapping U32 cumulative totals;
            // live-root/lease gauges deliberately are not treated as traffic.
            let counters_before: BTreeMap<_, _> = f.guest.runtime_counters().into_iter().collect();
            ensure!(
                bounded_call(&mut f, &w, size, deadline)? == expected,
                "ownership probe witness changed"
            );
            let traffic: BTreeMap<_, _> = f
                .guest
                .runtime_counters()
                .into_iter()
                .filter(|(name, _)| {
                    [
                        "squid:rc_retains",
                        "squid:rc_releases",
                        "squid:rc_destroyed",
                        "squid:cycle_passes",
                        "squid:cycle_vertices",
                        "squid:cycle_edges",
                        "squid:cycle_bytes",
                    ]
                    .contains(&name.as_str())
                })
                .filter_map(|(name, after)| {
                    counters_before
                        .get(&name)
                        .map(|before| (name.clone(), after.wrapping_sub(*before)))
                })
                .collect();
            sizes.push(serde_json::json!({"size":size,"milliseconds":stats,"samplesMs":milliseconds,"nsPerUnit":stats.median*1e6/(size as f64).powi(w.dimension as i32),"witness":expected,"ownershipTraffic":traffic}));
            witnesses.push(expected);
        }
        let memory_before = f.guest.memory_bytes();
        for _ in 0..if w.expensive { 4 } else { 16 } {
            for (i, &size) in w.sizes.iter().enumerate() {
                ensure!(
                    bounded_call(&mut f, &w, size, deadline)? == witnesses[i],
                    "{} rotating replay changed",
                    w.name
                );
            }
        }
        let memory_after = f.guest.memory_bytes();
        ensure!(
            memory_after == memory_before,
            "{} retained memory grew: {memory_before} -> {memory_after}",
            w.name
        );
        let first = sizes[0]["milliseconds"]["median"].as_f64().unwrap();
        let last = sizes.last().unwrap()["milliseconds"]["median"]
            .as_f64()
            .unwrap();
        let exponent =
            (last / first).ln() / ((*w.sizes.last().unwrap() as f64) / (w.sizes[0] as f64)).ln();
        eprintln!("{}: {:.3} ms, {} KiB", w.name, last, memory_after / 1024);
        reports.push(serde_json::json!({"workload":w,"warmup":warmup,"sizes":sizes,"scalingExponent":exponent,"memoryBytes":memory_after,"replayGrowthBytes":memory_after-memory_before}));
    }
    let modules = compiled
        .into_iter()
        .map(|(k, v)| (k, v.report))
        .collect::<BTreeMap<_, _>>();
    let report = serde_json::json!({"format":1,"runtime":"Pen/Wasmtime development engine","toolchain":toolchain,"unixSeconds":SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"cpus":std::thread::available_parallelism()?.get(),"modules":modules,"workloads":reports});
    let path = root().join(".cache/bench-library-native.json");
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, serde_json::to_string_pretty(&report)? + "\n")?;
    eprintln!("Wrote {}", path.display());
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn statistics_preserve_spread_and_reject_invalid_samples() {
        assert_eq!(
            summary(&[4., 1., 3., 2., 5.]).unwrap(),
            Summary {
                median: 3.,
                min: 1.,
                max: 5.,
                median_absolute_deviation: 1.,
                samples: 5
            }
        );
        assert_eq!(
            summary(&[1., 2., 3., 6.]).unwrap(),
            Summary {
                median: 2.5,
                min: 1.,
                max: 6.,
                median_absolute_deviation: 1.,
                samples: 4
            }
        );
        for a in [&[][..], &[f64::NAN], &[f64::INFINITY], &[-1.]] {
            assert!(summary(a).is_err());
        }
    }
    #[test]
    fn inventory_includes_fixture_helpers_and_standard_library_sources() {
        let w = workloads::workloads()
            .into_iter()
            .find(|w| w.fixture == "../tests/codec.sq")
            .unwrap();
        let report = compile(&w).unwrap().report;
        let paths = report["dependencies"].as_object().unwrap();
        for expected in ["tests/codec.sq", "tests/fixtures/derived/model_derived.sq"] {
            assert!(paths.contains_key(expected), "missing {expected}");
        }
        assert!(paths.keys().any(|p| p.ends_with("/std/prelude.sq")));
        assert!(paths.keys().any(|p| p.ends_with("/std/array.sq")));
        assert!(paths.values().all(|v| v.as_str().unwrap().len() == 64));
    }
    #[test]
    fn every_workload_has_a_live_independent_witness() {
        let mut compiled = BTreeMap::new();
        for w in workloads::workloads() {
            if !compiled.contains_key(&w.fixture) {
                compiled.insert(w.fixture.clone(), compile(&w).unwrap());
            }
            let mut fixture = Fixture::from_module(&compiled[&w.fixture].module);
            let size = w.sizes[0];
            let got = bounded_call(
                &mut fixture,
                &w,
                size,
                Instant::now() + Duration::from_secs(30),
            )
            .unwrap();
            workloads::check(&w, size, &got);
        }
    }
}
