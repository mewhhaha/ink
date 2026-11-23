//! Native references for Ink. Compilation and guest execution use Pen's libraries.
//! No game, display, JavaScript runtime, or alternate compiler driver is involved.
use blot_host::{Guest, GuestModule, Parameter, Value, ValueType};
use pen_plugins::{BuildResult, Overlay, Plugins};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

pub fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}
pub fn plugins() -> &'static Arc<Plugins> {
    static PLUGINS: OnceLock<Arc<Plugins>> = OnceLock::new();
    PLUGINS.get_or_init(|| {
        Plugins::load(
            &root(),
            Arc::new(|level, message| eprintln!("{level:?}: {message}")),
        )
        .unwrap()
        .unwrap()
    })
}
pub fn engine() -> &'static wasmtime::Engine {
    static ENGINE: OnceLock<wasmtime::Engine> = OnceLock::new();
    ENGINE.get_or_init(|| blot_host::dev_engine().unwrap())
}
pub fn build(path: &str, overlays: &[Overlay]) -> BuildResult {
    let mut compiler = plugins().compiler(&root().join(path)).unwrap();
    let result = compiler.build(overlays).unwrap();
    compiler.close().unwrap();
    result
}
pub fn compiled(path: &str, overlays: &[Overlay]) -> GuestModule {
    match build(path, overlays) {
        BuildResult::Built(bytes) => GuestModule::new(engine(), &bytes, None).unwrap(),
        BuildResult::Rejected(errors) => panic!("{path}: {errors:#?}"),
    }
}
pub struct Fixture {
    pub guest: Guest,
}
impl Fixture {
    pub fn new(path: &str) -> Self {
        static MODULES: OnceLock<Mutex<BTreeMap<String, GuestModule>>> = OnceLock::new();
        let mut modules = MODULES
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let module = modules
            .entry(path.into())
            .or_insert_with(|| compiled(path, &[]));
        Self::from_module(module)
    }
    pub fn from_module(module: &GuestModule) -> Self {
        let mut guest = Guest::new(engine(), module).unwrap();
        guest.set_deadline(Duration::from_secs(
            std::env::var("PEN_TEST_DEADLINE_SECONDS")
                .ok()
                .map(|s| s.parse().expect("invalid test deadline"))
                .unwrap_or(600),
        ));
        Self { guest }
    }
    pub fn call(&mut self, name: &str, arg: impl Into<Input>) -> anyhow::Result<Value> {
        let parameter = self
            .guest
            .abi()
            .functions
            .iter()
            .find(|f| f.name == name)
            .unwrap_or_else(|| panic!("missing entry {name}"))
            .parameter
            .clone();
        let arg = match (arg.into(), parameter) {
            (Input::Bool(x), Parameter::Value(ValueType::Bool)) => Value::Bool(x),
            (Input::Unit, Parameter::Value(ValueType::Unit)) => Value::Unit,
            (Input::Number(x), Parameter::Value(ValueType::U32)) => {
                assert!(x >= 0.0 && x <= u32::MAX as f64 && x.fract() == 0.0);
                Value::U32(x as u32)
            }
            (Input::Number(x), Parameter::Value(ValueType::F32)) => Value::F32(x as f32),
            (Input::Floats(xs), Parameter::Value(ValueType::ArrayF32)) => {
                Value::ArrayF32(xs.iter().map(|&x| x as f32).collect())
            }
            (Input::Words(xs), Parameter::Value(ValueType::ArrayU32)) => Value::ArrayU32(xs),
            (arg, parameter) => panic!("{name}: {arg:?} does not match {parameter:?}"),
        };
        self.guest.call(name, arg)
    }
    pub fn floats(&mut self, name: &str, arg: impl Into<Input>) -> Vec<f64> {
        match self.call(name, arg).unwrap() {
            Value::ArrayF32(xs) => xs.into_iter().map(f64::from).collect(),
            other => panic!("{name}: {other:?}"),
        }
    }
    pub fn words(&mut self, name: &str, arg: impl Into<Input>) -> Vec<u32> {
        match self.call(name, arg).unwrap() {
            Value::ArrayU32(xs) => xs,
            other => panic!("{name}: {other:?}"),
        }
    }
    pub fn number(&mut self, name: &str, arg: impl Into<Input>) -> f64 {
        match self.call(name, arg).unwrap() {
            Value::F32(x) => x.into(),
            Value::U32(x) => x.into(),
            other => panic!("{name}: {other:?}"),
        }
    }
    pub fn traps(&mut self, name: &str, arg: impl Into<Input>) {
        let error = self.call(name, arg).expect_err("malformed input must trap");
        assert_eq!(
            error.downcast_ref::<wasmtime::Trap>(),
            Some(&wasmtime::Trap::UnreachableCodeReached),
            "{error:#}"
        );
    }
}
#[derive(Debug)]
pub enum Input {
    Bool(bool),
    Unit,
    Number(f64),
    Floats(Vec<f64>),
    Words(Vec<u32>),
}
impl From<()> for Input {
    fn from(_: ()) -> Self {
        Self::Unit
    }
}
impl From<u32> for Input {
    fn from(x: u32) -> Self {
        Self::Number(x.into())
    }
}
impl From<i32> for Input {
    fn from(x: i32) -> Self {
        Self::Number(x.into())
    }
}
impl From<usize> for Input {
    fn from(x: usize) -> Self {
        Self::Number(x as f64)
    }
}
impl From<f64> for Input {
    fn from(x: f64) -> Self {
        Self::Number(x)
    }
}
impl From<Vec<f64>> for Input {
    fn from(x: Vec<f64>) -> Self {
        Self::Floats(x)
    }
}
impl From<Vec<u32>> for Input {
    fn from(x: Vec<u32>) -> Self {
        Self::Words(x)
    }
}
impl<const N: usize> From<[f64; N]> for Input {
    fn from(x: [f64; N]) -> Self {
        Self::Floats(x.into())
    }
}
impl From<&[f64]> for Input {
    fn from(x: &[f64]) -> Self {
        Self::Floats(x.into())
    }
}
impl From<&[u32]> for Input {
    fn from(x: &[u32]) -> Self {
        Self::Words(x.into())
    }
}
pub fn near(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "{actual} != {expected} (tolerance {tolerance})"
    );
}
pub fn near_all(actual: &[f64], expected: &[f64], tolerance: f64) {
    assert_eq!(actual.len(), expected.len());
    for (&a, &b) in actual.iter().zip(expected) {
        near(a, b, tolerance);
    }
}
pub fn f32(x: f64) -> f64 {
    (x as f32).into()
}
pub struct Random(pub u32);
impl Random {
    pub fn word(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        self.0
    }
    pub fn unit(&mut self) -> f64 {
        self.word() as f64 / 4294967296.0
    }
}

#[cfg(test)]
mod avoidance;
#[cfg(test)]
mod grid8;
#[cfg(test)]
mod mesh;
#[cfg(test)]
mod navigation;
#[cfg(test)]
mod numeric;

#[cfg(test)]
mod boundaries;
#[cfg(test)]
mod state;

impl From<bool> for Input {
    fn from(x: bool) -> Self {
        Self::Bool(x)
    }
}

#[cfg(test)]
mod choice;
#[cfg(test)]
mod physics;
#[cfg(test)]
mod transform;

#[cfg(test)]
mod terrain;

#[cfg(test)]
mod animation_input;
#[cfg(test)]
mod animation_rig;
#[cfg(test)]
mod ui_reference;

#[cfg(test)]
mod contact_fixtures;

#[cfg(test)]
mod library_edges;
#[cfg(test)]
mod spline;
#[cfg(test)]
mod tween;

#[cfg(test)]
mod algorithm;

#[cfg(test)]
mod timeline;

#[cfg(test)]
mod director;
#[cfg(test)]
mod steering;

#[cfg(test)]
mod geometry;
#[cfg(test)]
mod rig;

#[cfg(test)]
mod scene;

#[cfg(test)]
mod pen;
#[cfg(test)]
mod probes;
mod render_math;

#[cfg(test)]
mod numeric_stress;

#[cfg(test)]
mod game_modules;

#[cfg(test)]
mod shaders;

#[cfg(test)]
mod codec;
pub mod workloads;

pub mod generate;

#[cfg(test)]
mod generation_tests;

pub mod benchmark;
pub mod cli;
pub mod package;

#[cfg(test)]
mod distribution;

#[cfg(test)]
mod simd_batches;

#[cfg(test)]
mod netcode;

#[cfg(test)]
mod mesh_collider;
