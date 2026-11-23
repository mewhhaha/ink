//! References for eight-neighbour, any-angle and flow-field grid searches:
//! brute-force Dijkstra and exact integer segment-versus-cell intersection.
use super::*;

const MOVES: [(i64, i64); 8] = [
    (-1, 0),
    (1, 0),
    (0, -1),
    (0, 1),
    (-1, -1),
    (1, -1),
    (-1, 1),
    (1, 1),
];

struct Grid {
    w: usize,
    h: usize,
    costs: Vec<f64>,
}
impl Grid {
    fn walkable(&self, x: i64, y: i64) -> bool {
        x >= 0
            && y >= 0
            && (x as usize) < self.w
            && (y as usize) < self.h
            && self.costs[y as usize * self.w + x as usize] > 0.0
    }
    /// Legal moves from a cell with their step lengths (no corner cutting).
    fn moves(&self, cell: usize) -> Vec<(usize, f64)> {
        let (x, y) = ((cell % self.w) as i64, (cell / self.w) as i64);
        MOVES
            .iter()
            .filter_map(|&(dx, dy)| {
                let (nx, ny) = (x + dx, y + dy);
                if !self.walkable(nx, ny) {
                    return None;
                }
                if dx != 0 && dy != 0 && !(self.walkable(nx, y) && self.walkable(x, ny)) {
                    return None;
                }
                Some((
                    ny as usize * self.w + nx as usize,
                    if dx != 0 && dy != 0 { 2f64.sqrt() } else { 1.0 },
                ))
            })
            .collect()
    }
}
fn random_grid(r: &mut Random, w: usize, h: usize, wall: u32, weighted: bool) -> Grid {
    let costs = (0..w * h)
        .map(|_| {
            let x = r.word();
            if x % 100 < wall {
                0.0
            } else if weighted {
                (x / 100 % 4 + 1) as f64 * 0.5
            } else {
                1.0
            }
        })
        .collect();
    Grid { w, h, costs }
}
/// Cheapest cost of entering cells from `from` to every cell (forward Dijkstra).
fn forward(g: &Grid, from: usize) -> Vec<f64> {
    let n = g.costs.len();
    let mut d = vec![f64::INFINITY; n];
    let mut done = vec![false; n];
    d[from] = 0.0;
    for _ in 0..n {
        let Some(c) = (0..n)
            .filter(|&i| !done[i] && d[i].is_finite())
            .min_by(|&a, &b| d[a].total_cmp(&d[b]))
        else {
            break;
        };
        done[c] = true;
        for (next, len) in g.moves(c) {
            d[next] = d[next].min(d[c] + len * g.costs[next]);
        }
    }
    d
}
/// Cheapest cost from every cell to any goal (backward Dijkstra on reversed moves).
fn backward(g: &Grid, goals: &[usize]) -> Vec<f64> {
    let n = g.costs.len();
    let mut d = vec![f64::INFINITY; n];
    let mut done = vec![false; n];
    for &goal in goals {
        if g.costs[goal] > 0.0 {
            d[goal] = 0.0;
        }
    }
    for _ in 0..n {
        let Some(c) = (0..n)
            .filter(|&i| !done[i] && d[i].is_finite())
            .min_by(|&a, &b| d[a].total_cmp(&d[b]))
        else {
            break;
        };
        done[c] = true;
        // Moves are symmetric, so the cells that move into c are its moves.
        for (from, len) in g.moves(c) {
            d[from] = d[from].min(d[c] + len * g.costs[c]);
        }
    }
    d
}
/// Exact test of whether the segment between two cell centres meets the closed
/// square of cell (cx, cy): integer coordinates doubled so centres are odd.
fn touches(a: (i64, i64), b: (i64, i64), cx: i64, cy: i64) -> bool {
    let (lo_x, hi_x, lo_y, hi_y) = (2 * cx, 2 * cx + 2, 2 * cy, 2 * cy + 2);
    if a.0.max(b.0) < lo_x || a.0.min(b.0) > hi_x || a.1.max(b.1) < lo_y || a.1.min(b.1) > hi_y {
        return false;
    }
    let side = |x: i64, y: i64| (b.0 - a.0) * (y - a.1) - (b.1 - a.1) * (x - a.0);
    let signs: Vec<i64> = [(lo_x, lo_y), (hi_x, lo_y), (lo_x, hi_y), (hi_x, hi_y)]
        .iter()
        .map(|&(x, y)| side(x, y).signum())
        .collect();
    !(signs.iter().all(|&s| s > 0) || signs.iter().all(|&s| s < 0))
}
fn sees(g: &Grid, a: usize, b: usize) -> bool {
    let pa = (2 * (a % g.w) as i64 + 1, 2 * (a / g.w) as i64 + 1);
    let pb = (2 * (b % g.w) as i64 + 1, 2 * (b / g.w) as i64 + 1);
    (0..g.h as i64).all(|y| (0..g.w as i64).all(|x| !touches(pa, pb, x, y) || g.walkable(x, y)))
}
fn search(
    f: &mut Fixture,
    g: &Grid,
    start: usize,
    goal: usize,
    limit: usize,
    mode: f64,
) -> Vec<f64> {
    let mut input = vec![
        g.w as f64,
        g.h as f64,
        start as f64,
        goal as f64,
        limit as f64,
        mode,
    ];
    input.extend(&g.costs);
    f.floats("search", input)
}
fn euclid(g: &Grid, a: usize, b: usize) -> f64 {
    (((a % g.w) as f64 - (b % g.w) as f64).powi(2) + ((a / g.w) as f64 - (b / g.w) as f64).powi(2))
        .sqrt()
}

#[test]
fn eight_neighbour_search_matches_dijkstra_without_corner_cutting() {
    let mut f = Fixture::new("tests/navigation_grid8.blot");
    let mut reached = 0;
    for seed in 1..=60u32 {
        let mut r = Random(seed);
        let (w, h) = (4 + seed as usize % 9, 3 + seed as usize % 8);
        let g = random_grid(&mut r, w, h, 25, seed % 2 == 0);
        let open: Vec<usize> = (0..w * h).filter(|&i| g.costs[i] > 0.0).collect();
        for _ in 0..5 {
            let (s, t) = (
                open[r.word() as usize % open.len()],
                open[r.word() as usize % open.len()],
            );
            let want = forward(&g, s)[t];
            let out = search(&mut f, &g, s, t, w * h, 0.0);
            if !want.is_finite() {
                assert_eq!(out[0], 1.0);
                continue;
            }
            reached += 1;
            assert_eq!(out[0], 0.0);
            near(out[1], want, 1e-4 * want.max(1.0));
            let cells: Vec<usize> = out[4..].iter().map(|&c| c as usize).collect();
            assert_eq!((cells[0], *cells.last().unwrap()), (s, t));
            // Every step is a legal move and the steps add up to the cost.
            let mut sum = 0.0;
            for pair in cells.windows(2) {
                let (_, len) = *g
                    .moves(pair[0])
                    .iter()
                    .find(|m| m.0 == pair[1])
                    .expect("illegal step");
                sum += len * g.costs[pair[1]];
            }
            near(sum, want, 1e-4 * want.max(1.0));
        }
    }
    assert!(reached > 100);
    // A diagonal squeeze between two walls never cuts the corner.
    let squeeze = Grid {
        w: 2,
        h: 2,
        costs: vec![1.0, 0.0, 0.0, 1.0],
    };
    assert_eq!(search(&mut f, &squeeze, 0, 3, 4, 0.0)[0], 1.0);
    assert_eq!(search(&mut f, &squeeze, 0, 3, 4, 1.0)[0], 1.0);
    let open = Grid {
        w: 2,
        h: 2,
        costs: vec![1.0; 4],
    };
    near(search(&mut f, &open, 0, 3, 4, 0.0)[1], 2f64.sqrt(), 1e-6);
}
#[test]
fn theta_star_paths_see_every_segment_and_beat_the_grid_path() {
    let mut f = Fixture::new("tests/navigation_grid8.blot");
    let (mut shorter, mut checked) = (0, 0);
    for seed in 1..=60u32 {
        let mut r = Random(seed + 500);
        let (w, h) = (6 + seed as usize % 12, 5 + seed as usize % 9);
        let g = random_grid(&mut r, w, h, 22, false);
        let open: Vec<usize> = (0..w * h).filter(|&i| g.costs[i] > 0.0).collect();
        for _ in 0..4 {
            let (s, t) = (
                open[r.word() as usize % open.len()],
                open[r.word() as usize % open.len()],
            );
            let grid_path = search(&mut f, &g, s, t, w * h, 0.0);
            let any = search(&mut f, &g, s, t, w * h, 1.0);
            assert_eq!(grid_path[0], any[0], "reachability agrees");
            if grid_path[0] != 0.0 {
                continue;
            }
            checked += 1;
            let cells: Vec<usize> = any[4..].iter().map(|&c| c as usize).collect();
            assert_eq!((cells[0], *cells.last().unwrap()), (s, t));
            let mut length = 0.0;
            for pair in cells.windows(2) {
                assert!(sees(&g, pair[0], pair[1]), "seed {seed}: no line of sight");
                length += euclid(&g, pair[0], pair[1]);
            }
            near(any[1], length, 1e-4 * length.max(1.0));
            assert!(
                any[1] <= grid_path[1] + 1e-4,
                "seed {seed}: {} > {}",
                any[1],
                grid_path[1]
            );
            // The true any-angle shortest path cannot beat the straight line.
            assert!(any[1] >= euclid(&g, s, t) - 1e-5);
            shorter += (any[1] < grid_path[1] - 1e-3) as u32;
        }
    }
    assert!(checked > 100 && shorter > 20, "{checked} {shorter}");
}
#[test]
fn line_of_sight_matches_exact_segment_cell_intersection() {
    let mut f = Fixture::new("tests/navigation_grid8.blot");
    for seed in 1..=30u32 {
        let mut r = Random(seed + 900);
        let (w, h) = (4 + seed as usize % 9, 4 + seed as usize % 7);
        let g = random_grid(&mut r, w, h, 20, false);
        let open: Vec<usize> = (0..w * h).filter(|&i| g.costs[i] > 0.0).collect();
        let queries: Vec<(usize, usize)> = (0..80)
            .map(|_| {
                (
                    open[r.word() as usize % open.len()],
                    open[r.word() as usize % open.len()],
                )
            })
            .collect();
        let mut input = vec![w as f64, h as f64, queries.len() as f64];
        input.extend(&g.costs);
        for &(a, b) in &queries {
            input.extend([
                (a % w) as f64,
                (a / w) as f64,
                (b % w) as f64,
                (b / w) as f64,
            ]);
        }
        let out = f.floats("sight", input);
        for (k, &(a, b)) in queries.iter().enumerate() {
            assert_eq!(out[k] == 1.0, sees(&g, a, b), "seed {seed} {a}->{b}");
        }
    }
}
#[test]
fn grid_search_adversarial_inputs() {
    let mut f = Fixture::new("tests/navigation_grid8.blot");
    let g = Grid {
        w: 5,
        h: 1,
        costs: vec![1.0; 5],
    };
    for mode in [0.0, 1.0] {
        let out = search(&mut f, &g, 2, 2, 5, mode);
        assert_eq!((out[0], out[1], out[3], out[4]), (0.0, 0.0, 1.0, 2.0));
        assert_eq!(
            search(&mut f, &g, 0, 4, 2, mode)[0],
            2.0,
            "budget exhausted"
        );
        assert_eq!(search(&mut f, &g, 0, 4, 0, mode)[0], 2.0, "zero budget");
        assert_eq!(
            search(&mut f, &g, 0, 9, 5, mode)[0],
            3.0,
            "goal out of range"
        );
        assert_eq!(
            search(&mut f, &g, 9, 0, 5, mode)[0],
            3.0,
            "start out of range"
        );
        near(search(&mut f, &g, 0, 4, 5, mode)[1], 4.0, 1e-6);
    }
    // Walls at start/goal, a sealed goal, a single cell, NaN costs.
    let mut walled = Grid {
        w: 3,
        h: 3,
        costs: vec![1.0; 9],
    };
    walled.costs[4] = 0.0;
    assert_eq!(search(&mut f, &walled, 4, 0, 9, 0.0)[0], 3.0);
    assert_eq!(search(&mut f, &walled, 0, 4, 9, 1.0)[0], 3.0);
    let sealed = Grid {
        w: 3,
        h: 3,
        costs: vec![1.0, 1.0, 1.0, 1.0, 1.0, 0.0, 1.0, 0.0, 0.0],
    };
    for mode in [0.0, 1.0] {
        assert_eq!(search(&mut f, &sealed, 0, 8, 9, mode)[0], 3.0);
        assert_eq!(search(&mut f, &sealed, 0, 4, 9, mode)[0], 0.0);
    }
    let split = Grid {
        w: 3,
        h: 1,
        costs: vec![1.0, 0.0, 1.0],
    };
    assert_eq!(search(&mut f, &split, 0, 2, 9, 0.0)[0], 1.0);
    let one = Grid {
        w: 1,
        h: 1,
        costs: vec![2.0],
    };
    assert_eq!(search(&mut f, &one, 0, 0, 1, 1.0)[..2], [0.0, 0.0]);
    let bad = Grid {
        w: 2,
        h: 1,
        costs: vec![1.0, f64::NAN],
    };
    assert_eq!(search(&mut f, &bad, 0, 1, 1, 0.0), vec![-1.0]);
}
fn field(f: &mut Fixture, g: &Grid, goals: &[usize], budget: usize) -> (bool, Vec<f64>, Vec<f64>) {
    let mut input = vec![g.w as f64, g.h as f64, budget as f64, goals.len() as f64];
    input.extend(goals.iter().map(|&x| x as f64));
    input.extend(&g.costs);
    let out = f.floats("field", input);
    let n = g.costs.len();
    (out[0] == 1.0, out[1..1 + n].to_vec(), out[1 + n..].to_vec())
}
#[test]
fn flow_fields_match_dijkstra_and_directions_descend() {
    let mut f = Fixture::new("tests/navigation_grid8.blot");
    for seed in 1..=40u32 {
        let mut r = Random(seed + 77);
        let (w, h) = (3 + seed as usize % 12, 3 + seed as usize % 9);
        let g = random_grid(&mut r, w, h, 25, seed % 3 != 0);
        let n = w * h;
        let goals: Vec<usize> = (0..1 + seed as usize % 4)
            .map(|_| r.word() as usize % n)
            .collect();
        let want = backward(&g, &goals);
        // Budgets of one expansion and a full run give the same final field.
        let (done_small, small, small_dirs) = field(&mut f, &g, &goals, 1);
        let (done_all, all, dirs) = field(&mut f, &g, &goals, usize::MAX >> 33);
        assert!(done_all || goals.iter().all(|&c| g.costs[c] == 0.0));
        assert!(
            !done_small
                || n <= 2
                || goals.iter().all(|&c| g.costs[c] == 0.0)
                || want.iter().filter(|d| d.is_finite()).count() <= 1
        );
        assert_eq!(small, all);
        assert_eq!(small_dirs, dirs);
        for c in 0..n {
            if want[c].is_finite() {
                near(all[c], want[c], 1e-4 * want[c].max(1.0));
            } else {
                assert_eq!(all[c], 3e38f32 as f64);
            }
            let (dx, dy) = (dirs[2 * c], dirs[2 * c + 1]);
            if !want[c].is_finite() || want[c] == 0.0 {
                assert_eq!((dx, dy), (0.0, 0.0));
                continue;
            }
            // Unit direction; stepping along it reaches a neighbour whose cost
            // plus the step equals this cell's cost.
            near((dx * dx + dy * dy).sqrt(), 1.0, 1e-6);
            let (x, y) = ((c % w) as i64, (c / w) as i64);
            let step = (
                dx.signum() as i64 * (dx != 0.0) as i64,
                dy.signum() as i64 * (dy != 0.0) as i64,
            );
            let next = ((y + step.1) as usize) * w + (x + step.0) as usize;
            let len = if step.0 != 0 && step.1 != 0 {
                2f64.sqrt()
            } else {
                1.0
            };
            assert!(g.moves(c).iter().any(|m| m.0 == next), "illegal direction");
            near(
                len * g.costs[next] + want[next],
                want[c],
                1e-4 * want[c].max(1.0),
            );
        }
    }
    // No goals, wall goals and duplicate goals.
    let g = Grid {
        w: 3,
        h: 1,
        costs: vec![1.0, 0.0, 1.0],
    };
    let (done, costs, dirs) = field(&mut f, &g, &[], 10);
    assert!(done && costs.iter().all(|&c| c == 3e38f32 as f64) && dirs.iter().all(|&d| d == 0.0));
    let (_, costs, _) = field(&mut f, &g, &[1, 7], 10);
    assert!(costs.iter().all(|&c| c == 3e38f32 as f64));
    let (_, costs, _) = field(&mut f, &g, &[2, 2, 2], 10);
    assert_eq!(costs[2], 0.0);
}
