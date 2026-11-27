//! Structural extraction for opted-in data declarations. The native compiler
//! checks the complete source before this runs and checks the emitted code too.
//! This scanner does not decide whether a Squid program is well typed.
use super::*;
#[derive(Clone, Debug)]
pub struct Field {
    pub name: String,
    pub ty: String,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Payload {
    None,
    Record,
    Product,
    Scalar,
}
#[derive(Clone, Debug)]
pub struct Variant {
    pub name: String,
    pub fields: Vec<Field>,
    pub payload: Payload,
}
#[derive(Clone, Debug)]
pub struct Shape {
    pub name: String,
    pub parameters: Vec<String>,
    pub constructors: Vec<Variant>,
}
#[derive(Debug)]
struct Token<'a> {
    text: &'a str,
    start: usize,
    end: usize,
}
fn tokens(source: &str) -> Result<Vec<Token<'_>>> {
    let b = source.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if b[i..].starts_with(b"//") {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b[i..].starts_with(b"/*") {
            i += 2;
            let mut depth = 1;
            while i < b.len() && depth > 0 {
                if b[i..].starts_with(b"/*") {
                    depth += 1;
                    i += 2;
                } else if b[i..].starts_with(b"*/") {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            ensure!(depth == 0, "Unterminated comment");
            continue;
        }
        let start = i;
        if b[i] == b'"' {
            i += 1;
            while i < b.len() {
                if b[i] == b'\\' {
                    i += 2;
                    continue;
                }
                if b[i] == b'"' {
                    i += 1;
                    break;
                }
                i += 1;
            }
        } else if b[i].is_ascii_alphanumeric() || b[i] == b'_' {
            i += 1;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                i += 1;
            }
        } else {
            let width = source[i..].chars().next().unwrap().len_utf8();
            i += width;
        }
        ensure!(i <= b.len(), "Unterminated string");
        out.push(Token {
            text: &source[start..i],
            start,
            end: i,
        });
    }
    Ok(out)
}
fn split<'a>(tokens: &'a [Token<'a>], separator: &str) -> Result<Vec<&'a [Token<'a>]>> {
    let mut depth = 0i32;
    let mut start = 0;
    let mut out = Vec::new();
    for (i, t) in tokens.iter().enumerate() {
        match t.text {
            "(" | "[" | "{" => depth += 1,
            ")" | "]" | "}" => depth -= 1,
            _ => {}
        }
        ensure!(depth >= 0, "Unbalanced data payload");
        if depth == 0 && t.text == separator {
            out.push(&tokens[start..i]);
            start = i + 1;
        }
    }
    ensure!(depth == 0, "Unbalanced data payload");
    out.push(&tokens[start..]);
    Ok(out)
}
fn text(source: &str, t: &[Token<'_>]) -> String {
    if t.is_empty() {
        String::new()
    } else {
        source[t[0].start..t.last().unwrap().end].trim().to_owned()
    }
}
pub fn shapes(source: &str) -> Result<BTreeMap<String, Shape>> {
    let t = tokens(source)?;
    let mut result = BTreeMap::new();
    let mut i = 0;
    let mut depth = 0i32;
    while i < t.len() {
        let token = t[i].text;
        if depth == 0 && token == "type" {
            let start = i;
            i += 1;
            ensure!(i < t.len(), "Missing type name");
            let name = t[i].text.to_owned();
            i += 1;
            let mut params = Vec::new();
            while i < t.len() && t[i].text != "is" {
                if local(t[i].text) {
                    params.push(t[i].text.to_owned());
                }
                i += 1;
            }
            if i + 2 >= t.len() || t[i + 1].text != "data" || t[i + 2].text != "=" {
                i = start + 1;
                continue;
            }
            i += 3;
            let first = i;
            let mut nest = 0;
            while i < t.len() {
                let is_directive = t[i].text == "#"
                    && t.get(i + 1).is_some_and(|next| {
                        t[i].end == next.start
                            && matches!(next.text, "entry" | "kernel" | "process")
                    });
                if nest == 0
                    && (is_directive
                        || matches!(t[i].text, "type" | "const" | "impl" | "import" | "export"))
                {
                    break;
                }
                match t[i].text {
                    "(" | "[" | "{" => nest += 1,
                    ")" | "]" | "}" => nest -= 1,
                    _ => {}
                }
                ensure!(nest >= 0, "Invalid data declaration {name}");
                i += 1;
            }
            ensure!(nest == 0, "Unbalanced data declaration {name}");
            let mut constructors = Vec::new();
            for arm in split(&t[first..i], "|")? {
                ensure!(
                    arm.len() >= 2 && arm[0].text == "$" && local(arm[1].text),
                    "Unsupported constructor in {name}"
                );
                let variant = arm[1].text.to_owned();
                let p = &arm[2..];
                let (payload, fields) = if p.is_empty() {
                    (Payload::None, vec![])
                } else if p[0].text == "{" {
                    ensure!(p.last().unwrap().text == "}", "Invalid record {name}");
                    let mut fields = Vec::new();
                    for f in split(&p[1..p.len() - 1], ",")? {
                        if f.is_empty() {
                            continue;
                        }
                        ensure!(
                            f.len() >= 3 && local(f[0].text) && f[1].text == ":",
                            "Invalid field in {name}"
                        );
                        fields.push(Field {
                            name: f[0].text.into(),
                            ty: text(source, &f[2..]),
                        });
                    }
                    (Payload::Record, fields)
                } else if p[0].text == "("
                    && p.last().unwrap().text == ")"
                    && split(&p[1..p.len() - 1], ",")?.len() > 1
                {
                    let fields = split(&p[1..p.len() - 1], ",")?
                        .into_iter()
                        .enumerate()
                        .map(|(i, f)| Field {
                            name: i.to_string(),
                            ty: text(source, f),
                        })
                        .collect();
                    (Payload::Product, fields)
                } else {
                    (
                        Payload::Scalar,
                        vec![Field {
                            name: "0".into(),
                            ty: text(source, p),
                        }],
                    )
                };
                constructors.push(Variant {
                    name: variant,
                    fields,
                    payload,
                });
            }
            ensure!(!constructors.is_empty(), "No constructors for {name}");
            ensure!(
                result
                    .insert(
                        name.clone(),
                        Shape {
                            name,
                            parameters: params,
                            constructors
                        }
                    )
                    .is_none(),
                "Duplicate data declaration"
            );
            continue;
        }
        match token {
            "(" | "[" | "{" => depth += 1,
            ")" | "]" | "}" => depth -= 1,
            _ => {}
        }
        i += 1;
    }
    Ok(result)
}
pub fn words(s: &str) -> BTreeSet<&str> {
    s.split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .filter(|s| !s.is_empty())
        .collect()
}
pub fn argument(s: &str) -> String {
    if local(s) { s.into() } else { format!("({s})") }
}
pub fn head(s: &Shape) -> String {
    match s.parameters.as_slice() {
        [] => s.name.clone(),
        [p] => format!("({} {p})", s.name),
        ps => format!("({} [{}])", s.name, ps.join(", ")),
    }
}
pub fn parameter(s: &Shape) -> String {
    match s.parameters.as_slice() {
        [] => String::new(),
        [p] => format!(" {p}"),
        ps => format!(" [{}]", ps.join(", ")),
    }
}
pub fn requirements(s: &Shape) -> String {
    let mut required = s.parameters.clone();
    for v in &s.constructors {
        for f in &v.fields {
            let mut ty = f.ty.as_str();
            loop {
                if let Some(rest) = ty.strip_prefix("Array ") {
                    ty = rest;
                } else if let Some(rest) = ty.strip_prefix("#[").and_then(|s| s.strip_suffix(']')) {
                    ty = rest;
                } else {
                    break;
                }
            }
            if s.parameters.iter().any(|p| words(ty).contains(p.as_str()))
                && !required.iter().any(|x| x == ty)
            {
                required.push(ty.into());
            }
        }
    }
    if required.is_empty() {
        String::new()
    } else {
        format!(
            " where {{ {} }}",
            required
                .iter()
                .map(|t| format!("_derive_codec.Codec {}", argument(t)))
                .collect::<Vec<_>>()
                .join(", ")
        )
    }
}
pub fn pattern(v: &Variant, prefix: &str) -> String {
    match v.payload {
        Payload::None => format!("${}", v.name),
        Payload::Scalar => format!("${} {prefix}0", v.name),
        Payload::Product => format!(
            "${} ({})",
            v.name,
            (0..v.fields.len())
                .map(|i| format!("{prefix}{i}"))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Payload::Record => format!(
            "${} {{ {} }}",
            v.name,
            v.fields
                .iter()
                .enumerate()
                .map(|(i, f)| format!("{}: {prefix}{i}", f.name))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn structural_extraction_ignores_comments_strings_and_nested_type_punctuation() {
        let source = r#"
// type Wrong is data = #Wrong
/* type AlsoWrong is data = $Wrong /* nested */ */
const text = "type Fake is data = #Fake { field: U32 }"
type Box T is data = $Box { payload: T, }
type Pair is data = $Pair (F32, U32) | $Nothing
type Nested is data = $Nested { items: Array (Array U32), size: U32 }
"#;
        let found = shapes(source).unwrap();
        assert_eq!(found.len(), 3);
        assert_eq!(found["Box"].parameters, ["T"]);
        assert_eq!(found["Pair"].constructors[0].payload, Payload::Product);
        assert_eq!(found["Pair"].constructors[0].fields[1].ty, "U32");
        assert_eq!(
            found["Nested"].constructors[0].fields[0].ty,
            "Array (Array U32)"
        );
        for bad in [
            "/* unterminated",
            "type X is data = $X { x: U32",
            "type X is data = $X }",
            "type X is data = func x => return x",
        ] {
            assert!(shapes(bad).is_err(), "accepted {bad}");
        }
    }
}
