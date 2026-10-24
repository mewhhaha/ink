use super::*;
#[derive(Clone, Deserialize)]
pub struct Graph {
    pub name: String,
    pub version: u32,
    pub entry: u32,
    pub local: String,
    pub action: String,
    pub condition: String,
    pub act: String,
    pub ready: String,
    pub cleanup: String,
    pub nodes: Vec<Node>,
}
#[derive(Clone, Deserialize)]
pub struct Node {
    pub id: u32,
    #[serde(flatten)]
    pub op: Op,
}
#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Op {
    Act {
        action: String,
        next: u32,
    },
    Delay {
        seconds: f64,
        next: u32,
    },
    Until {
        condition: String,
        next: u32,
    },
    Choose {
        condition: String,
        yes: u32,
        no: u32,
    },
    Repeat {
        count: u32,
        body: u32,
        next: u32,
    },
    Again {
        owner: u32,
    },
    Stop,
}
fn validate(g: &Graph) -> Result<BTreeMap<u32, &Node>> {
    for s in [
        &g.name,
        &g.local,
        &g.action,
        &g.condition,
        &g.act,
        &g.ready,
        &g.cleanup,
    ] {
        ensure!(qualified(s), "Invalid graph identifier {s}");
    }
    ensure!(local(&g.name), "Graph name must be a local identifier");
    ensure!(!g.nodes.is_empty(), "Graph needs nodes");
    let mut nodes = BTreeMap::new();
    for n in &g.nodes {
        ensure!(
            nodes.insert(n.id, n).is_none(),
            "Duplicate graph node {}",
            n.id
        );
    }
    let target = |id: u32| -> Result<()> {
        ensure!(nodes.contains_key(&id), "Missing graph target {id}");
        Ok(())
    };
    target(g.entry)?;
    for n in &g.nodes {
        match &n.op {
            Op::Act { action, next } => {
                ensure!(!action.trim().is_empty(), "Missing action expression");
                target(*next)?;
            }
            Op::Delay { seconds, next } => {
                ensure!(
                    seconds.is_finite() && (*seconds as f32).is_finite() && *seconds >= 0.,
                    "Invalid delay"
                );
                target(*next)?;
            }
            Op::Until { condition, next } => {
                ensure!(!condition.trim().is_empty(), "Missing condition expression");
                target(*next)?;
            }
            Op::Choose { condition, yes, no } => {
                ensure!(!condition.trim().is_empty(), "Missing condition expression");
                target(*yes)?;
                target(*no)?;
            }
            Op::Repeat { body, next, .. } => {
                target(*body)?;
                target(*next)?;
            }
            Op::Again { owner } => {
                target(*owner)?;
                ensure!(
                    matches!(nodes[owner].op, Op::Repeat { .. }),
                    "Again owner must be Repeat"
                );
            }
            Op::Stop => {}
        }
    }
    Ok(nodes)
}
fn float(n: f64) -> String {
    if n.fract() == 0. {
        format!("{n}.0")
    } else {
        n.to_string()
    }
}
fn lines(s: &str) -> Vec<String> {
    s.lines().map(str::to_owned).collect()
}
fn advance(next: impl std::fmt::Display) -> Vec<String> {
    vec![
        format!("step := {next}"),
        "age := 0.0".into(),
        "transitions := self + 1".into(),
    ]
}
fn indented(v: Vec<String>, prefix: &str) -> Vec<String> {
    v.into_iter().map(|s| format!("{prefix}{s}")).collect()
}
pub fn compile(g: &Graph) -> Result<String> {
    let nodes = validate(g)?;
    let mut authored = Vec::new();
    let mut arms = Vec::new();
    for n in &g.nodes {
        let id = n.id;
        authored.push(match &n.op {
            Op::Act { action, next } => format!("_behavior.action {id} ({action}) {next}"),
            Op::Delay { seconds, next } => {
                format!("_behavior.wait {id} {} {next}", float(*seconds))
            }
            Op::Until { condition, next } => format!("_behavior.until {id} ({condition}) {next}"),
            Op::Choose { condition, yes, no } => {
                format!("_behavior.branch {id} ({condition}) {yes} {no}")
            }
            Op::Repeat { count, body, next } => {
                format!("_behavior.repeat {id} {count} {body} {next}")
            }
            Op::Again { owner } => format!("_behavior.again {id} {owner}"),
            Op::Stop => format!("_behavior.stop {id}"),
        });
        let body = match &n.op {
            Op::Act { action, next } => {
                let mut v = lines(&format!(
                    "let outcome = {} ({action}) (#_behavior.Tick {{ seconds: remaining, elapsed: age }}) local_value\ncase outcome of\n  #_behavior.Done {{ local, remaining: left }} => do:\n    if Bool.not (is_finite left) || left < 0.0 || left > remaining:\n      return #Nothing\n    local_value := local\n    remaining := left",
                    g.act
                ));
                v.extend(indented(advance(next), "    "));
                v.extend(lines(&format!("  #_behavior.Waiting {{ local, reason }} => do:\n    local_value := local\n    age := elapsed\n    remaining := 0.0\n    status := #_behavior.Action reason\n    waiting := #True\n  #_behavior.Abort {{ local, reason }} => do:\n    local_value := {} reason local\n    frames := #[]\n    status := #_behavior.Interrupted reason",g.cleanup)));
                v
            }
            Op::Delay { seconds, next } => {
                let mut v = lines(&format!(
                    "remaining := max 0.0 (elapsed - {})\nif elapsed >= {}:",
                    float(*seconds),
                    float(*seconds)
                ));
                v.extend(indented(advance(next), "  "));
                v.extend(lines(
                    "else:\n  age := elapsed\n  status := #_behavior.Time\n  waiting := #True",
                ));
                v
            }
            Op::Until { condition, next } => {
                let mut v = vec![format!("if {} ({condition}) local_value:", g.ready)];
                v.extend(indented(advance(next), "  "));
                v.extend(lines("else:\n  age := elapsed\n  remaining := 0.0\n  status := #_behavior.Condition\n  waiting := #True"));
                v
            }
            Op::Choose { condition, yes, no } => advance(format!(
                "if {} ({condition}) local_value then {yes} else {no}",
                g.ready
            )),
            Op::Repeat { count, body, next } => {
                if *count == 0 {
                    advance(next)
                } else {
                    let mut v = lines(&format!(
                        "if frames.length >= max_frames:\n  status := #_behavior.StackFull\n  waiting := #True\nelse:\n  frames := @array.concat self #[{{ owner: {id}, remaining: {count} }}]"
                    ));
                    v.extend(indented(advance(body), "  "));
                    v
                }
            }
            Op::Again { owner } => {
                let Op::Repeat { body, next, .. } = nodes[owner].op else {
                    unreachable!()
                };
                lines(&format!(
                    "if frames.length == 0:\n  return #Nothing\nlet at = frames.length - 1\nlet frame = frames[at]\nif frame.owner != {owner}:\n  return #Nothing\nif frame.remaining > 1:\n  frame.remaining := self - 1\n  frames[at] := frame\n  step := {body}\nelse:\n  frames := @array.slice self 0 at\n  step := {next}\nage := 0.0\ntransitions := self + 1"
                ))
            }
            Op::Stop => lines("status := #_behavior.Finished\nframes := #[]"),
        };
        let mut arm = vec![
            format!("      {id} => do:"),
            format!("        visited := @array.concat self #[{id}]"),
        ];
        arm.extend(indented(body, "        "));
        arms.push(arm.join("\n"));
    }
    let mut result = include_str!("behavior.blot.template").to_owned();
    for (key, value) in [
        ("NAME", g.name.clone()),
        ("ACTION", g.action.clone()),
        ("CONDITION", g.condition.clone()),
        ("LOCAL", g.local.clone()),
        ("VERSION", g.version.to_string()),
        ("ENTRY", g.entry.to_string()),
        ("AUTHORED", authored.join(", ")),
        ("ARMS", arms.join("\n")),
    ] {
        result = result.replace(&format!("@{key}@"), &value);
    }
    Ok(result)
}
pub fn selector(g: &Graph) -> Result<String> {
    let nodes = validate(g)?;
    ensure!(nodes.len() <= 1024, "Selector exceeds 1024 nodes");
    fn visit(
        id: u32,
        depth: usize,
        nodes: &BTreeMap<u32, &Node>,
        visiting: &mut BTreeSet<u32>,
        height: &mut BTreeMap<u32, usize>,
        order: &mut Vec<u32>,
    ) -> Result<usize> {
        ensure!(!visiting.contains(&id), "Selector contains a cycle");
        ensure!(depth <= 64, "Selector exceeds 64 decisions");
        if let Some(h) = height.get(&id) {
            return Ok(*h);
        }
        visiting.insert(id);
        let h = match nodes[&id].op {
            Op::Choose { yes, no, .. } => {
                1 + visit(yes, depth + 1, nodes, visiting, height, order)?.max(visit(
                    no,
                    depth + 1,
                    nodes,
                    visiting,
                    height,
                    order,
                )?)
            }
            Op::Act { next, .. } if matches!(nodes[&next].op, Op::Stop) => 0,
            _ => bail!("Selector must choose one action followed by stop"),
        };
        ensure!(h <= 64, "Selector exceeds 64 decisions");
        visiting.remove(&id);
        height.insert(id, h);
        order.push(id);
        Ok(h)
    }
    let mut order = Vec::new();
    visit(
        g.entry,
        0,
        &nodes,
        &mut BTreeSet::new(),
        &mut BTreeMap::new(),
        &mut order,
    )?;
    let name = |id: u32| format!("{}_select_node_{id}", g.name);
    let mut output = Vec::new();
    for id in order {
        let body = match &nodes[&id].op {
            Op::Act { action, .. } => action.clone(),
            Op::Choose { condition, yes, no } => format!(
                "if {} ({condition}) local then {} local else {} local",
                g.ready,
                name(*yes),
                name(*no)
            ),
            _ => unreachable!(),
        };
        output.push(format!(
            "const {} = fn (local: {}) -> {} => {body}",
            name(id),
            g.local,
            g.action
        ));
    }
    output.push(format!("const {}_select = {}\n", g.name, name(g.entry)));
    Ok(output.join("\n"))
}
