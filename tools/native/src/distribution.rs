use crate::package;
use crate::*;
use regex::Regex;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicUsize, Ordering};
struct Temporary(PathBuf);
impl Temporary {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let p = root().join(format!(
            ".cache/native consumer {} {}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[test]
fn source_distribution_is_complete_and_compiles_in_isolation() {
    let tmp = Temporary::new();
    let package_root = tmp.0.join("installed sources");
    package::export(&root(), &package_root).unwrap();
    assert!(package::export(&root(), &package_root).is_err());
    let inventory: serde_json::Value =
        serde_json::from_slice(&std::fs::read(package_root.join("ink.json")).unwrap()).unwrap();
    let expected = package::files(&root()).unwrap();
    let files = inventory["sha256"].as_object().unwrap();
    assert_eq!(files.len(), expected.len());
    assert_eq!(
        files.keys().filter(|p| p.starts_with("shaders/")).count(),
        5
    );
    for relative in expected {
        let path = relative.to_str().unwrap();
        assert!(
            !path.starts_with("tools/")
                && !path.starts_with("tests/")
                && !path.ends_with(".ts")
                && !path.ends_with(".js")
        );
        let original = std::fs::read(root().join(path)).unwrap();
        let copy = std::fs::read(package_root.join(path)).unwrap();
        assert_eq!(original, copy);
        assert_eq!(files[path], format!("{:x}", Sha256::digest(&copy)));
    }
    let settings =
        json!({"std":root().join("../blot2/std"),"imports":{"kit/":package_root.join("lib")}});
    for (file, entry, arg) in [
        ("orbit", "orbit", std::f64::consts::FRAC_PI_2),
        ("ground", "height", 0.),
        ("physics", "fall", 10.),
        ("steps", "advance", 0.05),
        ("game", "sample", 0.5),
        ("navigation", "route", 0.),
        ("joints", "pendulum", 16.),
        ("ecs", "move", 0.5),
        ("collections", "example", 0.),
        ("incremental_ecs", "example", 0.),
    ] {
        let path = package_root.join(format!("examples/{file}.blot"));
        let source = std::fs::read_to_string(&path)
            .unwrap()
            .replace("ink/", "kit/");
        let mut compiler = plugins()
            .compiler_with_settings(&path, Some(&settings))
            .unwrap();
        let bytes = match compiler
            .build(&[Overlay {
                path: path.display().to_string(),
                contents: Some(source),
            }])
            .unwrap()
        {
            BuildResult::Built(bytes) => bytes,
            BuildResult::Rejected(errors) => panic!("{file}: {errors:?}"),
        };
        compiler.close().unwrap();
        let module = GuestModule::new(engine(), &bytes, None).unwrap();
        let mut f = Fixture::from_module(&module);
        if file == "incremental_ecs" {
            assert!(matches!(f.call(entry, ()).unwrap(), Value::ArrayU32(v) if v == [2, 2, 2, 1]));
            continue;
        }
        if file == "collections" {
            assert!(matches!(f.call(entry, ()).unwrap(), Value::ArrayU32(v) if v == [12, 15, 1]));
            continue;
        }
        if file == "ground" {
            assert_eq!(f.number(entry, arg), 1.5);
            continue;
        }
        let v = f.floats(entry, arg);
        match file {
            "orbit" => near_all(&v, &[-1., 0., 0.], 1e-6),
            "physics" => assert!(v[0] > 9.9 && v[0] < 10.),
            "steps" => {
                assert!(v[0] < 10. && v[1] >= v[0] && v[1] <= 10.);
                assert_eq!(v[4], 0.);
                assert_eq!(v[5], 3.);
                near(v[5] / 60. + v[3] + v[4], 0.05, 1e-6);
            }
            "game" => assert_eq!(v[1], 20.),
            "navigation" => assert_eq!(v[0], 7.),
            "joints" => near(v[2], 1., 0.002),
            "ecs" => near_all(&v, &[2., 4., 6.], 1e-6),
            _ => unreachable!(),
        }
    }
}
#[test]
fn documentation_and_workload_inventory_cover_the_source_library() {
    let files = package::files(&root()).unwrap();
    let modules: std::collections::BTreeSet<_> = files
        .iter()
        .filter_map(|p| {
            p.to_str()
                .unwrap()
                .strip_prefix("lib/")
                .map(|p| p.trim_end_matches(".blot").to_owned())
        })
        .collect();
    let measured: std::collections::BTreeSet<_> = crate::workloads::workloads()
        .into_iter()
        .flat_map(|w| w.modules)
        .collect();
    assert_eq!(modules, measured, "each module needs a benchmark workload");
    let library = root().join("lib").canonicalize().unwrap();
    let imports = Regex::new(r#"\b(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']"#).unwrap();
    for module in &modules {
        let file = library.join(format!("{module}.blot"));
        let source = std::fs::read_to_string(&file).unwrap();
        for import in imports.captures_iter(&source) {
            let path = &import[1];
            if path.starts_with("std/") || module.starts_with("pen/") && path.starts_with("pen/") {
                continue;
            }
            assert!(
                path.starts_with("./") || path.starts_with("../"),
                "{module}: core import outside Ink/std: {path}"
            );
            let dependency = file
                .parent()
                .unwrap()
                .join(format!("{path}.blot"))
                .canonicalize()
                .unwrap();
            assert!(
                dependency.starts_with(&library) && dependency.is_file(),
                "{module}: escaped library boundary: {path}"
            );
        }
    }
    let readme = std::fs::read_to_string(root().join("README.md")).unwrap();
    for m in &modules {
        assert!(readme.contains(&format!("ink/{m}")), "undocumented {m}");
    }
    let links = Regex::new(r"\[[^\]]+\]\(([^)]+)\)").unwrap();
    let fences = Regex::new(r"(?m)^```blot\n([\s\S]*?)^```").unwrap();
    let names = Regex::new(r#"["'`]ink/([a-z_/]+)"#).unwrap();
    let mut examples = 0;
    for doc in [
        "README.md",
        "docs/architecture.md",
        "docs/blot.md",
        "docs/shaders.md",
    ] {
        let path = root().join(doc);
        let source = std::fs::read_to_string(&path).unwrap();
        for link in links.captures_iter(&source) {
            let href = &link[1];
            if href.starts_with("http") || href.starts_with('#') {
                continue;
            }
            let file = href.split('#').next().unwrap();
            assert!(
                path.parent().unwrap().join(file).is_file(),
                "{doc}: missing {href}"
            );
        }
        for name in names.captures_iter(&source) {
            let name = &name[1];
            assert!(
                modules.contains(name)
                    || name.ends_with('/') && modules.iter().any(|s| s.starts_with(name)),
                "{doc}: unknown {name}"
            );
        }
        for fence in fences.captures_iter(&source) {
            examples += 1;
            let code = &fence[1];
            let path = root().join(format!("tests/documented_{examples}.blot"));
            let mut f = Fixture::from_module(&compiled(
                path.to_str().unwrap(),
                &[Overlay {
                    path: path.display().to_string(),
                    contents: Some(code.into()),
                }],
            ));
            if code.contains("entry const orbit") {
                near_all(
                    &f.floats("orbit", std::f64::consts::FRAC_PI_2),
                    &[-1., 0., 0.],
                    1e-6,
                );
            } else if code.contains("entry const height") {
                assert_eq!(f.number("height", 0), 1.5);
            } else {
                panic!("add a witness for {doc}'s example");
            }
        }
    }
    assert_eq!(examples, 2);
}
