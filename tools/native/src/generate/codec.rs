use super::shapes::*;
use super::*;
#[derive(Clone, Deserialize)]
pub struct Schema {
    pub types: BTreeMap<String, Plan>,
}
#[derive(Clone, Deserialize)]
pub struct Plan {
    pub version: u32,
    pub key: u32,
    #[serde(default)]
    pub capacity: u32,
    pub variants: BTreeMap<String, VariantPlan>,
}
#[derive(Clone, Deserialize)]
pub struct VariantPlan {
    pub tag: u32,
    pub fields: BTreeMap<String, u32>,
}
#[derive(Default, Deserialize, Serialize)]
pub struct Published {
    pub types: BTreeMap<String, PublishedType>,
}
#[derive(Deserialize, Serialize)]
pub struct PublishedType {
    pub version: u32,
    pub key: u32,
    pub layout: String,
}
#[derive(Serialize)]
struct Layout {
    capacity: u32,
    variants: Vec<LayoutVariant>,
}
#[derive(Serialize)]
struct LayoutVariant {
    tag: u32,
    fields: Vec<LayoutField>,
}
#[derive(Serialize)]
struct LayoutField {
    id: u32,
    #[serde(rename = "type")]
    ty: String,
}
fn scalar(ty: &str) -> Option<(&'static str, &'static str)> {
    match ty {
        "U32" => Some((
            "_derive_codec.unsigned_word",
            "_derive_codec.unsigned_from_word",
        )),
        "F32" => Some(("_derive_codec.float_word", "_derive_codec.float_from_word")),
        "Bool" => Some((
            "_derive_codec.boolean_word",
            "_derive_codec.boolean_from_word",
        )),
        _ => None,
    }
}
fn snake(name: &str) -> String {
    let letters: Vec<_> = name.chars().collect();
    let mut result = String::new();
    for (index, &letter) in letters.iter().enumerate() {
        if letter.is_ascii_uppercase() && index > 0 {
            let previous = letters[index - 1];
            let starts_word = previous.is_ascii_lowercase()
                || previous.is_ascii_digit()
                || previous.is_ascii_uppercase()
                    && letters.get(index + 1).is_some_and(char::is_ascii_lowercase);
            if starts_word {
                result.push('_');
            }
        }
        result.push(letter.to_ascii_lowercase());
    }
    result
}
fn sorted<'a>(v: &'a Variant, p: &VariantPlan) -> Vec<(usize, &'a Field, u32)> {
    let mut fields = v
        .fields
        .iter()
        .enumerate()
        .map(|(i, f)| (i, f, p.fields[&f.name]))
        .collect::<Vec<_>>();
    fields.sort_by_key(|f| f.2);
    fields
}
fn validate(s: &Shape, p: &Plan) -> Result<()> {
    ensure!(
        p.version <= 0xffffff && p.key > 0 && p.key <= 0xffffff && p.capacity <= 8388606,
        "Invalid Ink schema integer for {}",
        s.name
    );
    ensure!(
        p.variants.len() == s.constructors.len(),
        "Unknown or missing variant in {}",
        s.name
    );
    let mut tags = BTreeSet::new();
    for v in &s.constructors {
        let plan = p
            .variants
            .get(&v.name)
            .ok_or_else(|| anyhow::anyhow!("Missing variant {}", v.name))?;
        ensure!(
            plan.tag <= 0xffffff && tags.insert(plan.tag),
            "Duplicate or invalid variant tag"
        );
        ensure!(
            plan.fields.len() == v.fields.len(),
            "Unknown or missing field in {}",
            v.name
        );
        let mut ids = BTreeSet::new();
        for f in &v.fields {
            let id = *plan
                .fields
                .get(&f.name)
                .ok_or_else(|| anyhow::anyhow!("Missing field {}", f.name))?;
            ensure!(
                id <= 0xffffff && ids.insert(id),
                "Duplicate or invalid field ID"
            );
            ensure!(
                !words(&f.ty).contains(s.name.as_str()),
                "Recursive fields require handwritten codecs"
            );
            ensure!(
                !words(&f.ty).contains("Array") && !f.ty.contains("#["),
                "Owning collection fields require flat spans and separately named payloads"
            );
            ensure!(
                !f.ty.contains("->"),
                "Function field has no structural codec"
            );
        }
    }
    Ok(())
}
fn push(lines: &mut Vec<String>, s: &str) {
    lines.extend(s.lines().map(str::to_owned));
}
pub fn emit(s: &Shape, p: &Plan, specialize: bool) -> Result<String> {
    validate(s, p)?;
    let mut encode = Vec::new();
    let mut decode = Vec::new();
    for v in &s.constructors {
        let vp = &p.variants[&v.name];
        let fs = sorted(v, vp);
        let fixed = fs
            .iter()
            .all(|(_, f, _)| specialize && scalar(&f.ty).is_some());
        encode.push(format!("  {} => do:", pattern(v, "v")));
        if fixed {
            let mut words = vec![
                p.version.to_string(),
                vp.tag.to_string(),
                fs.len().to_string(),
            ];
            for (i, f, id) in &fs {
                words.extend([
                    id.to_string(),
                    "1".into(),
                    format!("{} v{i}", scalar(&f.ty).unwrap().0),
                ]);
            }
            encode.push(format!("    break #[{}]", words.join(", ")));
        } else {
            for (i, f, _) in &fs {
                if f.ty.starts_with("Array ") || (f.ty.starts_with("#[") && f.ty.ends_with(']')) {
                    push(
                        &mut encode,
                        &format!(
                            "    let collected{i}: #[U32] = #[v{i}.length]\n    for item{i} in v{i}:\n      let item_words{i} = _derive_codec.encode item{i}\n      @storage.push collected{i} item_words{i}.length\n      for word{i} in item_words{i}:\n        @storage.push collected{i} word{i}\n    let payload{i} = collected{i}"
                        ),
                    );
                } else {
                    encode.push(format!("    let payload{i} = _derive_codec.encode v{i}"));
                }
            }
            let length = std::iter::once((3 + 2 * fs.len()).to_string())
                .chain(fs.iter().map(|(i, _, _)| format!("payload{i}.length")))
                .collect::<Vec<_>>()
                .join(" + ");
            push(
                &mut encode,
                &format!(
                    "    let out = @array.fill ({length}) 0\n    out[0] := {}\n    out[1] := {}\n    out[2] := {}",
                    p.version,
                    vp.tag,
                    fs.len()
                ),
            );
            if !fs.is_empty() {
                encode.push("    let cursor = 3".into());
            }
            for (pos, (i, _, id)) in fs.iter().enumerate() {
                push(
                    &mut encode,
                    &format!(
                        "    out[cursor] := {id}\n    out[cursor + 1] := payload{i}.length\n    for index in 0 .. payload{i}.length:\n      out[cursor + 2 + index] := payload{i}[index]"
                    ),
                );
                if pos + 1 < fs.len() {
                    encode.push(format!("    cursor := self + 2 + payload{i}.length"));
                }
            }
            encode.push("    break out".into());
        }
        push(
            &mut decode,
            &format!(
                "    if tag == {}:\n      if count != {}:\n        return $Nothing",
                vp.tag,
                fs.len()
            ),
        );
        if fixed {
            push(
                &mut decode,
                &format!(
                    "      if words.length != {}:\n        return $Nothing",
                    3 + fs.len() * 3
                ),
            );
        } else {
            decode.push("      let cursor = 3".into());
        }
        for (pos, (i, f, id)) in fs.iter().enumerate() {
            if fixed {
                let offset = 3 + 3 * pos;
                push(
                    &mut decode,
                    &format!(
                        "      if words[{offset}] != {id} or words[{}] != 1:\n        return $Nothing\n      let $Some value{i} = {} words[{}] else:\n        return $Nothing",
                        offset + 1,
                        scalar(&f.ty).unwrap().1,
                        offset + 2
                    ),
                );
                continue;
            }
            push(
                &mut decode,
                &format!(
                    "      if words.length - cursor < 2:\n        return $Nothing\n      if words[cursor] != {id}:\n        return $Nothing\n      let width{pos} = words[cursor + 1]\n      cursor := self + 2\n      if width{pos} > words.length - cursor:\n        return $Nothing\n      let payload{pos} = @array.slice words cursor width{pos}\n      cursor := self + width{pos}"
                ),
            );
            if let Some(element) =
                f.ty.strip_prefix("Array ")
                    .or_else(|| f.ty.strip_prefix("#[").and_then(|s| s.strip_suffix(']')))
            {
                let ty = argument(element);
                push(
                    &mut decode,
                    &format!(
                        "      if payload{pos}.length == 0:\n        return $Nothing\n      let element_count{i} = payload{pos}[0]\n      if element_count{i} > payload{pos}.length - 1:\n        return $Nothing\n      let cursor{i} = 1\n      let elements{i}: #[{ty}] = #[]\n      for ignored{i} in 0..element_count{i}:\n        if cursor{i} >= payload{pos}.length:\n          return $Nothing\n        let element_width{i} = payload{pos}[cursor{i}]\n        cursor{i} := self + 1\n        if element_width{i} > payload{pos}.length - cursor{i}:\n          return $Nothing\n        let item_words{i} = @array.slice payload{pos} cursor{i} element_width{i}\n        let item_decoded{i}: Maybe {ty} = _derive_codec.Codec.decode item_words{i}\n        let $Some item{i} = item_decoded{i} else:\n          return $Nothing\n        @storage.push elements{i} item{i}\n        cursor{i} := self + element_width{i}\n      if cursor{i} != payload{pos}.length:\n        return $Nothing\n      let value{i} = elements{i}"
                    ),
                );
            } else {
                push(
                    &mut decode,
                    &format!(
                        "      let decoded{i}: Maybe {} = _derive_codec.Codec.decode payload{pos}\n      let $Some value{i} = decoded{i} else:\n        return $Nothing",
                        argument(&f.ty)
                    ),
                );
            }
        }
        if !fixed {
            push(
                &mut decode,
                "      if cursor != words.length:\n        return $Nothing",
            );
        }
        decode.push(format!("      return $Some ({})", pattern(v, "value")));
    }
    let name = format!("_derive_{}_encode", snake(&s.name));
    let req = requirements(s);
    let annotation = if s.parameters.is_empty() {
        "value".to_owned()
    } else {
        format!("(value: {}): #[U32]{req}", head(s))
    };
    let mut lines = vec![format!("func {name} {annotation} => case value of")];
    lines.extend(encode);
    let decode_name = format!("_derive_{}_decode", snake(&s.name));
    push(
        &mut lines,
        &format!(
            "func {decode_name} (words: #[U32]): Maybe {}{req} =>\n  if words.length < 3 or words[0] != {}:\n    return $Nothing\n  let tag = words[1]\n  let count = words[2]",
            head(s),
            p.version
        ),
    );
    lines.extend(
        decode
            .into_iter()
            .map(|line| line.strip_prefix("  ").unwrap_or(&line).to_owned()),
    );
    push(&mut lines, "  return $Nothing");
    push(
        &mut lines,
        &format!(
            "const {}.Codec: _derive_codec.Codec {}{req} = {{\n  encode: func value => {name} value,\n  decode: func words => {decode_name} words,\n}}",
            s.name,
            head(s)
        ),
    );
    Ok(lines.join("\n") + "\n")
}
fn metadata_span(payload: &mut Vec<u32>, value: &str) -> String {
    let start = payload.len();
    payload.extend(value.chars().map(u32::from));
    format!(
        "$_ink_codec.Span {{start: {start}, count: {}}}",
        payload.len() - start
    )
}
pub fn generate(
    source: &str,
    schema: &Schema,
    previous: &Published,
    specialize: bool,
) -> Result<(String, Published)> {
    let shapes = shapes(source)?;
    let mut ordered = Vec::new();
    fn visit(
        name: &str,
        shapes: &BTreeMap<String, Shape>,
        schema: &Schema,
        visiting: &mut BTreeSet<String>,
        ordered: &mut Vec<String>,
    ) -> Result<()> {
        if ordered.iter().any(|s| s == name) {
            return Ok(());
        }
        ensure!(
            visiting.insert(name.into()),
            "Recursive fields require handwritten codecs"
        );
        let shape = shapes
            .get(name)
            .ok_or_else(|| anyhow::anyhow!("No checked data declaration for {name}"))?;
        for field in shape.constructors.iter().flat_map(|v| &v.fields) {
            for dependency in schema.types.keys() {
                if words(&field.ty).contains(dependency.as_str()) {
                    visit(dependency, shapes, schema, visiting, ordered)?;
                }
            }
        }
        visiting.remove(name);
        ordered.push(name.into());
        Ok(())
    }
    for name in schema.types.keys() {
        visit(name, &shapes, schema, &mut BTreeSet::new(), &mut ordered)?;
    }
    let mut published = Published::default();
    let mut generated = Vec::new();
    let mut metadata_text = Vec::new();
    let mut keys = BTreeSet::new();
    for name in ordered {
        let s = &shapes[&name];
        let p = &schema.types[&name];
        validate(s, p)?;
        ensure!(keys.insert(p.key), "Duplicate section key {}", p.key);
        let mut variants = s.constructors.iter().collect::<Vec<_>>();
        variants.sort_by_key(|v| p.variants[&v.name].tag);
        let layout = Layout {
            capacity: p.capacity,
            variants: variants
                .iter()
                .map(|v| {
                    let vp = &p.variants[&v.name];
                    LayoutVariant {
                        tag: vp.tag,
                        fields: sorted(v, vp)
                            .iter()
                            .map(|(_, f, id)| LayoutField {
                                id: *id,
                                ty: f.ty.clone(),
                            })
                            .collect(),
                    }
                })
                .collect(),
        };
        let layout = serde_json::to_string(&layout)?;
        if let Some(old) = previous.types.get(&name) {
            ensure!(p.version >= old.version, "{name}: codec version decreased");
            ensure!(p.key == old.key, "{name}: published section key changed");
            ensure!(
                p.version != old.version
                    || serde_json::from_str::<serde_json::Value>(&old.layout)?
                        == serde_json::from_str::<serde_json::Value>(&layout)?,
                "{name}: layout changed without a codec version change"
            );
        }
        published.types.insert(
            name.clone(),
            PublishedType {
                version: p.version,
                key: p.key,
                layout,
            },
        );
        generated.push(emit(s, p, specialize)?);
        // Stored metadata rows contain spans only. One shared codepoint pool
        // owns all labels; descriptor() merely borrows these immutable arrays.
        let mut fields = Vec::new();
        let mut descriptors = Vec::new();
        for variant in &variants {
            let plan = &p.variants[&variant.name];
            let label = metadata_span(&mut metadata_text, &variant.name);
            let first = fields.len();
            for (_, field, id) in sorted(variant, plan) {
                let field_label = metadata_span(&mut metadata_text, &field.name);
                let type_name = metadata_span(&mut metadata_text, &field.ty);
                let kind = match field.ty.as_str() {
                    "U32" => "Unsigned",
                    "F32" => "Float",
                    "Bool" => "Boolean",
                    _ => "Encoded",
                };
                fields.push(format!("$_ink_codec.Field {{id: {id}, label: {field_label}, type_name: {type_name}, kind: $_ink_codec.{kind}}}"));
            }
            descriptors.push(format!("$_ink_codec.Variant {{tag: {}, label: {label}, fields: $_ink_codec.Span {{start: {first}, count: {}}}}}", plan.tag, fields.len() - first));
        }
        let helper = snake(&name);
        let descriptor = format!(
            "const {name}_fields: #[_ink_codec.Field] = #[{}]\nconst {name}_variants: #[_ink_codec.Variant] = #[{}]\nfunc {helper}_descriptor () => $_ink_codec.Descriptor {{version: {}, variants: &{name}_variants[0..{name}_variants.length], fields: &{name}_fields[0..{name}_fields.length], text: &_derive_metadata_text[0.._derive_metadata_text.length]}}",
            fields.join(", "),
            descriptors.join(", "),
            p.version
        );
        generated.push(format!("func {helper}_codec migration => _ink_codec.bridge {} {} {} _derive_{stem}_encode _derive_{stem}_decode migration\n",p.key,p.version,p.capacity,stem=helper));
        generated.push(format!("func {helper}_words migration => _ink_codec.saved {} {} _derive_{stem}_encode _derive_{stem}_decode migration\n",p.key,p.version,stem=helper));
        generated.push(descriptor);
    }
    generated.insert(
        0,
        format!(
            "const _derive_metadata_text: #[U32] = #[{}]",
            metadata_text
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        ),
    );
    Ok((
        format!(
            "// Generated by Ink; edit the model and schema inputs.\nimport * as _derive_codec from \"ink/codec\"\nimport * as _ink_codec from \"ink/codec\"\n{source}\n{}",
            generated.join("\n")
        ),
        published,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_helpers_use_lowercase_snake_case() {
        let source = "type ActorObservation is data = $ActorObservation { id: U32 }\ntype HTTPState is data = $HTTPState { ready: Bool }";
        let schema = serde_json::from_value(serde_json::json!({"types": {
            "ActorObservation": {"version": 1, "key": 1, "variants": {"ActorObservation": {"tag": 0, "fields": {"id": 0}}}},
            "HTTPState": {"version": 1, "key": 2, "variants": {"HTTPState": {"tag": 0, "fields": {"ready": 0}}}}
        }})).unwrap();
        let (output, _) = generate(source, &schema, &Published::default(), true).unwrap();
        for name in ["actor_observation", "http_state"] {
            for suffix in ["codec", "words", "descriptor"] {
                assert!(output.contains(&format!("func {name}_{suffix} ")));
            }
            for suffix in ["encode", "decode"] {
                assert!(output.contains(&format!("func _derive_{name}_{suffix} ")));
                assert!(output.contains(&format!("=> _derive_{name}_{suffix} ")));
            }
        }
        for line in output.lines().filter_map(|line| line.strip_prefix("func ")) {
            assert!(line.starts_with(|c: char| c.is_ascii_lowercase() || c == '_'));
        }
    }
}
