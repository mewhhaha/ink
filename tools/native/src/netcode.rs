//! Independent references for Ink's netcode: the replication delta codec and
//! the arena game used by the rollback tests. Nothing here shares code with
//! the Squid library; agreement is checked through Pen's guest host.
use super::*;

const PACKET_MAGIC: u32 = 0x5250_4C31;
const NONE: u32 = 0xFFFF_FFFF;

fn mix(value: u32) -> u32 {
    let mut x = value;
    x = (x ^ (x >> 16)).wrapping_mul(0x7FEB_352D);
    x = (x ^ (x >> 15)).wrapping_mul(0x846C_A68B);
    x ^ (x >> 16)
}
fn combine(left: u32, right: u32) -> u32 {
    mix(left ^ mix(right).wrapping_add(0x9E37_79B9))
}
fn xorshift(state: u32) -> u32 {
    let mut x = if state == 0 { 2_654_435_769 } else { state };
    x ^= x << 13;
    x ^= x >> 17;
    x ^ (x << 5)
}
fn seal(words: &[u32]) -> u32 {
    words
        .iter()
        .fold(0x9E37_79B9, |state, w| combine(state, *w))
}

pub fn delta_encode(seq: u32, time: u32, baseline: u32, base: &[u32], current: &[u32]) -> Vec<u32> {
    let lanes = current.len() as u32;
    let mut out = vec![PACKET_MAGIC, 1, lanes, seq, baseline, time];
    if baseline == NONE {
        out.extend_from_slice(current);
    } else {
        let mut mask = vec![0u32; current.len().div_ceil(32)];
        for (lane, (a, b)) in base.iter().zip(current).enumerate() {
            if a != b {
                mask[lane / 32] |= 1 << (lane % 32);
            }
        }
        out.extend_from_slice(&mask);
        out.extend(
            base.iter()
                .zip(current)
                .filter(|(a, b)| a != b)
                .map(|(_, b)| *b),
        );
    }
    out.push(seal(&out));
    out
}

/// Strict decoder: the whole packet is validated before any lane is produced.
pub fn delta_decode(lanes: usize, packet: &[u32], base: &[u32]) -> Option<Vec<u32>> {
    let (&check, body) = packet.split_last()?;
    if packet.len() < 8
        || packet[0] != PACKET_MAGIC
        || packet[1] != 1
        || packet[2] as usize != lanes
    {
        return None;
    }
    if lanes == 0 || seal(body) != check || !f32::from_bits(packet[5]).is_finite() {
        return None;
    }
    let payload = &body[6..];
    if packet[4] == NONE {
        return (payload.len() == lanes).then(|| payload.to_vec());
    }
    let groups = lanes.div_ceil(32);
    if base.len() != lanes || payload.len() < groups {
        return None;
    }
    let (mask, values) = payload.split_at(groups);
    if lanes % 32 != 0 && mask[groups - 1] >> (lanes % 32) != 0 {
        return None;
    }
    if mask.iter().map(|m| m.count_ones() as usize).sum::<usize>() != values.len() {
        return None;
    }
    let mut changed = values.iter();
    Some(
        (0..lanes)
            .map(|lane| {
                if mask[lane / 32] >> (lane % 32) & 1 == 1 {
                    *changed.next().unwrap()
                } else {
                    base[lane]
                }
            })
            .collect(),
    )
}

pub fn sample(seed: u32, player: u32, index: u32, lane: u32) -> u32 {
    let key = combine(combine(seed.wrapping_add(lane), player), index / 3);
    if lane == 0 {
        mix(key) & 31
    } else {
        mix(key.wrapping_add(index))
    }
}

fn step(state: &mut [u32], inputs: &[u32]) {
    let players = (state.len() - 2) / 4;
    let tick = state[0];
    let rng = xorshift(state[1] ^ tick);
    state[1] = rng;
    for player in 0..players {
        let at = 2 + player * 4;
        let buttons = inputs[player * 2];
        let aim = inputs[player * 2 + 1];
        state[at] = (state[at] + (buttons & 1) + 1023 * ((buttons >> 1) & 1)) & 1023;
        state[at + 1] = (state[at + 1] + ((buttons >> 2) & 1) + 1023 * ((buttons >> 3) & 1)) & 1023;
        if (buttons >> 4) & 1 == 1 && state[at + 3] > 0 {
            state[at + 2] = state[at + 2].wrapping_add(combine(rng, aim ^ player as u32) & 255);
            state[at + 3] -= 1;
        }
        if tick % 4 == 3 && state[at + 3] < 8 {
            state[at + 3] += 1;
        }
        for other in 0..player {
            let there = 2 + other * 4;
            if state[at] == state[there] && state[at + 1] == state[there + 1] {
                state[at + 2] = state[at + 2].wrapping_sub(1);
                state[there + 2] = state[there + 2].wrapping_sub(1);
            }
        }
    }
    state[0] = tick + 1;
}

pub fn lockstep(players: u32, frames: u32, delay: u32, seed: u32) -> Vec<u32> {
    let mut state = vec![0u32; 2 + players as usize * 4];
    state[1] = mix(seed.wrapping_add(12345));
    for player in 0..players as usize {
        state[2 + player * 4] = player as u32 * 100;
        state[3 + player * 4] = player as u32 * 37;
        state[5 + player * 4] = 4;
    }
    for frame in 0..frames {
        let mut inputs = vec![0u32; players as usize * 2];
        if frame >= delay {
            for player in 0..players {
                for lane in 0..2 {
                    inputs[(player * 2 + lane) as usize] =
                        sample(seed, player, frame - delay, lane);
                }
            }
        }
        step(&mut state, &inputs);
    }
    state
}

pub fn digest(words: &[u32]) -> u32 {
    words
        .iter()
        .fold(0x811C_9DC5, |state, w| combine(state, *w))
}

fn lanes_from(seed: u32, count: usize) -> Vec<u32> {
    let mut state = seed;
    (0..count)
        .map(|_| {
            state = xorshift(state);
            match state % 8 {
                0 => 0x7FC0_0001,
                1 => 0xFFFF_FFFF,
                2 => 0x8000_0000,
                3 => 0x7F80_0001,
                _ => state,
            }
        })
        .collect()
}

fn encode_args(seq: u32, time: u32, baseline: u32, base: &[u32], current: &[u32]) -> Vec<u32> {
    [
        vec![seq, time, baseline, current.len() as u32],
        base.to_vec(),
        current.to_vec(),
    ]
    .concat()
}
fn decode_args(packet: &[u32], base: &[u32]) -> Vec<u32> {
    let lanes = base.len() as u32;
    [
        vec![lanes, packet.len() as u32],
        packet.to_vec(),
        base.to_vec(),
    ]
    .concat()
}

#[test]
fn delta_packets_match_the_independent_codec_bit_for_bit() {
    let mut f = Fixture::new("tests/netcode.sq");
    for lanes in [1usize, 2, 31, 32, 33, 64, 65, 100] {
        for seed in 1..25u32 {
            let base = lanes_from(seed * 7 + lanes as u32, lanes);
            let mut current = base.clone();
            for (i, word) in lanes_from(seed + 500, lanes).into_iter().enumerate() {
                if (word ^ seed) % 3 == 0 {
                    current[i] = word;
                }
            }
            let time = f32::to_bits(seed as f32 * 0.25);
            for baseline in [3, NONE] {
                let expected = delta_encode(seed, time, baseline, &base, &current);
                let actual = f.words(
                    "delta_encode",
                    encode_args(seed, time, baseline, &base, &current),
                );
                assert_eq!(actual, expected, "lanes {lanes} seed {seed}");
                let decoded = f.words("delta_decode", decode_args(&expected, &base));
                assert_eq!(decoded[0], 1);
                assert_eq!(&decoded[1..], &current[..]);
                assert_eq!(delta_decode(lanes, &expected, &base), Some(current.clone()));
            }
        }
    }
}

#[test]
fn delta_decoders_agree_on_every_truncation_and_corruption() {
    let mut f = Fixture::new("tests/netcode.sq");
    let base = lanes_from(11, 37);
    let mut current = base.clone();
    current[3] ^= 0x8000_0001;
    current[36] = 0x7FC0_0000;
    for baseline in [5, NONE] {
        let packet = delta_encode(2, f32::to_bits(0.5), baseline, &base, &current);
        let mut cases: Vec<Vec<u32>> = (0..packet.len()).map(|n| packet[..n].to_vec()).collect();
        for at in 0..packet.len() {
            for bit in [0, 7, 31] {
                let mut broken = packet.clone();
                broken[at] ^= 1 << bit;
                cases.push(broken);
            }
        }
        cases.push([packet.clone(), vec![0]].concat());
        for case in cases {
            let theirs = delta_decode(base.len(), &case, &base);
            let ours = f.words("delta_decode", decode_args(&case, &base));
            match theirs {
                Some(lanes) => assert_eq!((ours[0], &ours[1..]), (1, &lanes[..])),
                None => {
                    assert_eq!(ours[0], 0, "{case:?}");
                    assert!(ours[1..].iter().all(|w| *w == 0xABCD_EF01));
                }
            }
        }
        assert!(delta_decode(base.len(), &packet, &base).is_some());
    }
}

#[test]
fn the_arena_matches_an_independent_lockstep_reference() {
    let mut f = Fixture::new("tests/netcode.sq");
    for (players, frames, delay, seed) in [
        (2, 90, 2, 7),
        (2, 90, 0, 3),
        (3, 70, 1, 4),
        (3, 70, 3, 9),
        (2, 1, 0, 1),
    ] {
        let expected = lockstep(players, frames, delay, seed);
        assert_eq!(
            f.words("lockstep", vec![players, frames, delay, seed]),
            expected
        );
        println!(
            "lockstep {players} {frames} {delay} {seed} = {:#010x}",
            digest(&expected)
        );
    }
}
