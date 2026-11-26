use crate::generate::{behavior, codec, dataflow};
use anyhow::{Context, Result, bail, ensure};
use pen_plugins::{BuildResult, Overlay, Plugins};
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Generation {
    /// Paths in jobs are relative to the selected Pen checkout.
    pub jobs: Vec<Job>,
}
#[derive(Deserialize)]
pub struct Job {
    pub output: PathBuf,
    pub entry: Option<PathBuf>,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub suffix: String,
    #[serde(flatten)]
    pub generator: Generator,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Generator {
    Codec {
        source: PathBuf,
        schema: PathBuf,
        published: Option<PathBuf>,
        manifest: Option<PathBuf>,
        #[serde(default)]
        generic: bool,
    },
    Behavior {
        source: PathBuf,
        graph: PathBuf,
        #[serde(default)]
        selector: bool,
    },
    Dataflow {
        graph: PathBuf,
        manifest: Option<PathBuf>,
    },
}
fn read<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    serde_json::from_slice(
        &std::fs::read(path).with_context(|| format!("reading {}", path.display()))?,
    )
    .with_context(|| format!("parsing {}", path.display()))
}
fn check(plugins: &Plugins, path: &Path, overlays: &[Overlay]) -> Result<()> {
    let mut compiler = plugins.compiler(path)?;
    let result = compiler.build(overlays)?;
    compiler.close()?;
    match result {
        BuildResult::Built(_) => Ok(()),
        BuildResult::Rejected(errors) => bail!("{}: {errors:#?}", path.display()),
    }
}
fn check_source(plugins: &Plugins, path: &Path, source: &str) -> Result<()> {
    // A synthetic export allows checking models that deliberately have no host ABI.
    check(
        plugins,
        path,
        &[Overlay {
            path: path.display().to_string(),
            contents: Some(format!("{source}\nio _ink_checked () : #[F32] => #[]\n")),
        }],
    )
}
pub fn generate(project: &Path, config: &Path, write: bool) -> Result<()> {
    generate_sources(project, config, write, true)
}
fn generate_sources(project: &Path, config: &Path, write: bool, validate: bool) -> Result<()> {
    let project = project.canonicalize()?;
    let request: Generation = read(config)?;
    let plugins = Plugins::load(
        &project,
        Arc::new(|level, text| eprintln!("{level:?}: {text}")),
    )?
    .context("generation needs pen.json")?;
    let mut outputs = std::collections::BTreeMap::new();
    for job in request.jobs {
        let output = project.join(&job.output);
        let mut code = match job.generator {
            Generator::Codec {
                source,
                schema,
                published,
                manifest,
                generic,
            } => {
                let source = project.join(source).canonicalize()?;
                let parent = output
                    .parent()
                    .context("output needs a parent")?
                    .canonicalize()?;
                ensure!(
                    source.parent() == Some(&parent) && source != output,
                    "codec output must be beside and distinct from its model"
                );
                let source_text = std::fs::read_to_string(&source)?;
                if validate {
                    check_source(&plugins, &source, &source_text)?;
                }
                let schema = read(&project.join(schema))?;
                let previous = match &published {
                    Some(p) => read(&project.join(p))?,
                    None => codec::Published::default(),
                };
                let (code, layout) = codec::generate(&source_text, &schema, &previous, !generic)?;
                if let Some(path) = manifest {
                    insert(
                        &mut outputs,
                        project.join(path),
                        serde_json::to_string_pretty(&layout)? + "\n",
                    )?;
                }
                code
            }
            Generator::Behavior {
                source,
                graph,
                selector,
            } => {
                let source = project.join(source);
                let model = std::fs::read_to_string(&source)?;
                if validate {
                    check_source(&plugins, &source, &model)?;
                }
                let graph = read(&project.join(graph))?;
                let mut code = model + "\n" + &behavior::compile(&graph)?;
                if selector {
                    code.push_str(&behavior::selector(&graph)?);
                }
                code
            }
            Generator::Dataflow { graph, manifest } => {
                let graph = read(&project.join(graph))?;
                let result = dataflow::compile(&graph)?;
                if let Some(path) = manifest {
                    let value = serde_json::json!({"dependencies": result.dependencies, "waves": result.waves});
                    // Stable field order is part of this tool's output, not the runtime format.
                    insert(
                        &mut outputs,
                        project.join(path),
                        serde_json::to_string_pretty(&value)? + "\n",
                    )?;
                }
                result.source
            }
        };
        code = job.prefix + &code + &job.suffix;
        let mut overlays: Vec<_> = outputs
            .iter()
            .filter(|(p, _)| p.extension().is_some_and(|x| x == "blot"))
            .map(|(p, s): (&PathBuf, &String)| Overlay {
                path: p.display().to_string(),
                contents: Some(s.clone()),
            })
            .collect();
        if let Some(entry) = job.entry {
            overlays.push(Overlay {
                path: output.display().to_string(),
                contents: Some(code.clone()),
            });
            if validate {
                check(&plugins, &project.join(entry), &overlays)?;
            }
        } else {
            overlays.push(Overlay {
                path: output.display().to_string(),
                contents: Some(format!("{code}\nio _ink_checked () : #[F32] => #[]\n")),
            });
            if validate {
                check(&plugins, &output, &overlays)?;
            }
        }
        insert(&mut outputs, output, code)?;
    }
    // Validate every job before changing any checked-in output. Check mode never writes.
    for (path, source) in outputs {
        if write {
            std::fs::write(&path, source)?;
        } else {
            ensure!(
                std::fs::read_to_string(&path).ok().as_deref() == Some(&source),
                "stale generated file {}; run generate with --write",
                path.display()
            );
        }
    }
    Ok(())
}
fn insert(
    outputs: &mut std::collections::BTreeMap<PathBuf, String>,
    path: PathBuf,
    source: String,
) -> Result<()> {
    ensure!(
        outputs.insert(path.clone(), source).is_none(),
        "duplicate generated output {}",
        path.display()
    );
    Ok(())
}
pub fn run(args: Vec<String>) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("generate") => {
            let config = PathBuf::from(
                args.get(1)
                    .context("generate CONFIG.json [--write] [--source-only] [--project DIR]")?,
            );
            let mut project = std::env::current_dir()?;
            let mut write = false;
            let mut validate = true;
            let mut flags = args[2..].iter();
            while let Some(flag) = flags.next() {
                match flag.as_str() {
                    "--write" => write = true,
                    "--source-only" => validate = false,
                    "--project" => project = PathBuf::from(flags.next().context("--project DIR")?),
                    _ => bail!("unknown generate option {flag}"),
                }
            }
            generate_sources(&project, &config, write, validate)?;
            if !validate {
                eprintln!("Source generation only; compiler qualification is pending.");
            }
            eprintln!(
                "Generated sources {}.",
                if write { "updated" } else { "checked" }
            );
        }
        Some("bench") => crate::benchmark::run(&args[1..])?,
        Some("pack") => {
            ensure!(args.len() == 2, "pack OUTPUT_DIRECTORY");
            crate::package::export(&crate::root(), Path::new(&args[1]))?;
            eprintln!("Exported Ink sources to {}", args[1]);
        }
        Some("fmt") => {
            ensure!(args.len() == 1 || args[1..] == ["--check"], "fmt [--check]");
            let mut command = std::process::Command::new("cargo");
            command
                .args(["fmt", "--manifest-path"])
                .arg(crate::root().join("tools/native/Cargo.toml"));
            if args.len() == 2 {
                command.arg("--check");
            }
            ensure!(command.status()?.success(), "Rust formatting failed");
        }
        _ => bail!(
            "usage: pen tool ink -- generate CONFIG.json [--write] [--source-only] [--project DIR] | bench [FILTER...] | pack OUTPUT_DIRECTORY | fmt [--check]"
        ),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn generation_checks_without_writing_and_rejects_invalid_models() {
        let directory = crate::root().join(format!(".cache/generation-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(directory.clone());
        let model = directory.join("model.blot");
        let output = directory.join("derived.blot");
        let schema = directory.join("schema.json");
        let config = directory.join("jobs.json");
        std::fs::write(
            &model,
            "type Flag is data = $Flag { enabled: Bool, count: U32 }\n",
        )
        .unwrap();
        std::fs::write(&schema,json!({"types":{"Flag":{"key":1,"version":1,"variants":{"Flag":{"tag":1,"fields":{"enabled":1,"count":2}}}}}}).to_string()).unwrap();
        std::fs::write(
            &config,
            json!({"jobs":[{"kind":"codec","source":model,"schema":schema,"output":output}]})
                .to_string(),
        )
        .unwrap();
        std::fs::write(&output, "sentinel").unwrap();
        assert!(
            generate(&crate::root(), &config, false)
                .unwrap_err()
                .to_string()
                .contains("stale generated")
        );
        assert_eq!(std::fs::read_to_string(&output).unwrap(), "sentinel");
        generate(&crate::root(), &config, true).unwrap();
        let generated = std::fs::read(&output).unwrap();
        generate(&crate::root(), &config, false).unwrap();
        std::fs::write(
            &model,
            "type Flag is data = $Flag { enabled: DoesNotExist, count: U32 }\n",
        )
        .unwrap();
        assert!(generate(&crate::root(), &config, true).is_err());
        assert_eq!(std::fs::read(&output).unwrap(), generated);
    }
}
