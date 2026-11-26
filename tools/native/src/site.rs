//! Static website & GitHub Pages generator for Ink's examples showcase.
//!
//! Generates a minimal, zero-dashboard static site:
//! - `index.html`: pure HTML index (no JS, no filters/search) linking to
//!   top-level WebGPU demo pages and Blot Wasm example pages.
//! - `demos/<slug>/`: top-level Pen WebGPU demo pages sharing one deduplicated
//!   Pen browser host under `demos/pen/` plus a scoped `demos/service-worker.js`.
//! - `examples/<slug>/`: top-level pure-Blot Wasm example pages with an on-demand
//!   `source.blot` viewer and ABI 8 browser runner.
//! - `docs/`: compiler-backed HTML API reference (`blot doc ink --html`).
use anyhow::{Context, Result, bail, ensure};
use blot_host::{GuestModule, Parameter, ValueType};
use pen_plugins::{BuildResult, Plugins};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

const STYLE_CSS: &str = include_str!("../../site/style.css");
const APP_JS: &str = include_str!("../../site/app.js");
const BLOT_HIGHLIGHT_JS: &str = include_str!("../../site/blot-highlight.js");
const DEMO_JS: &str = include_str!("../../site/demo.js");
const DEMOS_SW_JS: &str = include_str!("../../site/demos-sw.js");
const RETIRE_ROOT_SW_JS: &str = include_str!("../../site/service-worker.js");
const GITHUB_BLOB: &str = "https://github.com/mewhhaha/ink/blob/main/";

const REQUIRED_PEN_RUNTIME_FILES: &[&str] = &[
    "pen_web.js",
    "pen_web_bg.wasm",
    "guest.js",
    "structured.js",
    "kernels.js",
    "kernel_worker.js",
];

const OPTIONAL_PEN_NOTICE_FILES: &[&str] = &["LICENSE", "THIRD_PARTY_NOTICES.md"];

struct PenDemoSpec {
    slug: &'static str,
    title: &'static str,
    summary: &'static str,
    controls: &'static str,
    file: &'static str,
}

struct WasmExampleSpec {
    slug: &'static str,
    title: &'static str,
    summary: &'static str,
    file: &'static str,
    default_arg: f64,
    param_label: &'static str,
    max_arg: Option<u32>,
}

const PEN_DEMOS: &[PenDemoSpec] = &[
    PenDemoSpec {
        slug: "sketch_ui",
        title: "Drawful Sketch UI",
        summary: "Hand-drawn immediate-mode widgets, 5 fps line boil, themes, and a doodle pad.",
        controls: "Click buttons, drag sliders, switch themes, or draw inside the chalkboard pad.",
        file: "examples/sketch_ui.blot",
    },
    PenDemoSpec {
        slug: "d2_lighting",
        title: "2D Physics & Radiance Cascades GI",
        summary: "2D rigid body casting real-time global illumination shadows around a wall.",
        controls: "Click anywhere in the room to launch the glowing orb across the wall.",
        file: "examples/d2_lighting.blot",
    },
    PenDemoSpec {
        slug: "physics_sandbox",
        title: "3D Physics & Joints Sandbox",
        summary: "Wireframe rigid-body crate tower hit by a swinging distance-joint pendulum.",
        controls: "Press KICK! or RESET, toggle AUTO ORBIT, and adjust GRAVITY or CAM YAW.",
        file: "examples/physics_sandbox.blot",
    },
    PenDemoSpec {
        slug: "nav_playground",
        title: "Navmesh, Funnel & ORCA Crowd",
        summary: "Convex polygon navmesh, A* corridor, funnel path, and six ORCA crowd agents.",
        controls: "Click anywhere in the arena to move the goal; tweak CLEARANCE or click SWAP.",
        file: "examples/nav_playground.blot",
    },
    PenDemoSpec {
        slug: "ik_rig",
        title: "Procedural IK & Springs",
        summary: "Two-bone analytic IK and a 6-bone FABRIK chain tracking a spring target.",
        controls: "Move the pointer across the stage, click for trauma shake, or adjust sliders.",
        file: "examples/ik_rig.blot",
    },
];

const WASM_EXAMPLES: &[WasmExampleSpec] = &[
    WasmExampleSpec {
        slug: "orbit",
        title: "Quaternion Orbit",
        summary: "Axis-angle quaternion rotation of the forward vector around +Y.",
        file: "examples/orbit.blot",
        default_arg: 1.5708,
        param_label: "angle (rad)",
        max_arg: None,
    },
    WasmExampleSpec {
        slug: "ecs",
        title: "Core ECS Pools",
        summary: "Spawning entities and stepping caller-owned component pools.",
        file: "examples/ecs.blot",
        default_arg: 0.5,
        param_label: "seconds",
        max_arg: None,
    },
    WasmExampleSpec {
        slug: "incremental_ecs",
        title: "Incremental ECS & Deltas",
        summary: "Cached queries, spawn recipes, coalesced commands, journals, and relations.",
        file: "examples/incremental_ecs.blot",
        default_arg: 0.0,
        param_label: "",
        max_arg: None,
    },
    WasmExampleSpec {
        slug: "collections",
        title: "Maps, Sets & Handles",
        summary: "Caller-owned hash maps, typed generational handles, and explicit copies.",
        file: "examples/collections.blot",
        default_arg: 0.0,
        param_label: "",
        max_arg: None,
    },
    WasmExampleSpec {
        slug: "physics",
        title: "3D Free-Fall Physics",
        summary: "Stepping a dynamic 3D rigid sphere with caller-owned contact storage.",
        file: "examples/physics.blot",
        default_arg: 10.0,
        param_label: "height (m)",
        max_arg: None,
    },
    WasmExampleSpec {
        slug: "steps",
        title: "Fixed Timestep & Pose Lerp",
        summary: "Fixed-step accumulator with catch-up limit and pose interpolation.",
        file: "examples/steps.blot",
        default_arg: 0.05,
        param_label: "delta (s)",
        max_arg: None,
    },
    WasmExampleSpec {
        slug: "joints",
        title: "Distance-Joint Pendulum",
        summary: "3D rigid body constrained to a world anchor via distance joints.",
        file: "examples/joints.blot",
        default_arg: 16.0,
        param_label: "ticks (0–16)",
        max_arg: Some(16),
    },
    WasmExampleSpec {
        slug: "ground",
        title: "Heightfield Terrain",
        summary: "Bilinear heightfield elevation sampling in world space.",
        file: "examples/ground.blot",
        default_arg: 0.0,
        param_label: "x (m)",
        max_arg: None,
    },
    WasmExampleSpec {
        slug: "navigation",
        title: "Grid A* Pathfinding",
        summary: "Weighted 4-neighbor A* shortest path on an authored grid.",
        file: "examples/navigation.blot",
        default_arg: 0.0,
        param_label: "start cell (0–11)",
        max_arg: Some(11),
    },
    WasmExampleSpec {
        slug: "navmesh",
        title: "Navmesh Funnel & ORCA",
        summary: "Polygon navmesh corridor search, funnel pull, and reciprocal avoidance.",
        file: "examples/navmesh.blot",
        default_arg: 0.0,
        param_label: "",
        max_arg: None,
    },
    WasmExampleSpec {
        slug: "animation",
        title: "Skeletal Blend & Foot IK",
        summary: "Clip evaluation, cross-fading, root motion, and pose synthesis.",
        file: "examples/animation.blot",
        default_arg: 1.5,
        param_label: "speed",
        max_arg: None,
    },
    WasmExampleSpec {
        slug: "cinematic",
        title: "Timeline & Sequencer Shot",
        summary: "Multi-track Hermite curves, camera director blends, and cues.",
        file: "examples/cinematic.blot",
        default_arg: 0.5,
        param_label: "seconds",
        max_arg: None,
    },
    WasmExampleSpec {
        slug: "rollback",
        title: "Two-Peer GGPO Rollback",
        summary: "Deterministic rollback netcode with snapshot rings and checksums.",
        file: "examples/rollback.blot",
        default_arg: 40.0,
        param_label: "frames",
        max_arg: Some(2000),
    },
    WasmExampleSpec {
        slug: "showcase_editor",
        title: "Scene Graph, Editor & Kernels",
        summary: "Ray picking, undo/redo, play-in-editor snapshots, and SIMD kernels.",
        file: "examples/showcase_editor.blot",
        default_arg: 0.5,
        param_label: "time (s)",
        max_arg: None,
    },
    WasmExampleSpec {
        slug: "game",
        title: "Composed Game State",
        summary: "End-to-end game tick combining math, timing, and explicit state.",
        file: "examples/game.blot",
        default_arg: 0.5,
        param_label: "seconds",
        max_arg: None,
    },
    WasmExampleSpec {
        slug: "mechanisms",
        title: "Cross-Module Mechanisms",
        summary: "Clocks, handles, derived caches, preferences, and task queues together.",
        file: "examples/mechanisms.blot",
        default_arg: 0.0,
        param_label: "",
        max_arg: None,
    },
];

#[derive(Serialize)]
struct ExampleSpecJson {
    wasm: &'static str,
    entries: Vec<EntryPoint>,
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
    #[serde(rename = "maxArg", skip_serializing_if = "Option::is_none")]
    max_arg: Option<u32>,
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn escape_json_script(json: &str) -> String {
    json.replace("</", "<\\/")
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
    ensure!(src.is_file(), "missing required file: {}", src.display());
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(src, dst)
        .with_context(|| format!("copying {} -> {}", src.display(), dst.display()))?;
    Ok(())
}

fn optimize_wasm_if_available(path: &Path) -> Result<()> {
    match Command::new("wasm-opt")
        .args(["-O2", "--all-features", "-o"])
        .arg(path)
        .arg(path)
        .status()
    {
        Ok(status) => {
            ensure!(status.success(), "wasm-opt failed on {}", path.display());
            Ok(())
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err).with_context(|| format!("running wasm-opt on {}", path.display())),
    }
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

fn render_index_html(has_docs: bool) -> String {
    let mut pen_cards = String::new();
    for spec in PEN_DEMOS {
        pen_cards.push_str(&format!(
            "        <a class=\"card\" href=\"./demos/{slug}/\">\n          <span class=\"card-title\">{title}</span>\n          <span class=\"card-desc\">{summary}</span>\n        </a>\n",
            slug = spec.slug,
            title = escape_html(spec.title),
            summary = escape_html(spec.summary),
        ));
    }

    let mut wasm_rows = String::new();
    for spec in WASM_EXAMPLES {
        let short_file = spec.file.strip_prefix("examples/").unwrap_or(spec.file);
        wasm_rows.push_str(&format!(
            "        <a class=\"row-link\" href=\"./examples/{slug}/\">\n          <span class=\"row-title\">{title}</span>\n          <span class=\"row-file\">{short_file}</span>\n        </a>\n",
            slug = spec.slug,
            title = escape_html(spec.title),
            short_file = escape_html(short_file),
        ));
    }

    let docs_link = if has_docs {
        "<a href=\"./docs/index.html\">API Docs</a>\n        "
    } else {
        ""
    };

    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ink Examples</title>
  <meta name="description" content="Asset-free game systems examples for Blot and Pen.">
  <link rel="stylesheet" href="./style.css">
</head>
<body>
  <div class="wrap">
    <header class="masthead">
      <h1>Ink<span>Examples</span></h1>
      <nav aria-label="Links">
        {docs_link}<a href="https://github.com/mewhhaha/ink" target="_blank" rel="noopener">GitHub ↗</a>
      </nav>
    </header>

    <main>
      <section class="section" aria-labelledby="webgpu-heading">
        <h2 id="webgpu-heading">WebGPU demos</h2>
        <div class="grid">
{pen_cards}        </div>
      </section>

      <section class="section" aria-labelledby="blot-heading">
        <h2 id="blot-heading">Blot examples</h2>
        <div class="list">
{wasm_rows}        </div>
      </section>
    </main>
  </div>
</body>
</html>
"#
    )
}

fn render_pen_demo_html(spec: &PenDemoSpec) -> String {
    let title = escape_html(spec.title);
    let controls = escape_html(spec.controls);
    let file = escape_html(spec.file);
    let github_url = format!("{GITHUB_BLOB}{}", spec.file);

    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title} — Ink</title>
  <link rel="stylesheet" href="../../style.css">
</head>
<body>
  <div class="wrap">
    <header class="crumb">
      <div class="crumb-left">
        <a class="back" href="../../">← All examples</a>
        <h1>{title}</h1>
      </div>
      <div class="crumb-actions">
        <button id="restart-btn" type="button">Restart</button>
        <button id="fullscreen-btn" type="button">Fullscreen</button>
      </div>
    </header>

    <main>
      <div class="stage" id="stage">
        <canvas id="game" tabindex="0" aria-label="{title}"></canvas>
        <p class="stage-loading" id="loading" role="status">Loading WebGPU runtime…</p>
        <p class="stage-error" id="status" role="alert"></p>
      </div>
      <p class="controls-note">{controls}</p>

      <details class="source" data-src="./source.blot">
        <summary>
          <span>Source</span>
          <span class="source-head">{file}</span>
        </summary>
        <div class="source-bar">
          <a href="{github_url}" target="_blank" rel="noopener">View on GitHub ↗</a>
          <button type="button" data-copy disabled>Copy</button>
        </div>
        <pre class="source-code" tabindex="0"><code>Loading source…</code></pre>
      </details>
    </main>
  </div>

  <script type="module" src="../../demo.js"></script>
  <script type="module" src="../../app.js"></script>
</body>
</html>
"#
    )
}

fn render_wasm_example_html(spec: &WasmExampleSpec, entries: &[EntryPoint]) -> Result<String> {
    let title = escape_html(spec.title);
    let summary = escape_html(spec.summary);
    let file = escape_html(spec.file);
    let github_url = format!("{GITHUB_BLOB}{}", spec.file);
    let json = escape_json_script(&serde_json::to_string(&ExampleSpecJson {
        wasm: "./module.wasm",
        entries: entries
            .iter()
            .map(|e| EntryPoint {
                name: e.name.clone(),
                param: e.param.clone(),
                result: e.result.clone(),
                default_arg: e.default_arg,
                param_label: e.param_label.clone(),
                max_arg: e.max_arg,
            })
            .collect(),
    })?);

    Ok(format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title} — Ink</title>
  <link rel="stylesheet" href="../../style.css">
</head>
<body>
  <div class="wrap">
    <header class="crumb">
      <div class="crumb-left">
        <a class="back" href="../../">← All examples</a>
        <h1>{title}</h1>
      </div>
    </header>

    <main>
      <p class="lead">{summary}</p>

      <section class="runner" aria-label="Run example in WebAssembly">
        <form id="runner-form" class="runner-form" novalidate>
          <label id="entry-field" hidden>Entry <select id="entry-select"></select></label>
          <label id="arg-field" hidden><span id="arg-label">arg</span> <input id="arg-input" type="number"></label>
          <button id="run-btn" class="primary" type="submit">Run</button>
        </form>
        <pre id="runner-out" class="runner-out" role="status">Running…</pre>
      </section>

      <details class="source" data-src="./source.blot" open>
        <summary>
          <span>Source</span>
          <span class="source-head">{file}</span>
        </summary>
        <div class="source-bar">
          <a href="{github_url}" target="_blank" rel="noopener">View on GitHub ↗</a>
          <button type="button" data-copy disabled>Copy</button>
        </div>
        <pre class="source-code" tabindex="0"><code>Loading source…</code></pre>
      </details>
    </main>
  </div>

  <script id="example-spec" type="application/json">{json}</script>
  <script type="module" src="../../app.js"></script>
</body>
</html>
"#
    ))
}

#[allow(clippy::too_many_arguments)]
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
        let shared = out_dir.join("demos/pen");
        std::fs::create_dir_all(&shared)?;
        for name in REQUIRED_PEN_RUNTIME_FILES {
            copy_file_checked(&export_dir.join(name), &shared.join(name))?;
        }
        for name in OPTIONAL_PEN_NOTICE_FILES {
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
    copy_file_checked(&root.join(spec.file), &demo_out.join("source.blot"))?;
    std::fs::write(demo_out.join("index.html"), render_pen_demo_html(spec))?;
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

fn ensure_safe_overwrite_target(root: &Path, out_dir: &Path) -> Result<()> {
    let canon_root = root.canonicalize()?;
    let canon_out = out_dir.canonicalize()?;
    ensure!(
        canon_out != canon_root && !canon_root.starts_with(&canon_out),
        "refusing to --overwrite {} because it is the repository root or an ancestor of {}",
        canon_out.display(),
        canon_root.display()
    );
    Ok(())
}

pub fn build(root: &Path, out_dir: &Path, include_docs: bool, overwrite: bool) -> Result<()> {
    let root = root.canonicalize()?;
    if out_dir.exists() {
        ensure!(
            overwrite,
            "site output already exists: {} (pass --overwrite to replace)",
            out_dir.display()
        );
        ensure_safe_overwrite_target(&root, out_dir)?;
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
    }
    std::fs::write(out_dir.join("demos/service-worker.js"), DEMOS_SW_JS)?;

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

    for spec in WASM_EXAMPLES {
        let src_path = root.join(spec.file);
        let mut compiler = plugins.compiler(&src_path)?;
        let bytes = match compiler.build(&[])? {
            BuildResult::Built(bytes) => bytes,
            BuildResult::Rejected(errors) => {
                compiler.close()?;
                bail!("{}: {errors:#?}", spec.file);
            }
        };
        compiler.close()?;

        let ex_dir = out_dir.join("examples").join(spec.slug);
        std::fs::create_dir_all(&ex_dir)?;
        let wasm_file = ex_dir.join("module.wasm");
        std::fs::write(&wasm_file, &bytes)?;
        optimize_wasm_if_available(&wasm_file)?;

        // Re-validate the exact published Wasm bytes and verify ABI 8 + zero imports.
        let published_bytes = std::fs::read(&wasm_file)?;
        let raw_mod = wasmtime::Module::new(&engine, &published_bytes)
            .map_err(|e| anyhow::anyhow!("compiling published {}: {e:#}", wasm_file.display()))?;
        ensure!(
            raw_mod.imports().next().is_none(),
            "{}: published standalone Wasm example must have zero imports",
            spec.file
        );
        let guest_mod = GuestModule::new(&engine, &published_bytes, None)
            .with_context(|| format!("validating published {}", wasm_file.display()))?;
        ensure!(
            guest_mod.abi().data_stacks,
            "{}: published standalone Wasm example must use Blot ABI 8",
            spec.file
        );
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
                max_arg: spec.max_arg,
            });
        }
        ensure!(
            !entries.is_empty(),
            "{}: no runnable public io entry point found",
            spec.file
        );

        copy_file_checked(&src_path, &ex_dir.join("source.blot"))?;
        std::fs::write(
            ex_dir.join("index.html"),
            render_wasm_example_html(spec, &entries)?,
        )?;
    }

    let has_docs = if include_docs {
        eprintln!("Generating compiler-backed HTML API docs (blot doc ink --html)...");
        try_build_docs(&root, &blot2, out_dir)?
    } else {
        false
    };

    std::fs::write(out_dir.join("index.html"), render_index_html(has_docs))?;
    std::fs::write(out_dir.join("style.css"), STYLE_CSS)?;
    std::fs::write(out_dir.join("app.js"), APP_JS)?;
    std::fs::write(out_dir.join("blot-highlight.js"), BLOT_HIGHLIGHT_JS)?;
    std::fs::write(out_dir.join("demo.js"), DEMO_JS)?;
    std::fs::write(out_dir.join("service-worker.js"), RETIRE_ROOT_SW_JS)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn site_specs_reference_existing_examples_with_unique_slugs() {
        let root = crate::root();
        let mut slugs = std::collections::BTreeSet::new();
        for demo in PEN_DEMOS {
            assert!(slugs.insert(demo.slug), "duplicate slug {}", demo.slug);
            assert!(root.join(demo.file).is_file(), "missing {}", demo.file);
        }
        for ex in WASM_EXAMPLES {
            assert!(slugs.insert(ex.slug), "duplicate slug {}", ex.slug);
            assert!(root.join(ex.file).is_file(), "missing {}", ex.file);
        }
        let html = render_index_html(true);
        assert!(html.contains("./demos/sketch_ui/"));
        assert!(html.contains("./examples/orbit/"));
        assert!(html.contains("./docs/index.html"));
        assert!(!html.contains("<script"));
    }

    #[test]
    fn overwrite_guard_rejects_repo_root_and_ancestors() {
        let root = crate::root();
        assert!(ensure_safe_overwrite_target(&root, &root).is_err());
        if let Some(parent) = root.parent() {
            assert!(ensure_safe_overwrite_target(&root, parent).is_err());
        }
    }
}
