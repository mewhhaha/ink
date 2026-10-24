//! Native source generators. Inputs and emitted programs are checked by Pen.
use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
pub mod behavior;
pub mod dataflow;
pub fn local(s: &str) -> bool {
    let mut c = s.bytes();
    matches!(c.next(), Some(b'a'..=b'z' | b'A'..=b'Z' | b'_'))
        && c.all(|c| c.is_ascii_alphanumeric() || c == b'_')
}
pub fn qualified(s: &str) -> bool {
    s.split('.').all(local)
}
pub mod codec;
pub mod shapes;
