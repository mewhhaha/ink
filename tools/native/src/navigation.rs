use super::*;
fn distances(width: usize, costs: &[f64], goal: usize) -> Vec<f64> {
    let mut distance = vec![f64::INFINITY; costs.len()];
    let mut visited = vec![false; costs.len()];
    distance[goal] = 0.0;
    for _ in 0..costs.len() {
        let Some(cell) = (0..costs.len())
            .filter(|&i| !visited[i])
            .min_by(|&a, &b| distance[a].total_cmp(&distance[b]))
        else {
            break;
        };
        if !distance[cell].is_finite() {
            break;
        }
        visited[cell] = true;
        let mut neighbours = Vec::new();
        if cell % width > 0 {
            neighbours.push(cell - 1)
        }
        if cell % width + 1 < width {
            neighbours.push(cell + 1)
        }
        if cell >= width {
            neighbours.push(cell - width)
        }
        if cell + width < costs.len() {
            neighbours.push(cell + width)
        }
        for other in neighbours {
            if costs[other] > 0.0 {
                distance[other] = distance[other].min(distance[cell] + costs[cell]);
            }
        }
    }
    distance
}
fn path(
    f: &mut Fixture,
    width: usize,
    costs: &[f64],
    start: usize,
    goal: usize,
    limit: usize,
) -> Vec<f64> {
    let mut input = vec![
        width as f64,
        (costs.len() / width) as f64,
        start as f64,
        goal as f64,
        limit as f64,
    ];
    input.extend(costs);
    f.floats("path", input)
}
fn check_path(
    actual: &[f64],
    width: usize,
    costs: &[f64],
    start: usize,
    goal: usize,
    expected: f64,
) {
    if !expected.is_finite() {
        assert_eq!(actual, [-1.0]);
        return;
    }
    near(actual[0], expected, 1e-5);
    let cells = &actual[2..];
    assert_eq!(cells[0], start as f64);
    assert_eq!(cells.last(), Some(&(goal as f64)));
    let mut cost = 0.0;
    for pair in cells.windows(2) {
        let a = pair[0] as usize;
        let b = pair[1] as usize;
        assert_eq!(
            (a % width).abs_diff(b % width) + (a / width).abs_diff(b / width),
            1
        );
        assert!(costs[b] > 0.0);
        cost += costs[b];
    }
    near(cost, expected, 1e-5);
}
#[test]
fn navigation_dijkstra_routes_and_budgets() {
    let mut f = Fixture::new("tests/navigation.blot");
    for seed in 1..=25 {
        let mut random = Random(seed);
        let mut costs: Vec<f64> = (0..117)
            .map(|_| {
                let x = random.word();
                if x % 7 == 0 {
                    0.0
                } else {
                    (x % 8 + 1) as f64 * 0.25
                }
            })
            .collect();
        costs[0] = 1.0;
        costs[116] = 1.0;
        let expected = distances(13, &costs, 116);
        check_path(
            &path(&mut f, 13, &costs, 0, 116, 117),
            13,
            &costs,
            0,
            116,
            expected[0],
        );
    }
    let costs = [1.0, 10.0, 1.0, 1.0, 1.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0];
    let result = f.floats("field", [vec![4.0, 3.0, 3.0], costs.to_vec()].concat());
    let expected = distances(4, &costs, 3);
    for start in 0..costs.len() {
        if costs[start] == 0.0 {
            continue;
        }
        near(result[start], expected[start], 1e-6);
        let mut cell = start;
        for _ in 0..costs.len() {
            if cell == 3 {
                break;
            }
            let next = result[costs.len() + cell] as usize;
            assert!(result[next] < result[cell]);
            near(result[cell], costs[next] + result[next], 1e-6);
            cell = next;
        }
        assert_eq!(cell, 3);
    }
    for (input, expected) in [
        (vec![2.0, 1.0, 0.0, 1.0, 2.0, 1.0, -1.0], vec![-2.0]),
        (vec![2.0, 1.0, 0.0, 1.0, 2.0, 1.0, 0.0], vec![-1.0]),
        (vec![2.0, 1.0, 0.0, 1.0, 0.0, 1.0, 1.0], vec![-1.0]),
        (vec![1.0, 1.0, 0.0, 0.0, 1.0, 1.0], vec![0.0, 1.0, 0.0]),
    ] {
        assert_eq!(f.floats("path", input), expected);
    }
    for size in [32u32, 128, 512] {
        let before = std::time::Instant::now();
        let result = f.floats("large", size);
        assert_eq!(result[0], ((size - 1) * 2) as f64);
        assert_eq!(result[2], (size * 2 - 1) as f64);
        assert!(before.elapsed() < Duration::from_secs(5));
        let before = std::time::Instant::now();
        assert_eq!(f.number("large_flow", size), ((size - 1) * 2) as f64);
        assert!(before.elapsed() < Duration::from_secs(5));
    }
}
#[test]
fn navigation_units_match_general_heap() {
    let file = root().join("lib/navigation.blot");
    let source = std::fs::read_to_string(&file).unwrap();
    let baseline = source.replace(
        "  if g.units:\n    return flow_units g goal",
        "  if #False:\n    return flow_units g goal",
    );
    assert_ne!(
        baseline, source,
        "general flow oracle must actually replace the fast path"
    );
    let module = compiled(
        "tests/navigation.blot",
        &[Overlay {
            path: file.to_string_lossy().into_owned(),
            contents: Some(baseline),
        }],
    );
    let mut reference = Fixture::from_module(&module);
    let mut f = Fixture::new("tests/navigation.blot");
    let mut random = Random(12345);
    for trial in 0..120 {
        let width = 1 + trial % 23;
        let height = 1 + trial % 17;
        let costs: Vec<f64> = (0..width * height)
            .map(|_| {
                let seed = random.word();
                if seed % 7 == 0 {
                    0.0
                } else if trial % 3 == 0 {
                    (seed % 8 + 1) as f64 * 0.25
                } else {
                    1.0
                }
            })
            .collect();
        for goal in [trial % costs.len(), costs.len()] {
            let input = [
                vec![width as f64, height as f64, goal as f64],
                costs.clone(),
            ]
            .concat();
            assert_eq!(
                f.floats("field", input.clone()),
                reference.floats("field", input)
            );
        }
    }
}
#[test]
fn stress_bottlenecks_disconnected_and_expansion_budgets() {
    let mut f = Fixture::new("tests/algorithm-stress.blot");
    for size in [8, 16, 32] {
        for mode in 0..3 {
            let costs: Vec<f64> = (0..size * size)
                .map(|i| {
                    let x = i % size;
                    let y = i / size;
                    if (mode == 1 && x == size / 2 && y != size - 1) || (mode == 2 && y == size / 2)
                    {
                        0.0
                    } else {
                        (i % 5 + 1) as f64 * 0.25
                    }
                })
                .collect();
            let goal = costs.len() - 1;
            let expected = distances(size, &costs, goal);
            let field = f.floats(
                "flow",
                [vec![size as f64, size as f64, goal as f64], costs.clone()].concat(),
            );
            assert_eq!(field.len(), costs.len() * 2);
            for i in 0..costs.len() {
                if !expected[i].is_finite() {
                    assert!(field[i] >= 2.9e38);
                    assert_eq!(field[costs.len() + i], costs.len() as f64);
                } else {
                    near(field[i], expected[i], 1e-5);
                    if i != goal {
                        let next = field[costs.len() + i] as usize;
                        assert!(costs[next] > 0.0 && field[next] < field[i]);
                        near(field[i], field[next] + costs[next], 1e-5);
                    }
                }
            }
            for limit in [0, 1, costs.len()] {
                let actual = path(&mut f, size, &costs, 0, goal, limit);
                if limit < 2 || !expected[0].is_finite() {
                    assert_eq!(actual, [-1.0]);
                } else {
                    check_path(&actual, size, &costs, 0, goal, expected[0]);
                    assert!(actual[1] <= limit as f64);
                }
            }
        }
    }
}
