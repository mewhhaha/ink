//! Static website & GitHub Pages generator for Ink's examples gallery.
//!
//! Builds:
//! 1. Live interactive Pen WebGPU demos via `pen build --web`, deduplicating
//!    the shared Pen browser runtime once under `pen/`.
//! 2. Precompiled ABI 8 Wasm modules for every standalone pure-Blot example in
//!    `examples/` so visitors can run them live in the browser.
//! 3. Compiler-backed HTML API docs under `docs/` via `blot doc ink --html`.
//! 4. A zero-dependency gallery shell (`index.html`, `style.css`, `app.js`,
//!    `manifest.json`, `service-worker.js`, `.nojekyll`).
use anyhow::{Context, Result, bail, ensure};
use blot_host::{GuestModule, Parameter, ValueType};
use pen_plugins::{BuildResult, Plugins};
use serde::Serialize;
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

const INDEX_HTML: &str = include_str!("../../site/index.html");
const STYLE_CSS: &str = include_str!("../../site/style.css");
const APP_JS: &str = include_str!("../../site/app.js");
const DEMO_HTML: &str = include_str!("../../site/demo.html");
const SERVICE_WORKER_JS: &str = include_str!("../../site/service-worker.js");

struct PenDemoSpec {
    slug: &'static str,
    title: &'static str,
    category: &'static str,
    summary: &'static str,
    controls: &'static str,
    file: &'static str,
}

struct WasmExampleSpec {
    slug: &'static str,
    title: &'static str,
    category: &'static str,
    summary: &'static str,
    file: &'static str,
    default_arg: f64,
    param_label: &'static str,
}

const PEN_DEMOS: &[PenDemoSpec] = &[
    PenDemoSpec {
        slug: "sketch_ui",
        title: "Drawful Sketch UI",
        category: "Interactive WebGPU",
        summary: "Asset-free egui-style immediate-mode UI with wobbly marker strokes, 5 fps line boil, theme switching, and a live interactive doodle pad.",
        controls: "Click buttons, drag sliders, switch themes (Paper/Chalk/Note), or sketch in the chalkboard doodle pad.",
        file: "examples/sketch_ui.blot",
    },
    PenDemoSpec {
        slug: "d2_lighting",
        title: "2D Physics & Radiance Cascades GI",
        category: "Interactive WebGPU",
        summary: "Real-time 2D rigid-body physics casting dynamic Radiance Cascades global illumination shadows around a wall with a localized SDF HUD.",
        controls: "Click anywhere in the room to toss the glowing ball across the shadow-casting wall.",
        file: "examples/d2_lighting.blot",
    },
    PenDemoSpec {
        slug: "physics_sandbox",
        title: "3D Physics & Joints Sandbox",
        category: "Interactive WebGPU",
        summary: "Deterministic 3D rigid-body crate tower smashed by a swinging distance-joint pendulum, drawn with asset-free 3D polylines and Sketch UI.",
        controls: "Press KICK! or RESET, toggle AUTO ORBIT, and adjust GRAVITY or CAM YAW in the live HUD.",
        file: "examples/physics_sandbox.blot",
    },
    PenDemoSpec {
        slug: "nav_playground",
        title: "Navmesh, Funnel & ORCA Crowd",
        category: "Interactive WebGPU",
        summary: "Convex polygon navmesh with live A* corridor search, funnel string-pulling, and 6 autonomous ORCA collision-avoiding crowd agents.",
        controls: "Click anywhere inside the arena to move the goal; tweak CLEARANCE or click SWAP / RESET.",
        file: "examples/nav_playground.blot",
    },
    PenDemoSpec {
        slug: "ik_rig",
        title: "Procedural IK, Springs & Trauma",
        category: "Interactive WebGPU",
        summary: "Analytic 2-bone IK with soft reach alongside a 6-segment FABRIK chain tracking a spring-damped cursor target with Perlin trauma shake.",
        controls: "Move your cursor across the stage to pull both IK chains, click to trigger trauma shake, or adjust spring/cone sliders.",
        file: "examples/ik_rig.blot",
    },
];

const WASM_EXAMPLES: &[WasmExampleSpec] = &[
    WasmExampleSpec {
        slug: "orbit",
        title: "Quaternion Orbit",
        category: "Physics & Math",
        summary: "Minimal axis-angle quaternion rotation rotating the forward vector around +Y.",
        file: "examples/orbit.blot",
        default_arg: 1.5708,
        param_label: "angle (rad)",
    },
    WasmExampleSpec {
        slug: "ecs",
        title: "Core ECS Pools",
        category: "ECS & State",
        summary: "Spawning entities and stepping caller-owned Position/Velocity component pools with zero hidden globals.",
        file: "examples/ecs.blot",
        default_arg: 0.5,
        param_label: "seconds",
    },
    WasmExampleSpec {
        slug: "incremental_ecs",
        title: "Incremental ECS & Deltas",
        category: "ECS & State",
        summary: "Cached postfix queries, dependency recipes, coalesced command batches, journals, inverse relations, and message streams.",
        file: "examples/incremental_ecs.blot",
        default_arg: 0.0,
        param_label: "",
    },
    WasmExampleSpec {
        slug: "collections",
        title: "Maps, Sets & Handles",
        category: "ECS & State",
        summary: "Caller-owned hash maps, typed generational handle stores, and explicit checkpoint copies.",
        file: "examples/collections.blot",
        default_arg: 0.0,
        param_label: "",
    },
    WasmExampleSpec {
        slug: "physics",
        title: "3D Free-Fall Physics",
        category: "Physics & Math",
        summary: "Stepping a dynamic 3D rigid sphere under gravity with caller-owned contact caches.",
        file: "examples/physics.blot",
        default_arg: 10.0,
        param_label: "height (m)",
    },
    WasmExampleSpec {
        slug: "steps",
        title: "Fixed Timestep & Pose Lerp",
        category: "Physics & Math",
        summary: "Fixed-step accumulator with catch-up cap and shortest-arc pose interpolation.",
        file: "examples/steps.blot",
        default_arg: 0.05,
        param_label: "delta (s)",
    },
    WasmExampleSpec {
        slug: "joints",
        title: "Distance-Joint Pendulum",
        category: "Physics & Math",
        summary: "3D rigid body constrained to a fixed world anchor via `ink/physics/joints`.",
        file: "examples/joints.blot",
        default_arg: 16.0,
        param_label: "ticks",
    },
    WasmExampleSpec {
        slug: "ground",
        title: "Heightfield Terrain Sampling",
        category: "Physics & Math",
        summary: "Evaluating bilinear heightfield terrain samples and world-space elevation.",
        file: "examples/ground.blot",
        default_arg: 0.0,
        param_label: "x (m)",
    },
    WasmExampleSpec {
        slug: "navigation",
        title: "Grid A* Pathfinding",
        category: "Nav & AI",
        summary: "Weighted 4-neighbor A* shortest path across an authored grid with caller-owned work buffers.",
        file: "examples/navigation.blot",
        default_arg: 0.0,
        param_label: "start cell",
    },
    WasmExampleSpec {
        slug: "navmesh",
        title: "Navmesh Funnel & ORCA",
        category: "Nav & AI",
        summary: "Authored convex polygon navmesh search, taut funnel string-pulling, and head-on ORCA reciprocal avoidance.",
        file: "examples/navmesh.blot",
        default_arg: 0.0,
        param_label: "",
    },
    WasmExampleSpec {
        slug: "animation",
        title: "Skeletal Blend & Foot IK",
        category: "Animation",
        summary: "Clip evaluation, cross-fade blending, root motion, and skeletal pose synthesis.",
        file: "examples/animation.blot",
        default_arg: 1.5,
        param_label: "speed",
    },
    WasmExampleSpec {
        slug: "cinematic",
        title: "Timeline & Sequencer Shot",
        category: "Animation",
        summary: "Multi-track Hermite sequencer curves, camera director blends, and cue firing.",
        file: "examples/cinematic.blot",
        default_arg: 0.5,
        param_label: "seconds",
    },
    WasmExampleSpec {
        slug: "rollback",
        title: "Two-Peer GGPO Rollback",
        category: "Netcode & Editor",
        summary: "Deterministic peer-to-peer rollback netcode with snapshot rings, packet loss/delay, and final-frame checksums.",
        file: "examples/rollback.blot",
        default_arg: 40.0,
        param_label: "frames",
    },
    WasmExampleSpec {
        slug: "showcase_editor",
        title: "Scene Graph, Editor & Kernels",
        category: "Netcode & Editor",
        summary: "Headless 3D scene-graph picking, undo/redo command history, play-in-editor snapshots, and `#kernel` SIMD terrain/foliage evaluation.",
        file: "examples/showcase_editor.blot",
        default_arg: 0.5,
        param_label: "time (s)",
    },
    WasmExampleSpec {
        slug: "game",
        title: "Composed Game State",
        category: "ECS & State",
        summary: "End-to-end game tick combining math, timing, and explicit caller-owned state.",
        file: "examples/game.blot",
        default_arg: 0.5,
        param_label: "seconds",
    },
    WasmExampleSpec {
        slug: "mechanisms",
        title: "Cross-Module Mechanisms",
        category: "ECS & State",
        summary: "Dashboard exercising clocks, handles, derived caches, preferences, and task queues together.",
        file: "examples/mechanisms.blot",
        default_arg: 0.0,
        param_label: "seed",
    },
];

#[derive(Serialize)]
struct Manifest {
    #[serde(rename = "hasDocs")]
    has_docs: bool,
    examples: Vec<ExampleEntry>,
}

#[derive(Serialize)]
struct EntryPoint {
    name: String,
    param: String,
    result: String,
    #[serde(rename = "defaultArg")]
    default_arg: f64,
    #[serde(rename = "paramLabel")]
    param_label: String,
}

#[derive(Serialize)]
struct ExampleEntry {
    slug: String,
    title: String,
    category: String,
    kind: &'static str,
    summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    controls: Option<String>,
    file: String,
    modules: Vec<String>,
    source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    wasm: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    entries: Vec<EntryPoint>,
}

fn extract_ink_modules(source: &str) -> Vec<String> {
    let mut set = BTreeSet::new();
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("//") {
            continue;
        }
        if let Some(pos) = trimmed.find("\"ink/") {
            let rest = &trimmed[pos + 1..];
            if let Some(end) = rest.find('"') {
                set.insert(rest[..end].to_owned());
            }
        }
    }
    set.into_iter().collect()
}

fn find_pen_bin() -> PathBuf {
    if let Ok(explicit) = std::env::var("PEN_BIN") {
        let p = PathBuf::from(explicit);
        if p.is_file() {
            return p;
        }
    }
    PathBuf::from("pen")
}

fn find_blot2_root(root: &Path) -> Result<PathBuf> {
    let candidate = root.join("../blot2").canonicalize().context(
        "sibling ../blot2 checkout not found (required for Blot stdlib and native compiler)",
    )?;
    ensure!(
        candidate.join("std").is_dir(),
        "{} is missing std/",
        candidate.display()
    );
    Ok(candidate)
}

fn find_blotc(blot2: &Path) -> Result<PathBuf> {
    let direct = blot2.join("compiler-goose/build/blotc-goose");
    if direct.is_file() {
        return Ok(direct);
    }
    let gz = blot2.join("generated/compiler/blotc.gz");
    if gz.is_file() {
        return Ok(gz);
    }
    bail!(
        "no Blot compiler found under {} (expected compiler-goose/build/blotc-goose or generated/compiler/blotc.gz)",
        blot2.display()
    );
}

fn copy_file_checked(src: &Path, dst: &Path) -> Result<()> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(src, dst)
        .with_context(|| format!("copying {} -> {}", src.display(), dst.display()))?;
    Ok(())
}

fn maybe_optimize_wasm(path: &Path) {
    let _ = Command::new("wasm-opt")
        .args(["-O2", "--all-features", "-o"])
        .arg(path)
        .arg(path)
        .status();
}

fn value_type_name(vt: &ValueType) -> &'static str {
    match vt {
        ValueType::Unit => "Unit",
        ValueType::Bool => "Bool",
        ValueType::U32 => "U32",
        ValueType::F32 => "F32",
        ValueType::ArrayU32 => "ArrayU32",
        ValueType::ArrayF32 => "ArrayF32",
    }
}

fn build_pen_demo(
    root: &Path,
    blot2: &Path,
    blotc: &Path,
    pen_bin: &Path,
    spec: &PenDemoSpec,
    staging_root: &Path,
    out_dir: &Path,
    copy_shared_runtime: bool,
) -> Result<()> {
    let proj = staging_root.join(spec.slug);
    let _ = std::fs::remove_dir_all(&proj);
    std::fs::create_dir_all(proj.join("src/assets"))?;
    copy_file_checked(&root.join(spec.file), &proj.join("src/main.blot"))?;
    std::fs::write(
        proj.join("src/assets/catalog.json"),
        "{\"meshes\":[],\"materials\":[]}\n",
    )?;
    let pen_json = serde_json::json!({
        "game": { "name": spec.slug, "title": format!("Ink — {}", spec.title) },
        "plugins": {
            "blot": {
                "read": [
                    blot2.join("std"),
                    root.join("lib"),
                    root.join("tests/fixtures/pen")
                ],
                "run": { "blotc": blotc }
            }
        },
        "compiler": {
            "plugin": "blot",
            "settings": {
                "std": blot2.join("std"),
                "imports": {
                    "ink/": format!("{}/", root.join("lib").display()),
                    "pen/": format!("{}/", root.join("tests/fixtures/pen").display())
                }
            }
        }
    });
    std::fs::write(
        proj.join("pen.json"),
        serde_json::to_string_pretty(&pen_json)? + "\n",
    )?;

    let export_dir = proj.join("dist/web");
    let status = Command::new(pen_bin)
        .args(["build", "--project"])
        .arg(&proj)
        .args(["--web", "--out"])
        .arg(&export_dir)
        .status()
        .with_context(|| {
            format!(
                "running {} build --web for {}",
                pen_bin.display(),
                spec.slug
            )
        })?;
    ensure!(status.success(), "pen build --web failed for {}", spec.slug);

    if copy_shared_runtime {
        let shared = out_dir.join("pen");
        std::fs::create_dir_all(&shared)?;
        for name in [
            "pen_web.js",
            "pen_web_bg.wasm",
            "guest.js",
            "structured.js",
            "kernels.js",
            "kernel_worker.js",
            "LICENSE",
            "THIRD_PARTY_NOTICES.md",
        ] {
            let src = export_dir.join(name);
            if src.is_file() {
                copy_file_checked(&src, &shared.join(name))?;
            }
        }
    }

    let demo_out = out_dir.join("demos").join(spec.slug);
    std::fs::create_dir_all(demo_out.join("assets"))?;
    for name in ["game.wasm", "catalog.json", "game.json"] {
        copy_file_checked(&export_dir.join(name), &demo_out.join(name))?;
    }
    let html = DEMO_HTML.replace("__TITLE__", &format!("Ink — {}", spec.title));
    std::fs::write(demo_out.join("index.html"), html)?;
    Ok(())
}

fn try_build_docs(root: &Path, blot2: &Path, out_dir: &Path) -> Result<bool> {
    let docs_out = out_dir.join("docs");
    let cli_ts = blot2.join("host/cli.ts");
    if cli_ts.is_file() {
        let deno_candidates = [
            std::env::var("HOME")
                .ok()
                .map(|h| PathBuf::from(h).join(".deno/bin/deno")),
            Some(PathBuf::from("deno")),
        ];
        for candidate in deno_candidates.into_iter().flatten() {
            if let Ok(status) = Command::new(&candidate)
                .current_dir(root)
                .args(["run", "--allow-all"])
                .arg(&cli_ts)
                .args(["doc", "ink", "--html", "--out"])
                .arg(&docs_out)
                .status()
                && status.success()
            {
                return Ok(true);
            }
        }
    }
    if let Ok(status) = Command::new("blot")
        .current_dir(root)
        .args(["doc", "ink", "--html", "--out"])
        .arg(&docs_out)
        .status()
        && status.success()
    {
        return Ok(true);
    }
    Ok(false)
}

pub fn build(root: &Path, out_dir: &Path, include_docs: bool, overwrite: bool) -> Result<()> {
    let root = root.canonicalize()?;
    if out_dir.exists() {
        ensure!(
            overwrite,
            "site output already exists: {} (pass --overwrite to replace)",
            out_dir.display()
        );
        std::fs::remove_dir_all(out_dir)?;
    }
    std::fs::create_dir_all(out_dir)?;

    let blot2 = find_blot2_root(&root)?;
    let blotc = find_blotc(&blot2)?;
    let pen_bin = find_pen_bin();
    let staging_root = root.join(format!(".cache/site-staging-{}", std::process::id()));
    std::fs::create_dir_all(&staging_root)?;
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(staging_root.clone());

    let mut manifest_entries = Vec::new();

    for (idx, spec) in PEN_DEMOS.iter().enumerate() {
        eprintln!("Building Pen WebGPU demo: {}...", spec.slug);
        build_pen_demo(
            &root,
            &blot2,
            &blotc,
            &pen_bin,
            spec,
            &staging_root,
            out_dir,
            idx == 0,
        )?;
        let source = std::fs::read_to_string(root.join(spec.file))?;
        let modules = extract_ink_modules(&source);
        manifest_entries.push(ExampleEntry {
            slug: spec.slug.into(),
            title: spec.title.into(),
            category: spec.category.into(),
            kind: "pen",
            summary: spec.summary.into(),
            controls: Some(spec.controls.into()),
            file: spec.file.into(),
            modules,
            source,
            wasm: None,
            entries: Vec::new(),
        });
    }

    eprintln!(
        "Compiling {} standalone Blot Wasm examples...",
        WASM_EXAMPLES.len()
    );
    let plugins = Plugins::load(
        &root,
        Arc::new(|level, text| eprintln!("{level:?}: {text}")),
    )?
    .context("site generation needs pen.json")?;
    let engine = blot_host::dev_engine()?;
    let wasm_dir = out_dir.join("wasm");
    std::fs::create_dir_all(&wasm_dir)?;

    for spec in WASM_EXAMPLES {
        let src_path = root.join(spec.file);
        let source = std::fs::read_to_string(&src_path)?;
        let modules = extract_ink_modules(&source);
        let mut compiler = plugins.compiler(&src_path)?;
        let bytes = match compiler.build(&[])? {
            BuildResult::Built(bytes) => bytes,
            BuildResult::Rejected(errors) => {
                compiler.close()?;
                bail!("{}: {errors:#?}", spec.file);
            }
        };
        compiler.close()?;
        let guest_mod = GuestModule::new(&engine, &bytes, None)?;
        let mut entries = Vec::new();
        for f in &guest_mod.abi().functions {
            if f.name.starts_with("blot:") || f.name.starts_with("test_") {
                continue;
            }
            let Parameter::Value(ref param_vt) = f.parameter else {
                continue;
            };
            let param = value_type_name(param_vt);
            let result = value_type_name(&f.result);
            if !matches!(param, "Unit" | "F32" | "U32") {
                continue;
            }
            entries.push(EntryPoint {
                name: f.name.clone(),
                param: param.into(),
                result: result.into(),
                default_arg: spec.default_arg,
                param_label: spec.param_label.into(),
            });
        }
        let wasm_file = wasm_dir.join(format!("{}.wasm", spec.slug));
        std::fs::write(&wasm_file, &bytes)?;
        maybe_optimize_wasm(&wasm_file);
        manifest_entries.push(ExampleEntry {
            slug: spec.slug.into(),
            title: spec.title.into(),
            category: spec.category.into(),
            kind: "wasm",
            summary: spec.summary.into(),
            controls: None,
            file: spec.file.into(),
            modules,
            source,
            wasm: Some(format!("wasm/{}.wasm", spec.slug)),
            entries,
        });
    }

    let has_docs = if include_docs {
        eprintln!("Generating compiler-backed HTML API docs (blot doc ink --html)...");
        try_build_docs(&root, &blot2, out_dir)?
    } else {
        false
    };

    let manifest = Manifest {
        has_docs,
        examples: manifest_entries,
    };
    std::fs::write(
        out_dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)? + "\n",
    )?;
    std::fs::write(out_dir.join("index.html"), INDEX_HTML)?;
    std::fs::write(out_dir.join("style.css"), STYLE_CSS)?;
    std::fs::write(out_dir.join("app.js"), APP_JS)?;
    std::fs::write(out_dir.join("service-worker.js"), SERVICE_WORKER_JS)?;
    std::fs::write(out_dir.join(".nojekyll"), "")?;

    eprintln!(
        "Built Ink examples site in {} ({} Pen demos, {} Wasm examples, docs: {})",
        out_dir.display(),
        PEN_DEMOS.len(),
        WASM_EXAMPLES.len(),
        if has_docs { "included" } else { "skipped" }
    );
    Ok(())
}
