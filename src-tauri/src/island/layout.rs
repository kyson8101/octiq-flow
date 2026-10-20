//! Where plots go: a honeycomb of hexagonal cells round the plaza.
//!
//! Cells are pointed along ±z in the world, `CELL` metres from centre to
//! corner. Cell `(q, r)` (axial coordinates) has its centre at
//! `x = 7·√3·(q + r/2)`, `z = 7·1.5·r`; the centre cell is the plaza, where
//! nothing is placed. Ring `k` is the `6k` cells `k` steps out, walked from
//! `(-k, k)` along each of the six directions in turn. A plot is a smaller
//! hexagon (`TILE`) on its cell, whose front is the flat edge nearest the
//! plaza.
use super::model::{OwnerKind, Plot};
use super::rules::mm;

/// A cell's centre-to-corner, in metres.
pub const CELL: f64 = 7.0;
/// A plot's tile, centre-to-corner. What is left of the cell round it is
/// the path between tiles.
pub const TILE: f64 = 6.3;

/// The six directions, in `(q, r)`, in the order a ring is walked.
pub const DIRS: [(i32, i32); 6] = [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)];

/// The playground's cell (ring 1, slot 5): a slide, a seesaw and swings the
/// page draws. Like the plaza it is the island's own, never a plot.
pub const PLAYGROUND: (i32, i32) = (-1, 0);

/// The most rings a plot is looked for in. Ring 24 is three hundred metres
/// out and holds 144 plots: an island never gets there.
const RINGS_MAX: u32 = 24;

/// Slack for a corner on the tile's edge: every number is kept to the
/// millimetre, and the tile's edges are not.
const ON_TILE_SLACK: f64 = 5e-4;

pub fn cells_in(ring: u32) -> u32 {
    6 * ring
}

/// Slot `slot` of ring `ring`: the walk starts at `(-k, k)` (the plaza plus
/// direction 4 taken `k` times) and takes `k` steps along each direction in
/// turn; the slot is the cell it is on after `slot` steps.
pub fn cell(ring: u32, slot: u32) -> (i32, i32) {
    let k = ring as i32;
    let (mut q, mut r) = (-k, k);
    let mut steps = slot as i32;
    for (dq, dr) in DIRS {
        for _ in 0..k {
            if steps == 0 {
                return (q, r);
            }
            q += dq;
            r += dr;
            steps -= 1;
        }
    }
    (q, r)
}

/// A cell's centre in world metres.
pub fn centre(q: i32, r: i32) -> (f64, f64) {
    let (q, r) = (f64::from(q), f64::from(r));
    (CELL * 3f64.sqrt() * (q + r / 2.0), CELL * 1.5 * r)
}

/// The yaw, in degrees, of a plot's `+z` front at `(x, z)`: the direction to
/// the plaza snapped to the nearest of the six edge directions (multiples of
/// 60° from +x towards +z), as three.js would turn a group to face it,
/// `atan2(dx, dz)`. A cell exactly between two edges takes the one further
/// round from +x towards +z (halves round up, as `Math.round` does), whatever
/// the last bit of the angle says.
pub fn facing(x: f64, z: f64) -> f64 {
    let exact = (-z).atan2(-x).to_degrees();
    let snapped = ((exact / 60.0 + 0.5 + 1e-9).floor() * 60.0).to_radians();
    let (dx, dz) = (snapped.cos(), snapped.sin());
    let mut yaw = mm(dx.atan2(dz).to_degrees());
    // A half turn either way is one direction; one spelling of it.
    if yaw <= -180.0 {
        yaw += 360.0;
    }
    yaw
}

/// A plot's cell, centre and facing for `(ring, slot)`.
pub fn place(ring: u32, slot: u32) -> (i32, i32, f64, f64, f64) {
    let (q, r) = cell(ring, slot);
    let (x, z) = centre(q, r);
    (q, r, mm(x), mm(z), facing(x, z))
}

/// The tile's flat front and back, `z = ±6.3·√3/2`.
pub fn tile_half_depth() -> f64 {
    TILE * 3f64.sqrt() / 2.0
}

/// Whether a point in plot coordinates is on the tile: `|z| ≤ 5.456` and
/// `|x| + |z|/√3 ≤ 6.3`.
pub fn on_tile(x: f64, z: f64) -> bool {
    z.abs() <= tile_half_depth() + ON_TILE_SLACK
        && x.abs() + z.abs() / 3f64.sqrt() <= TILE + ON_TILE_SLACK
}

/// The rings an owner looks in, in order. An agent takes the lowest free
/// ring and slot from ring 1. A 波特 home starts on ring 2 and uses ring 1
/// only once rings 2 and 3 are full, so the cells by the plaza stay the
/// agents'.
pub fn rings_for(kind: OwnerKind) -> Vec<u32> {
    match kind {
        OwnerKind::Agent => (1..RINGS_MAX).collect(),
        OwnerKind::Bot | OwnerKind::Home => [2, 3, 1].into_iter().chain(4..RINGS_MAX).collect(),
    }
}

/// The first free `(ring, slot)` for an owner of this kind. The
/// playground's cell is never free.
pub fn free_slot(plots: &[Plot], kind: OwnerKind) -> Option<(u32, u32)> {
    rings_for(kind).into_iter().find_map(|ring| {
        (0..cells_in(ring))
            .filter(|slot| cell(ring, *slot) != PLAYGROUND)
            .find(|slot| !plots.iter().any(|p| p.ring == ring && p.slot == *slot))
            .map(|slot| (ring, slot))
    })
}

/// The land's radius: `7·√3·K + 13`, `K` the outermost ring in use, and
/// never under 30.
pub fn radius(plots: &[Plot]) -> f64 {
    let outermost = plots.iter().map(|plot| plot.ring).max().unwrap_or(0);
    mm(CELL * 3f64.sqrt() * f64::from(outermost) + 13.0).max(30.0)
}

/// splitmix64: small, fast and good enough to pick a name or a colour. The
/// island's randomness is drawn from its seed, its revision and the clock, so
/// a test that fixes those gets the same island every time.
pub struct Rng(u64);

impl Rng {
    #[cfg(test)]
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    /// The generator for one change: the island's seed, the revision it is
    /// made on, the moment it is made, and what it is for.
    pub fn for_change(seed: u64, rev: u64, now: i64, salt: u64) -> Self {
        let mut mixer = Self(seed ^ rev.rotate_left(29) ^ (now as u64).rotate_left(47) ^ salt);
        Self(mixer.next())
    }

    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// A number in `[0, 1)`.
    pub fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// A number in `0..n`, `n > 0`.
    pub fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }

    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }

    pub fn shuffle<T>(&mut self, items: &mut [T]) {
        for i in (1..items.len()).rev() {
            let j = self.below(i + 1);
            items.swap(i, j);
        }
    }
}

/// A short id with its kind in front, `p_3f9c0d12ab`, that nothing on the
/// island has yet.
pub fn new_id(prefix: &str, rng: &mut Rng, taken: &dyn Fn(&str) -> bool) -> String {
    loop {
        let id = format!("{prefix}_{:010x}", rng.next() & 0xff_ffff_ffff);
        if !taken(&id) {
            return id;
        }
    }
}

/// A word's own number, the same in every run: an agent's trait and its
/// workshop's colours are chosen by it.
pub fn stable_hash(text: &str) -> u64 {
    // FNV-1a.
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::island::model::Owner;
    use std::collections::BTreeSet;

    /// How many steps a cell is from the plaza.
    fn distance(q: i32, r: i32) -> i32 {
        (q.abs() + r.abs() + (q + r).abs()) / 2
    }

    fn plot(ring: u32, slot: u32) -> Plot {
        let (q, r, x, z, facing) = place(ring, slot);
        Plot {
            id: format!("p_{ring}_{slot}"),
            owner: Owner::bot("b"),
            members: Vec::new(),
            ring,
            slot,
            q,
            r,
            x,
            z,
            facing,
            radius: TILE,
            claimed_at: 0,
        }
    }

    #[test]
    fn ring_k_is_6k_distinct_cells_k_steps_from_the_plaza() {
        let mut every = BTreeSet::new();
        for ring in 1..=6 {
            assert_eq!(cells_in(ring), 6 * ring);
            let cells: Vec<(i32, i32)> = (0..cells_in(ring)).map(|s| cell(ring, s)).collect();
            assert_eq!(
                cells[0],
                (-(ring as i32), ring as i32),
                "the walk starts at (-k, k)"
            );
            let distinct: BTreeSet<_> = cells.iter().copied().collect();
            assert_eq!(distinct.len(), cells.len(), "ring {ring} has a cell twice");
            for (q, r) in &cells {
                assert_eq!(distance(*q, *r), ring as i32, "({q}, {r}) in ring {ring}");
            }
            // Each step of the walk is to a neighbour.
            for pair in cells.windows(2) {
                let (dq, dr) = (pair[1].0 - pair[0].0, pair[1].1 - pair[0].1);
                assert!(DIRS.contains(&(dq, dr)), "{pair:?}");
            }
            every.extend(cells);
        }
        assert!(!every.contains(&(0, 0)), "nothing is placed on the plaza");
        // Ring 1 in order: the walk's first step is along direction 0.
        assert_eq!(
            (0..6).map(|s| cell(1, s)).collect::<Vec<_>>(),
            vec![(-1, 1), (0, 1), (1, 0), (1, -1), (0, -1), (-1, 0)]
        );
    }

    #[test]
    fn neighbours_are_seven_root_three_apart() {
        let (x, z) = centre(0, 0);
        assert_eq!((x, z), (0.0, 0.0));
        for (q, r) in DIRS {
            let (x, z) = centre(q, r);
            assert!(((x * x + z * z).sqrt() - 7.0 * 3f64.sqrt()).abs() < 1e-9);
        }
        assert_eq!(centre(0, 1), (7.0 * 3f64.sqrt() / 2.0, 10.5));
    }

    #[test]
    fn a_plot_turns_a_flat_edge_to_the_plaza() {
        for ring in 1..=5 {
            for slot in 0..cells_in(ring) {
                let (q, r, _, _, yaw) = place(ring, slot);
                // The cell's own centre, not the one kept to the millimetre:
                // a cell between two edges is exactly 30° off either.
                let (x, z) = centre(q, r);
                assert!(yaw > -180.0 && yaw <= 180.0);
                // The plot's +z, turned as three.js turns a group.
                let (fx, fz) = (yaw.to_radians().sin(), yaw.to_radians().cos());
                // It is one of the six edge directions...
                let edge = fz.atan2(fx).to_degrees();
                assert!(
                    ((edge / 60.0).round() * 60.0 - edge).abs() < 1e-3,
                    "{ring}/{slot}: {edge}"
                );
                // ...and the one nearest the plaza: within 30° of it.
                let (px, pz) = (-x, -z);
                let cos = (fx * px + fz * pz) / (px * px + pz * pz).sqrt();
                assert!(cos >= (30f64).to_radians().cos() - 1e-6, "{ring}/{slot}");
                if ring == 1 {
                    // A neighbour of the plaza faces it exactly.
                    assert!((cos - 1.0).abs() < 1e-6, "{slot}: {cos}");
                }
            }
        }
        // Slot 0 of ring 1 is up and to the left of the plaza.
        let (q, r, x, z, yaw) = place(1, 0);
        assert_eq!((q, r), (-1, 1));
        assert_eq!((x, z), (mm(-7.0 * 3f64.sqrt() / 2.0), 10.5));
        assert_eq!(yaw, 150.0);
    }

    #[test]
    fn the_tile_is_flat_front_and_back_and_pointed_at_the_sides() {
        assert!((tile_half_depth() - 5.456).abs() < 5e-4);
        assert!(on_tile(0.0, 5.456) && on_tile(0.0, -5.456));
        assert!(!on_tile(0.0, 5.46));
        assert!(on_tile(6.3, 0.0) && on_tile(-6.3, 0.0));
        assert!(!on_tile(6.31, 0.0));
        // The corner of the front edge, and just past the slanted side.
        assert!(on_tile(3.15, 5.456));
        assert!(on_tile(3.4, 5.0) && !on_tile(3.5, 5.0));
    }

    #[test]
    fn agents_take_the_lowest_slot_from_ring_one_and_bots_start_on_ring_two() {
        let mut plots = Vec::new();
        assert_eq!(free_slot(&plots, OwnerKind::Agent), Some((1, 0)));
        assert_eq!(free_slot(&plots, OwnerKind::Bot), Some((2, 0)));
        plots.push(plot(1, 0));
        assert_eq!(free_slot(&plots, OwnerKind::Agent), Some((1, 1)));
        // Rings 2 and 3 full: only then does a bot come in to ring 1.
        for ring in 2..=3 {
            for slot in 0..cells_in(ring) {
                plots.push(plot(ring, slot));
            }
        }
        assert_eq!(free_slot(&plots, OwnerKind::Bot), Some((1, 1)));
        for slot in 1..5 {
            plots.push(plot(1, slot));
        }
        // Ring 1 holds five plots: its sixth cell is the playground.
        assert_eq!(free_slot(&plots, OwnerKind::Bot), Some((4, 0)));
        assert_eq!(free_slot(&plots, OwnerKind::Agent), Some((4, 0)));
    }

    #[test]
    fn the_playground_is_never_a_plot() {
        assert_eq!(cell(1, 5), PLAYGROUND);
        // Agents take ring 1's five plots, then ring 2.
        let mut plots = Vec::new();
        for want in [(1, 0), (1, 1), (1, 2), (1, 3), (1, 4), (2, 0), (2, 1)] {
            let (ring, slot) = free_slot(&plots, OwnerKind::Agent).unwrap();
            assert_eq!((ring, slot), want);
            plots.push(plot(ring, slot));
        }
        // With every other cell of rings 1 to 3 taken, a bot still never
        // gets the playground, and neither does an agent.
        let mut full = Vec::new();
        for ring in 1..=3 {
            for slot in 0..cells_in(ring) {
                if cell(ring, slot) != PLAYGROUND {
                    full.push(plot(ring, slot));
                }
            }
        }
        for kind in [OwnerKind::Agent, OwnerKind::Bot] {
            let (ring, slot) = free_slot(&full, kind).unwrap();
            assert_eq!(ring, 4, "{kind:?}");
            assert_ne!(cell(ring, slot), PLAYGROUND);
        }
        // Nor in any long run of claims.
        let mut claimed = Vec::new();
        for at in 0..60 {
            let kind = if at % 3 == 0 {
                OwnerKind::Bot
            } else {
                OwnerKind::Agent
            };
            let (ring, slot) = free_slot(&claimed, kind).unwrap();
            assert_ne!(cell(ring, slot), PLAYGROUND);
            assert_ne!(cell(ring, slot), (0, 0));
            claimed.push(plot(ring, slot));
        }
    }

    #[test]
    fn the_land_reaches_past_the_outermost_ring_and_never_under_thirty() {
        assert_eq!(radius(&[]), 30.0);
        assert_eq!(radius(&[plot(1, 0)]), 30.0);
        assert_eq!(
            radius(&[plot(1, 0), plot(2, 3)]),
            mm(14.0 * 3f64.sqrt() + 13.0)
        );
        assert_eq!(radius(&[plot(3, 1)]), mm(21.0 * 3f64.sqrt() + 13.0));
    }

    #[test]
    fn the_generator_is_the_same_for_the_same_seed() {
        let draw = |seed| {
            let mut rng = Rng::for_change(seed, 4, 1_000, 7);
            [rng.next(), rng.next(), rng.next()]
        };
        assert_eq!(draw(12), draw(12));
        assert_ne!(draw(12), draw(13));
        let mut rng = Rng::new(3);
        for _ in 0..1000 {
            let u = rng.unit();
            assert!((0.0..1.0).contains(&u));
            assert!(rng.below(5) < 5);
        }
    }
}
