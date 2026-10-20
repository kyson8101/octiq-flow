//! Finding room on a plot for something the island places itself: a
//! present an agent gave without saying where, or a 波特's touch in its home.
//!
//! What stands on a plot is seen from above, with the heights it spans. A
//! building is its parts, so a present can go inside a room; a floor or a
//! rug is walked on and is not in the way; a seat's, desk's or bed's spot
//! keeps room for the robot that uses it.
use super::model::*;
use super::rules::{self, Bounds, EPS};

pub type Polygon = Vec<[f64; 2]>;

/// The gap the island leaves round a thing it places itself.
pub const MARGIN: f64 = 0.2;
/// A part whose top is this low is a floor or a rug: walked on, not round.
pub const UNDERFOOT: f64 = 0.1;
/// The room a robot needs at a seat, a desk or a bed's spot.
const ROBOT_ROOM: f64 = 0.5;

/// Something in the way: a shape seen from above, and the heights it spans.
pub struct Obstacle {
    pub shape: Polygon,
    pub low: f64,
    pub high: f64,
}

/// Everything that stands on a plot, as obstacles.
pub fn obstacles(island: &Island, plot: &str) -> Vec<Obstacle> {
    let mut found = Vec::new();
    for placement in island.placed.iter().filter(|p| p.plot == plot) {
        let Some(asset) = island.assets.iter().find(|a| a.id == placement.asset) else {
            continue;
        };
        let at = |point: [f64; 3]| {
            rules::placed_point(point, placement.x, placement.y, placement.z, placement.turn)
        };
        if asset.kind == Kind::Building {
            for part in &asset.parts {
                let corners = rules::corners(part).map(at);
                let (low, high) = corners
                    .iter()
                    .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), c| {
                        (lo.min(c[1]), hi.max(c[1]))
                    });
                if high - placement.y <= UNDERFOOT {
                    continue;
                }
                found.push(Obstacle {
                    shape: rules::hull(corners.iter().map(|c| [c[0], c[2]]).collect()),
                    low,
                    high,
                });
            }
        } else {
            let bounds = rules::asset_bounds(&asset.parts);
            found.push(Obstacle {
                shape: rules::placed_box(&bounds, placement.x, placement.z, placement.turn, 0.0),
                low: placement.y + bounds.min[1],
                high: placement.y + bounds.max[1],
            });
        }
        if let Some(spot) = &asset.spot {
            let [x, _, z] = at(spot.at);
            found.push(box_at(ROBOT_ROOM, x, z));
        }
    }
    found
}

/// A square of room `side` across at `(x, z)`, a robot's height up.
fn box_at(side: f64, x: f64, z: f64) -> Obstacle {
    let room = Bounds {
        min: [-side / 2.0, 0.0, -side / 2.0],
        max: [side / 2.0, 1.0, side / 2.0],
    };
    Obstacle {
        shape: rules::placed_box(&room, x, z, 0.0, 0.0),
        low: 0.0,
        high: 1.0,
    }
}

/// An area to keep clear, given in plot coordinates.
pub fn keep_clear(bounds: &Bounds, x: f64, z: f64) -> Obstacle {
    Obstacle {
        shape: rules::placed_box(bounds, x, z, 0.0, 0.0),
        low: bounds.min[1],
        high: bounds.max[1],
    }
}

/// Where the island looks first: inside the plot's building for furniture,
/// in the front yard for decor.
pub fn first_look(island: &Island, plot: &str, kind: Kind) -> (f64, f64) {
    if kind == Kind::Furniture {
        let building = island.placed.iter().find(|p| {
            p.plot == plot
                && island
                    .assets
                    .iter()
                    .any(|a| a.id == p.asset && a.kind == Kind::Building)
        });
        return building.map(|b| (b.x, b.z)).unwrap_or((0.0, 0.0));
    }
    (0.0, 3.25)
}

/// The free spot nearest `start`, on a half-metre grid over the tile, where
/// a box of `bounds` turned `turn` stays on the tile and keeps `MARGIN` from
/// what is there and from `extra`.
pub fn find_room(
    island: &Island,
    plot: &str,
    bounds: &Bounds,
    turn: f64,
    (sx, sz): (f64, f64),
    extra: &[Obstacle],
) -> Option<(f64, f64)> {
    let (low, high) = (bounds.min[1], bounds.max[1]);
    let mut obstacles = obstacles(island, plot);
    obstacles.extend(extra.iter().map(|o| Obstacle {
        shape: o.shape.clone(),
        low: o.low,
        high: o.high,
    }));
    let mut grid: Vec<(f64, f64)> = (-12..=12)
        .flat_map(|i| (-10..=10).map(move |j| (f64::from(i) * 0.5, f64::from(j) * 0.5)))
        .collect();
    let distance = |(x, z): (f64, f64)| (x - sx).powi(2) + (z - sz).powi(2);
    grid.sort_by(|a, b| {
        distance(*a)
            .total_cmp(&distance(*b))
            .then(a.0.total_cmp(&b.0))
            .then(a.1.total_cmp(&b.1))
    });
    grid.into_iter().find(|&(x, z)| {
        rules::fits_plot(bounds, x, z, turn) && {
            let shape = rules::placed_box(bounds, x, z, turn, MARGIN);
            !obstacles.iter().any(|o| {
                o.low < high - EPS && low < o.high - EPS && rules::overlaps(&shape, &o.shape)
            })
        }
    })
}
