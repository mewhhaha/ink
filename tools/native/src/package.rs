//! A source-only distribution. No runtime or package-manager shim is needed.
use anyhow::{Result, ensure};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
pub fn files(root: &Path) -> Result<Vec<PathBuf>> {
    fn walk(root: &Path, dir: &Path, suffix: &str, out: &mut Vec<PathBuf>) -> Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                walk(root, &entry.path(), suffix, out)?;
            } else if entry.path().extension().is_some_and(|s| s == suffix) {
                out.push(entry.path().strip_prefix(root)?.into());
            }
        }
        Ok(())
    }
    let mut out = vec![PathBuf::from("LICENSE"), PathBuf::from("README.md")];
    for (dir, suffix) in [
        ("lib", "blot"),
        ("shaders", "wgsl"),
        ("examples", "blot"),
        ("docs", "md"),
    ] {
        walk(root, &root.join(dir), suffix, &mut out)?;
    }
    out.sort();
    Ok(out)
}
pub fn export(root: &Path, output: &Path) -> Result<()> {
    ensure!(
        !output.exists(),
        "distribution output already exists: {}",
        output.display()
    );
    let sources = files(root)?;
    let mut hashes = BTreeMap::new();
    std::fs::create_dir_all(output)?;
    for path in sources {
        let bytes = std::fs::read(root.join(&path))?;
        let target = output.join(&path);
        std::fs::create_dir_all(target.parent().unwrap())?;
        std::fs::write(&target, &bytes)?;
        hashes.insert(
            path.to_string_lossy().replace('\\', "/"),
            format!("{:x}", Sha256::digest(&bytes)),
        );
    }
    std::fs::write(
        output.join("ink.json"),
        serde_json::to_string_pretty(
            &serde_json::json!({"format":1,"library":"lib/","sha256":hashes}),
        )? + "\n",
    )?;
    Ok(())
}
