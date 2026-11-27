use super::*;
#[derive(Debug, PartialEq)]
struct Step {
    position: f64,
    returning: bool,
    finished: bool,
    dropped: f64,
    passes: Vec<(f64, f64, bool)>,
    fired: Vec<u32>,
}
fn run(
    f: &mut Fixture,
    duration: f64,
    mode: f64,
    cues: &[f64],
    operations: &[[f64; 2]],
) -> Vec<Option<Step>> {
    let input = [
        vec![duration, mode, cues.len() as f64],
        cues.to_vec(),
        operations.iter().flatten().copied().collect(),
    ]
    .concat();
    let out = f.floats("run", input);
    let mut at = 0;
    let mut steps = Vec::new();
    while at < out.len() {
        let code = out[at];
        at += 1;
        if code == -1.0 {
            steps.push(None);
            break;
        }
        let (position, returning, finished, dropped, count) = (
            out[at],
            out[at + 1] == 1.0,
            out[at + 2] == 1.0,
            out[at + 3],
            out[at + 4] as usize,
        );
        at += 5;
        let mut passes = Vec::new();
        for _ in 0..count {
            passes.push((out[at], out[at + 1], out[at + 2] == 1.0));
            at += 3;
        }
        let count = out[at] as usize;
        at += 1;
        let fired = out[at..at + count].iter().map(|x| *x as u32).collect();
        at += count;
        steps.push(Some(Step {
            position,
            returning,
            finished,
            dropped,
            passes,
            fired,
        }));
    }
    assert_eq!(at, out.len());
    steps
}
fn play(f: &mut Fixture, d: f64, m: f64, c: &[f64], ops: &[[f64; 2]]) -> Vec<Step> {
    run(f, d, m, c, ops)
        .into_iter()
        .map(Option::unwrap)
        .collect()
}
fn fired(steps: &[Step]) -> Vec<Vec<u32>> {
    steps.iter().map(|s| s.fired.clone()).collect()
}
fn advance(s: f64) -> [f64; 2] {
    [0.0, s]
}
fn seek(s: f64) -> [f64; 2] {
    [1.0, s]
}
fn speed(s: f64) -> [f64; 2] {
    [4.0, s]
}
const PAUSE: [f64; 2] = [2.0, 0.0];
const RESUME: [f64; 2] = [3.0, 0.0];
#[test]
fn timeline_tracks_easing_duplicates_discrete_custom_types_and_validation() {
    let mut f = Fixture::new("tests/timeline.sq");
    for (time, value) in [
        (f64::NEG_INFINITY, 10.0),
        (0.5, 10.0),
        (1.0, 10.0),
        (1.5, 15.0),
        (2.0, 20.0),
        (3.0, 10.0),
        (4.0, 50.0),
        (4.9, 50.0),
        (5.0, 55.0),
        (5.99, 55.0),
        (6.0, 60.0),
        (7.99, 60.0),
        (8.0, 80.0),
        (9.0, 80.0),
        (f64::INFINITY, 80.0),
    ] {
        assert_eq!(f.number("level", time), value);
    }
    assert!(f.number("level", f32(3.999)) > 0.0);
    assert_eq!(f.floats("span", 0), [1.0, 8.0]);
    for (time, value) in [
        (-1.0, 1.0),
        (0.999, 1.0),
        (1.0, 2.0),
        (1.9999, 2.0),
        (2.0, 3.0),
        (5.0, 3.0),
    ] {
        assert_eq!(f.number("held", time), value);
    }
    near_all(
        &f.floats("turned", 0.5),
        &[0.0, 0.5f64.sin(), 0.0, 0.5f64.cos()],
        1e-6,
    );
    for (time, want) in [
        (-1.0, [0.0, 0.25]),
        (1.0, [4.0, 1.0]),
        (2.5, [5.0, 1.0]),
        (4.0, [2.0, 0.5]),
    ] {
        assert_eq!(f.floats("gauge", time), want);
    }
    for times in [
        vec![5.0],
        vec![0.0, 0.0, 1.0],
        vec![-1.0, 2.0, 2.0, 2.0, 3.0],
    ] {
        assert_eq!(f.number("keyed", times), 1.0);
    }
    for times in [
        vec![],
        vec![f64::NAN],
        vec![f64::INFINITY],
        vec![1.0, 0.0],
        vec![0.0, 2.0, 1.0],
        vec![-3e38, 3e38],
    ] {
        assert_eq!(f.number("keyed", times), 0.0);
    }
    for times in [vec![], vec![0.0, 0.0], vec![-1.0, 5.0, 5.0]] {
        assert_eq!(f.number("listed", times), 1.0);
    }
    for times in [vec![f64::NAN], vec![1.0, 0.0], vec![0.0, f64::NEG_INFINITY]] {
        assert_eq!(f.number("listed", times), 0.0);
    }
    for duration in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        assert_eq!(f.number("started", duration), 0.0);
    }
    assert_eq!(f.number("started", 1e-6), 1.0);
}
#[test]
fn timeline_loops_reverse_and_ping_pong_fire_cues_once() {
    let mut f = Fixture::new("tests/timeline.sq");
    let s = play(
        &mut f,
        1.0,
        1.0,
        &[0.0, 0.25, 0.5, 0.5, 1.0],
        &[advance(0.3); 4],
    );
    assert_eq!(fired(&s), vec![vec![0, 1], vec![2, 3], vec![], vec![4, 0]]);
    assert_eq!(s[0].passes, [(0.0, f32(0.3), true)]);
    assert_eq!(s[1].passes, [(f32(0.3), f32(0.6), false)]);
    assert_eq!(s[3].passes[1].0, 0.0);
    assert!(s[3].passes[1].2);
    near(s[3].position, 0.2, 1e-6);
    assert!(s.iter().all(|s| s.dropped == 0.0 && !s.finished));
    let s = play(&mut f, 1.0, 1.0, &[0.0, 1.0], &[advance(0.25); 17]);
    assert_eq!(
        s.iter()
            .flat_map(|s| s.fired.iter().copied())
            .collect::<Vec<_>>(),
        [0, 1, 0, 1, 0, 1, 0, 1, 0]
    );
    assert_eq!(s[3].position, 1.0);
    assert_eq!(s[3].passes, [(0.75, 1.0, false)]);
    assert_eq!(s[4].passes, [(0.0, 0.25, true)]);
    let s = play(
        &mut f,
        1.0,
        1.0,
        &[0.0, 0.25, 0.5, 0.5, 1.0],
        &[vec![speed(-1.0)], vec![advance(0.3); 4]].concat(),
    );
    assert_eq!(
        fired(&s),
        vec![vec![], vec![0, 4], vec![3, 2], vec![1], vec![0, 4]]
    );
    assert_eq!(s[1].passes, [(0.0, 0.0, true), (1.0, f32(0.7), true)]);
    assert_eq!(s[2].passes, [(f32(0.7), f32(f32(0.7) - f32(0.3)), false)]);
    near(s[4].position, 0.8, 1e-6);
    let s = play(
        &mut f,
        1.0,
        2.0,
        &[0.0, 0.5, 1.0],
        &[advance(0.75), advance(0.5), advance(1.0), advance(1.0)],
    );
    assert_eq!(fired(&s), vec![vec![0, 1], vec![2], vec![1, 0], vec![1, 2]]);
    assert_eq!(s[1].passes, [(0.75, 1.0, false), (1.0, 0.75, false)]);
    assert_eq!(
        s.iter().map(|s| s.returning).collect::<Vec<_>>(),
        [false, true, false, true]
    );
    assert_eq!(
        s.iter().map(|s| s.position).collect::<Vec<_>>(),
        [0.75, 0.75, 0.25, 0.75]
    );
}
#[test]
fn timeline_once_seek_pause_resume_and_zero_travel() {
    let mut f = Fixture::new("tests/timeline.sq");
    let s = play(
        &mut f,
        1.0,
        0.0,
        &[0.0, 1.0],
        &[
            advance(0.6),
            advance(0.6),
            advance(0.6),
            RESUME,
            advance(0.1),
            seek(0.0),
            RESUME,
            advance(1.5),
        ],
    );
    assert_eq!(
        fired(&s),
        vec![
            vec![0],
            vec![1],
            vec![],
            vec![],
            vec![],
            vec![],
            vec![],
            vec![0, 1]
        ]
    );
    assert_eq!(
        s.iter().map(|s| s.finished).collect::<Vec<_>>(),
        [false, true, false, false, true, false, false, true]
    );
    assert_eq!(s[1].position, 1.0);
    assert!(s[2].passes.is_empty() && s[4].passes.is_empty());
    assert_eq!(s[7].passes, [(0.0, 1.0, true)]);
    let s = play(
        &mut f,
        2.0,
        0.0,
        &[0.0, 1.0, 2.0],
        &[speed(-1.0), seek(2.0), advance(0.5), advance(5.0)],
    );
    assert_eq!(fired(&s), vec![vec![], vec![], vec![2], vec![1, 0]]);
    assert!(s[3].finished);
    assert_eq!(s[3].position, 0.0);
    let s = play(
        &mut f,
        1.0,
        1.0,
        &[0.25, 0.5, 0.75],
        &[
            advance(0.1),
            seek(0.75),
            advance(0.1),
            seek(-3.0),
            seek(0.5),
            PAUSE,
            advance(1.0),
            RESUME,
            advance(0.1),
        ],
    );
    assert_eq!(
        fired(&s),
        vec![
            vec![],
            vec![],
            vec![2],
            vec![],
            vec![],
            vec![],
            vec![],
            vec![],
            vec![1]
        ]
    );
    assert_eq!(s[3].position, 0.0);
    assert_eq!(s[6].position, 0.5);
    assert!(s[6].passes.is_empty());
    assert_eq!(s[8].passes, [(0.5, f32(0.6), true)]);
    let s = play(
        &mut f,
        1.0,
        1.0,
        &[0.0],
        &[advance(0.0), speed(0.0), advance(5.0), speed(1.0)],
    );
    assert!(s.iter().all(|s| s.passes.is_empty()));
    assert_eq!(
        fired(&play(
            &mut f,
            1.0,
            1.0,
            &[0.0],
            &[advance(0.0), advance(0.5)]
        )),
        vec![vec![], vec![0]]
    );
}
#[test]
fn timeline_bounded_long_advances_and_exact_random_cue_order() {
    let mut f = Fixture::new("tests/timeline.sq");
    let s = play(&mut f, 1.0, 1.0, &[0.5], &[advance(1000.25)]);
    let a = &s[0];
    assert_eq!(a.passes.len(), 64);
    assert_eq!(a.dropped, 937.0);
    assert_eq!(a.position, 0.25);
    assert_eq!(a.fired.len(), 63);
    assert_eq!(a.passes[0], (0.0, 1.0, true));
    assert_eq!(a.passes[63], (0.0, 0.25, true));
    let s = play(&mut f, 1.0, 2.0, &[0.5], &[advance(100.5)]);
    let a = &s[0];
    assert_eq!(a.passes.len(), 63);
    assert_eq!(a.dropped, 38.0);
    assert_eq!(a.position, 0.5);
    assert!(!a.returning);
    for p in a.passes.windows(2) {
        assert_eq!(p[1].0, p[0].1);
    }
    let s = play(&mut f, 1.0, 2.0, &[], &[advance(101.5)]);
    assert_eq!((s[0].position, s[0].returning), (0.5, true));
    assert_eq!((s[0].passes.len(), s[0].dropped), (64, 38.0));
    let cues: Vec<f64> = (0..8).map(|k| k as f64 / 8.0).collect();
    let mut seed = 12345u32;
    let mut operations = Vec::new();
    let mut total = 0.0;
    for _ in 0..300 {
        seed = ((seed as f64 * 1103515245.0 + 12345.0) % 4294967296.0) as u32;
        let seconds = (1 + (seed >> 16) % 40) as f64 / 64.0;
        operations.push(advance(seconds));
        total += seconds;
    }
    let s = play(&mut f, 1.0, 1.0, &cues, &operations);
    let order: Vec<u32> = s.iter().flat_map(|s| s.fired.iter().copied()).collect();
    for k in 0..8 {
        let expected = if k == 0 {
            total.ceil()
        } else {
            (total - cues[k]).floor() + 1.0
        };
        assert_eq!(
            order.iter().filter(|&&v| v == k as u32).count(),
            expected as usize
        );
    }
    for (i, &v) in order.iter().enumerate() {
        assert_eq!(v, i as u32 % 8);
    }
    near(
        s.last().unwrap().position,
        if total % 1.0 == 0.0 { 1.0 } else { total % 1.0 },
        1e-6,
    );
    let s = play(&mut f, 1.0, 2.0, &cues, &operations);
    let sweep = [1, 2, 3, 4, 5, 6, 7, 7, 6, 5, 4, 3, 2, 1, 0];
    let values: Vec<u32> = s.iter().flat_map(|s| s.fired.iter().copied()).collect();
    assert_eq!(values[0], 0);
    for (i, &v) in values[1..].iter().enumerate() {
        assert_eq!(v, sweep[i % 15]);
    }
    let crossings = 1 + (1..=(total * 8.0) as usize).filter(|j| j % 16 != 8).count();
    assert_eq!(values.len(), crossings);
}
#[test]
fn timeline_invalid_travel_and_codec_validation() {
    let mut f = Fixture::new("tests/timeline.sq");
    for seconds in [-1.0, f64::NAN, f64::INFINITY] {
        assert_eq!(run(&mut f, 1.0, 1.0, &[], &[advance(seconds)]), vec![None]);
    }
    for op in [speed(f64::NAN), seek(f64::NAN)] {
        assert_eq!(run(&mut f, 1.0, 1.0, &[], &[op]), vec![None]);
    }
    assert_eq!(
        run(&mut f, 1.0, 1.0, &[], &[speed(3e38), advance(10.0)]).last(),
        Some(&None)
    );
    assert_eq!(run(&mut f, 1e-30, 1.0, &[], &[advance(1e10)]), vec![None]);
    let saved = f.floats("saved", 0);
    assert_eq!(saved, [1.25, 2.5, -1.5, 2.0, 0.0, 0.0, 1.0]);
    assert_eq!(f.floats("restored", saved.clone()), saved);
    assert_eq!(f.words("codec_key", 0), [17, 1]);
    for lanes in [
        saved[..6].to_vec(),
        [saved, vec![0.0]].concat(),
        vec![3.0, 2.5, 1.0, 0.0, 1.0, 0.0, 0.0],
        vec![-0.5, 2.5, 1.0, 0.0, 1.0, 0.0, 0.0],
        vec![0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0],
        vec![0.0, 1.0, f64::NAN, 0.0, 1.0, 0.0, 0.0],
        vec![0.0, 1.0, 1.0, 3.0, 1.0, 0.0, 0.0],
        vec![0.0, 1.0, 1.0, 0.5, 1.0, 0.0, 0.0],
        vec![0.0, 1.0, 1.0, 0.0, 2.0, 0.0, 0.0],
    ] {
        f.traps("restored", lanes);
    }
}
