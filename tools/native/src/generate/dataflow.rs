use super::*;
#[derive(Clone, Deserialize)]
pub struct Call {
    pub call: String,
    pub args: Vec<String>,
}
#[derive(Clone, Deserialize)]
pub struct Step {
    pub id: String,
    #[serde(flatten)]
    pub call: Call,
}
#[derive(Clone, Deserialize)]
pub struct Input {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
}
#[derive(Clone, Deserialize)]
pub struct Graph {
    pub name: String,
    pub input: Input,
    pub result: String,
    pub steps: Vec<Step>,
    pub finish: Call,
}
#[derive(Debug, Serialize)]
pub struct Compiled {
    pub source: String,
    pub dependencies: Vec<Vec<usize>>,
    pub waves: Vec<Vec<usize>>,
}
pub fn compile(g: &Graph) -> Result<Compiled> {
    const OUT: &str = "_dataflow_result";
    ensure!(
        local(&g.name)
            && local(&g.input.name)
            && g.input.name != OUT
            && qualified(&g.input.ty)
            && qualified(&g.result)
            && g.steps.len() <= 256,
        "Invalid dataflow declaration"
    );
    let mut positions = BTreeMap::new();
    for (i, s) in g.steps.iter().enumerate() {
        ensure!(
            local(&s.id) && s.id != OUT && s.id != g.input.name && !positions.contains_key(&s.id),
            "Duplicate or invalid dataflow result"
        );
        positions.insert(s.id.clone(), i);
    }
    let dependencies = |c: &Call| -> Result<Vec<usize>> {
        ensure!(
            qualified(&c.call) && c.args.len() <= 16,
            "Invalid dataflow call"
        );
        let mut edges = BTreeSet::new();
        for arg in &c.args {
            ensure!(qualified(arg), "Arguments must be result references");
            let root = arg.split('.').next().unwrap();
            if root == g.input.name {
                continue;
            }
            edges.insert(
                *positions
                    .get(root)
                    .ok_or_else(|| anyhow::anyhow!("Unknown dataflow value {root}"))?,
            );
        }
        Ok(edges.into_iter().collect())
    };
    let edges = g
        .steps
        .iter()
        .map(|s| dependencies(&s.call))
        .collect::<Result<Vec<_>>>()?;
    let mut pending = dependencies(&g.finish)?;
    let mut needed = BTreeSet::new();
    while let Some(i) = pending.pop() {
        if needed.insert(i) {
            pending.extend(&edges[i]);
        }
    }
    ensure!(needed.len() == g.steps.len(), "Unused dataflow step");
    let mut done: BTreeSet<usize> = BTreeSet::new();
    let mut waves = Vec::new();
    while done.len() != g.steps.len() {
        let wave = (0..g.steps.len())
            .filter(|i| !done.contains(i) && edges[*i].iter().all(|j| done.contains(j)))
            .collect::<Vec<_>>();
        ensure!(!wave.is_empty(), "Cyclic dataflow graph");
        done.extend(&wave);
        waves.push(wave);
    }
    let call = |c: &Call| {
        format!(
            "{} {}",
            c.call,
            if c.args.is_empty() {
                "()".into()
            } else {
                c.args.join(" ")
            }
        )
    };
    let mut lines = vec![
        "// Generated pure dataflow. Serial execution; waves are eligibility metadata.".into(),
        format!(
            "const {}: {} -> {} = fn {} => do:",
            g.name, g.input.ty, g.result, g.input.name
        ),
    ];
    for i in waves.iter().flatten() {
        let s = &g.steps[*i];
        lines.push(format!("  let {} = {}", s.id, call(&s.call)));
    }
    lines.push(format!("  let {OUT} = {}", call(&g.finish)));
    lines.push(format!("  return {OUT}\n"));
    Ok(Compiled {
        source: lines.join("\n"),
        dependencies: edges,
        waves,
    })
}
