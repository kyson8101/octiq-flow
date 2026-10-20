//! What a 波特 home is made of. 波特 live together, up to four to a home,
//! and build it together: a roofless house in a style the founder chose, a
//! bed for each member along the back wall, and one touch of each member's
//! own (a gardener's flower box by the door, a tinkerer's workbench).
//!
//! Every piece is written as an agent would write it and goes through the
//! same checks (`rules::check_asset`); the tests hold every style with one
//! to four members to them, on the tile, with the beds inside the walls.
//! Who moves in and out, and when the house is rebuilt, is `homes.rs`.
use serde_json::{json, Value};

use super::layout::{stable_hash, Rng};
use super::model::{Look, Trait};
use super::rules::Bounds;
use super::starter::mix;

/// Where a home's house stands on its plot.
pub const HOUSE_AT: (f64, f64) = (0.0, -0.8);

/// The walls every house is built with: high enough to be walls for a
/// robot, low enough to watch over, and a doorway robots fit through.
const WALL_HIGH: f64 = 1.7;
const WALL_THICK: f64 = 0.15;
const DOOR_WIDE: f64 = 1.2;
const DOOR_HIGH: f64 = 1.45;

const FLOOR_WOOD: &str = "#d9b48f";
const WOOD: &str = "#c8956b";
const CREAM: &str = "#fdf8ef";
const LEAF: &str = "#6a994e";
const STEEL: &str = "#c0c7d1";

/// The shapes a house is built in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Style {
    Cottage,
    Round,
    Corner,
    Garden,
}

impl Style {
    pub const ALL: [Style; 4] = [Style::Cottage, Style::Round, Style::Corner, Style::Garden];

    /// The house's name, which is how a rebuild knows its style.
    pub fn called(self) -> &'static str {
        match self {
            Style::Cottage => "Cottage",
            Style::Round => "Round house",
            Style::Corner => "Corner house",
            Style::Garden => "Garden house",
        }
    }

    pub fn from_name(name: &str) -> Option<Style> {
        Style::ALL.into_iter().find(|style| style.called() == name)
    }
}

/// The styles a founder's trait leans towards.
fn leaning(character: Trait) -> &'static [Style] {
    match character {
        Trait::Cozy => &[Style::Cottage],
        Trait::Gardener => &[Style::Garden],
        Trait::Dreamy => &[Style::Round],
        Trait::Artsy => &[Style::Round, Style::Corner],
        Trait::Curious => &[Style::Corner],
        Trait::Tinkerer => &[Style::Corner, Style::Cottage],
        Trait::Foodie => &[Style::Cottage, Style::Garden],
        Trait::Sporty => &[Style::Garden, Style::Corner],
    }
}

/// The style a home's founder chooses: by its trait, with the island's own
/// randomness for this founder. The same founder always chooses the same,
/// so the house keeps its shape while the founder lives there, whoever else
/// moves in; when the founder leaves, the next member chooses again.
pub fn choose(seed: u64, founder: &str, character: Trait) -> Style {
    let weight = |style: Style| match leaning(character).iter().position(|s| *s == style) {
        Some(0) => 5,
        Some(_) => 3,
        None => 1,
    };
    let total: u64 = Style::ALL.iter().map(|s| weight(*s)).sum();
    let mut rng = Rng::for_change(seed, stable_hash(founder), 0, 0x6f6d65);
    let mut pick = rng.next() % total;
    for style in Style::ALL {
        if pick < weight(style) {
            return style;
        }
        pick -= weight(style);
    }
    Style::Cottage
}

/// The members' names as the house is made under them: "Pip", "Pip &
/// Bolt", "Pip, Bolt & Mochi".
pub fn names(members: &[&str]) -> String {
    match members {
        [] => String::new(),
        [one] => (*one).to_owned(),
        [rest @ .., last] => format!("{} & {last}", rest.join(", ")),
    }
}

fn part(shape: &str, size: [f64; 3], at: [f64; 3], color: &str) -> Value {
    json!({ "shape": shape, "size": size, "at": at, "color": color })
}

fn turned(shape: &str, size: [f64; 3], at: [f64; 3], turn: [f64; 3], color: &str) -> Value {
    json!({ "shape": shape, "size": size, "at": at, "turn": turn, "color": color })
}

fn finished(value: Value, finish: &str) -> Value {
    let mut value = value;
    value["finish"] = json!(finish);
    value
}

/// A house's walls, posts and floor, laid by the centre lines of its walls.
struct Builder {
    parts: Vec<Value>,
    wall: String,
    trim: String,
}

impl Builder {
    /// A wall along its centre line from `a` to `b`, `WALL_THICK` thick.
    fn wall(&mut self, a: (f64, f64), b: (f64, f64)) {
        self.panel(a, b, WALL_HIGH / 2.0, WALL_HIGH, None);
    }

    fn panel(&mut self, a: (f64, f64), b: (f64, f64), y: f64, high: f64, color: Option<&str>) {
        let (dx, dz) = (b.0 - a.0, b.1 - a.1);
        let length = (dx * dx + dz * dz).sqrt();
        let at = [(a.0 + b.0) / 2.0, y, (a.1 + b.1) / 2.0];
        let color = color.unwrap_or(&self.wall).to_owned();
        self.parts.push(if dz.abs() < 1e-9 {
            part("round", [length, high, WALL_THICK], at, &color)
        } else if dx.abs() < 1e-9 {
            part("round", [WALL_THICK, high, length], at, &color)
        } else {
            // three.js turns +x to (cos θ, -sin θ) about y.
            let turn = (-dz).atan2(dx).to_degrees();
            turned(
                "round",
                [length, high, WALL_THICK],
                at,
                [0.0, turn, 0.0],
                &color,
            )
        });
    }

    /// A wall with a doorway `DOOR_WIDE` across, centred `door` along it from
    /// `a`, and a lintel over it in the trim colour.
    fn wall_with_door(&mut self, a: (f64, f64), b: (f64, f64), door: f64) {
        let (dx, dz) = (b.0 - a.0, b.1 - a.1);
        let length = (dx * dx + dz * dz).sqrt();
        let along = |s: f64| (a.0 + dx * s / length, a.1 + dz * s / length);
        self.wall(a, along(door - DOOR_WIDE / 2.0));
        self.wall(along(door + DOOR_WIDE / 2.0), b);
        let trim = self.trim.clone();
        self.panel(
            along(door - DOOR_WIDE / 2.0),
            along(door + DOOR_WIDE / 2.0),
            (DOOR_HIGH + WALL_HIGH) / 2.0,
            WALL_HIGH - DOOR_HIGH,
            Some(&trim),
        );
    }

    fn post(&mut self, (x, z): (f64, f64), wide: f64) {
        let trim = self.trim.clone();
        self.parts
            .push(part("cylinder", [wide, 1.8, wide], [x, 0.9, z], &trim));
    }

    /// A sign over the door with a little light, and a mat in front of it.
    fn door_dressing(&mut self, (x, z): (f64, f64)) {
        let trim = self.trim.clone();
        self.parts.extend([
            part("round", [0.9, 0.28, 0.05], [x, 1.95, z + 0.1], CREAM),
            finished(
                part("sphere", [0.12, 0.12, 0.04], [x, 1.95, z + 0.135], &trim),
                "glow",
            ),
            finished(
                part("round", [1.1, 0.03, 0.5], [x, 0.015, z + 0.45], &trim),
                "matte",
            ),
        ]);
    }
}

/// Where the doorway is, on the centre line of the front wall, in the
/// house's own coordinates.
pub fn door(style: Style) -> (f64, f64) {
    match style {
        Style::Cottage => (0.0, 2.175),
        Style::Round => (0.0, ROUND_APOTHEM - WALL_THICK / 2.0),
        Style::Corner => (-1.35, 2.325),
        Style::Garden => (0.0, 0.775),
    }
}

/// The round house is an octagon this far from its centre to a wall.
const ROUND_APOTHEM: f64 = 2.9;

/// A home's house, in the members' colours: walls from the first member's
/// shell, trim from the second's (the first's when alone), and wood.
pub fn house(style: Style, wall: &str, trim: &str) -> Value {
    let mut b = Builder {
        parts: Vec::new(),
        wall: wall.to_owned(),
        trim: trim.to_owned(),
    };
    let floor = |size: [f64; 3], x: f64, z: f64| {
        finished(part("box", size, [x, 0.03, z], FLOOR_WOOD), "matte")
    };
    match style {
        // A rectangle, 6 × 4.5 m.
        Style::Cottage => {
            let (cx, cz) = (2.925, 2.175);
            b.parts.push(floor([6.0, 0.06, 4.5], 0.0, 0.0));
            b.wall((-cx, -cz), (cx, -cz));
            b.wall((-cx, -cz), (-cx, cz));
            b.wall((cx, -cz), (cx, cz));
            b.wall_with_door((-cx, cz), (cx, cz), cx);
            for corner in [(-cx, -cz), (cx, -cz), (-cx, cz), (cx, cz)] {
                b.post(corner, 0.28);
                b.parts.push(part(
                    "sphere",
                    [0.28, 0.28, 0.28],
                    [corner.0, 1.94, corner.1],
                    trim,
                ));
            }
            b.door_dressing(door(style));
        }
        // An octagon of wall panels, 5.8 m across, on a round floor.
        Style::Round => {
            let apothem = ROUND_APOTHEM - WALL_THICK / 2.0;
            let reach = apothem / std::f64::consts::FRAC_PI_8.cos();
            let corner = |k: usize| {
                let angle = (22.5 + 45.0 * k as f64).to_radians();
                (reach * angle.cos(), reach * angle.sin())
            };
            b.parts.push(finished(
                part("cylinder", [5.8, 0.06, 5.8], [0.0, 0.03, 0.0], FLOOR_WOOD),
                "matte",
            ));
            for k in 0..8 {
                // The panel between the corners at 67.5° and 112.5° faces +z.
                if k == 1 {
                    let length = 2.0 * apothem * std::f64::consts::FRAC_PI_8.tan();
                    b.wall_with_door(corner(1), corner(2), length / 2.0);
                } else {
                    b.wall(corner(k), corner(k + 1));
                }
            }
            for k in 0..8 {
                b.post(corner(k), 0.22);
            }
            b.door_dressing(door(style));
        }
        // Two rooms joined in an L: a long one at the back and a wing in
        // front on the left, with the door in the wing.
        Style::Corner => {
            b.parts.push(floor([6.0, 0.06, 2.2], 0.0, -1.3));
            b.parts.push(floor([3.3, 0.06, 2.6], -1.35, 1.1));
            let outline = [
                (-2.925, -2.325),
                (2.925, -2.325),
                (2.925, -0.275),
                (0.225, -0.275),
                (0.225, 2.325),
                (-2.925, 2.325),
            ];
            b.wall(outline[0], outline[1]);
            b.wall(outline[1], outline[2]);
            b.wall(outline[2], outline[3]);
            b.wall(outline[3], outline[4]);
            b.wall_with_door(outline[4], outline[5], 1.575);
            b.wall(outline[5], outline[0]);
            for corner in outline {
                b.post(corner, 0.26);
            }
            b.door_dressing(door(style));
        }
        // A smaller house at the back with a fenced front yard.
        Style::Garden => {
            let (cx, back, front) = (2.525, -2.575, 0.775);
            b.parts.push(floor([5.2, 0.06, 3.5], 0.0, -0.9));
            b.wall((-cx, back), (cx, back));
            b.wall((-cx, back), (-cx, front));
            b.wall((cx, back), (cx, front));
            b.wall_with_door((-cx, front), (cx, front), cx);
            for corner in [(-cx, back), (cx, back), (-cx, front), (cx, front)] {
                b.post(corner, 0.26);
            }
            b.door_dressing(door(style));
            // The yard: grass, a picket fence no higher than 0.7 m with a
            // gate in front of the door, and two bushes.
            b.parts.push(finished(
                part("box", [5.2, 0.03, 1.8], [0.0, 0.015, 1.75], "#a7c957"),
                "matte",
            ));
            for z in [1.05, 1.5, 1.95, 2.4] {
                for x in [-2.55, 2.55] {
                    b.parts
                        .push(part("round", [0.07, 0.6, 0.05], [x, 0.3, z], CREAM));
                }
            }
            for x in [-2.4, -1.95, -1.5, -1.05, 1.05, 1.5, 1.95, 2.4] {
                b.parts
                    .push(part("round", [0.07, 0.6, 0.05], [x, 0.3, 2.6], CREAM));
            }
            for y in [0.2, 0.45] {
                for x in [-2.55, 2.55] {
                    b.parts
                        .push(part("round", [0.04, 0.06, 1.8], [x, y, 1.75], CREAM));
                }
                for x in [-1.6, 1.6] {
                    b.parts
                        .push(part("round", [1.9, 0.06, 0.04], [x, y, 2.6], CREAM));
                }
            }
            for x in [-0.65, 0.65] {
                b.parts
                    .push(part("cylinder", [0.1, 0.7, 0.1], [x, 0.35, 2.6], trim));
            }
            for x in [-2.0, 2.0] {
                b.parts
                    .push(part("sphere", [0.45, 0.4, 0.45], [x, 0.2, 2.1], LEAF));
            }
        }
    }
    json!({ "name": style.called(), "kind": "building", "parts": b.parts })
}

/// A bed's own measures: from its centre to its headboard's back, to its
/// foot, and to either side.
pub const BED_BACK: f64 = 0.69;
pub const BED_FOOT: f64 = 0.62;
pub const BED_HALF: f64 = 0.4;
/// Beds stand this far apart, centre to centre.
const BED_STEP: f64 = 0.95;

/// One member's bed, in its own trim, pillow towards the back wall.
pub fn bed(name: &str, trim: &str) -> Value {
    json!({
        "name": format!("{name}'s bed"), "kind": "furniture", "use": "bed",
        "spot": { "at": [0.0, 0.3, 0.1], "face": 0 },
        "parts": [
            part("round", [0.8, 0.2, 1.24], [0.0, 0.1, 0.0], WOOD),
            part("round", [0.72, 0.1, 1.16], [0.0, 0.25, 0.0], CREAM),
            part("round", [0.76, 0.05, 0.72], [0.0, 0.315, 0.2], &mix(trim, CREAM, 0.3)),
            part("round", [0.5, 0.09, 0.26], [0.0, 0.34, -0.42], "#ffffff"),
            part("round", [0.8, 0.45, 0.07], [0.0, 0.3, -0.655], trim),
        ],
    })
}

/// Where the beds of `count` members stand, side by side along the back
/// wall, in the house's own coordinates.
pub fn bed_row(style: Style, count: usize) -> Vec<(f64, f64)> {
    let xs: Vec<f64> = (0..count)
        .map(|at| (at as f64 - (count as f64 - 1.0) / 2.0) * BED_STEP)
        .collect();
    let (centre, back) = match style {
        Style::Cottage => (0.0, -2.1),
        Style::Corner => (0.0, -2.25),
        Style::Garden => (0.0, -2.5),
        Style::Round => {
            // An octagon narrows towards its back wall, so a long row sits
            // a little further in, where its back corners clear the slanted
            // walls.
            let inside = ROUND_APOTHEM - WALL_THICK;
            let outer = xs.iter().fold(0.0f64, |m, x| m.max(x.abs())) + BED_HALF;
            let slanted = inside * std::f64::consts::SQRT_2 - 0.05 - outer;
            let z = (-inside + 0.05 + BED_BACK).max(BED_BACK - slanted);
            return xs.into_iter().map(|x| (x, z)).collect();
        }
    };
    xs.into_iter()
        .map(|x| (centre + x, back + 0.05 + BED_BACK))
        .collect()
}

/// The room a full row of four beds takes, kept free of the members'
/// touches so beds can be laid again whoever moves in.
pub fn bed_zone(style: Style) -> Bounds {
    let row = bed_row(style, 4);
    let (x0, x1) = (row[0].0 - BED_HALF - 0.1, row[3].0 + BED_HALF + 0.1);
    let z = row[0].1;
    Bounds {
        min: [x0, 0.0, z - BED_BACK],
        max: [x1, 0.8, z + BED_FOOT + 0.3],
    }
}

/// The touch a member adds to its home, by its trait, made in its own
/// colours.
pub fn touch(character: Trait, name: &str, look: &Look) -> Value {
    let (trim, shell) = (look.trim.as_str(), look.shell.as_str());
    let soft = mix(trim, CREAM, 0.45);
    let (what, kind, extra, parts): (&str, &str, Value, Vec<Value>) = match character {
        Trait::Gardener => {
            let mut parts = vec![
                part("round", [0.9, 0.28, 0.36], [0.0, 0.14, 0.0], WOOD),
                part("round", [0.94, 0.04, 0.4], [0.0, 0.29, 0.0], trim),
            ];
            let blooms = ["#f4a6b8", "#ffd166", shell, "#ef476f", CREAM];
            for (at, x) in [-0.32, -0.16, 0.0, 0.16, 0.32].into_iter().enumerate() {
                let z = if at % 2 == 0 { -0.05 } else { 0.05 };
                parts.push(part("cylinder", [0.02, 0.12, 0.02], [x, 0.36, z], LEAF));
                parts.push(part("sphere", [0.12, 0.12, 0.12], [x, 0.46, z], blooms[at]));
            }
            parts.push(part(
                "sphere",
                [0.12, 0.06, 0.08],
                [-0.24, 0.34, 0.08],
                LEAF,
            ));
            parts.push(part(
                "sphere",
                [0.12, 0.06, 0.08],
                [0.24, 0.34, -0.08],
                LEAF,
            ));
            ("flower box", "decor", Value::Null, parts)
        }
        Trait::Tinkerer => {
            let mut parts = vec![
                part("round", [1.2, 0.07, 0.6], [0.0, 0.555, 0.0], WOOD),
                part("box", [1.1, 0.04, 0.5], [0.0, 0.15, 0.0], WOOD),
            ];
            for (x, z) in [(-0.52, -0.23), (0.52, -0.23), (-0.52, 0.23), (0.52, 0.23)] {
                parts.push(part("cylinder", [0.07, 0.52, 0.07], [x, 0.26, z], trim));
            }
            parts.extend([
                finished(
                    part("box", [0.16, 0.1, 0.12], [0.45, 0.64, 0.18], STEEL),
                    "metal",
                ),
                finished(
                    turned(
                        "torus",
                        [0.22, 0.05, 0.22],
                        [-0.3, 0.71, -0.15],
                        [90.0, 0.0, 0.0],
                        STEEL,
                    ),
                    "metal",
                ),
                part("cylinder", [0.06, 0.06, 0.06], [-0.3, 0.71, -0.15], trim),
                finished(
                    turned(
                        "box",
                        [0.04, 0.02, 0.22],
                        [0.05, 0.6, 0.1],
                        [0.0, 30.0, 0.0],
                        STEEL,
                    ),
                    "metal",
                ),
            ]);
            let spot = json!({ "use": "desk", "spot": { "at": [0.0, 0.0, 0.6], "face": 180 } });
            ("workbench", "furniture", spot, parts)
        }
        Trait::Foodie => {
            let parts = vec![
                part("round", [1.0, 0.55, 0.5], [0.0, 0.275, 0.0], trim),
                part("round", [1.06, 0.05, 0.56], [0.0, 0.575, 0.0], WOOD),
                part("box", [0.9, 0.08, 0.02], [0.0, 0.4, 0.26], CREAM),
                part("sphere", [0.2, 0.17, 0.2], [0.2, 0.685, 0.0], shell),
                part("sphere", [0.07, 0.05, 0.07], [0.2, 0.78, 0.0], &soft),
                turned(
                    "cylinder",
                    [0.035, 0.12, 0.035],
                    [0.33, 0.7, 0.0],
                    [0.0, 0.0, -50.0],
                    shell,
                ),
                turned(
                    "torus",
                    [0.1, 0.025, 0.1],
                    [0.08, 0.69, 0.0],
                    [90.0, 0.0, 0.0],
                    shell,
                ),
                part("cylinder", [0.07, 0.07, 0.07], [-0.2, 0.635, 0.05], CREAM),
                part("cylinder", [0.07, 0.07, 0.07], [-0.32, 0.635, -0.05], CREAM),
            ];
            let spot = json!({ "use": "desk", "spot": { "at": [0.0, 0.0, 0.55], "face": 180 } });
            ("little counter", "furniture", spot, parts)
        }
        Trait::Dreamy => {
            let mut parts = vec![
                part("cylinder", [0.3, 0.06, 0.3], [0.0, 0.03, 0.0], trim),
                part("cylinder", [0.05, 1.3, 0.05], [0.0, 0.71, 0.0], WOOD),
            ];
            for arm in [0.0, 60.0, 120.0] {
                parts.push(finished(
                    turned(
                        "box",
                        [0.36, 0.08, 0.05],
                        [0.0, 1.55, 0.0],
                        [0.0, 0.0, arm],
                        "#ffe066",
                    ),
                    "glow",
                ));
            }
            parts.push(finished(
                part("sphere", [0.12, 0.12, 0.12], [0.0, 1.55, 0.0], shell),
                "glow",
            ));
            parts.push(finished(
                part("sphere", [0.1, 0.1, 0.1], [0.2, 1.25, 0.0], &soft),
                "glow",
            ));
            ("star lamp", "decor", Value::Null, parts)
        }
        Trait::Artsy => {
            let parts = vec![
                turned(
                    "cylinder",
                    [0.04, 1.3, 0.04],
                    [-0.24, 0.65, 0.04],
                    [0.0, 0.0, 8.0],
                    WOOD,
                ),
                turned(
                    "cylinder",
                    [0.04, 1.3, 0.04],
                    [0.24, 0.65, 0.04],
                    [0.0, 0.0, -8.0],
                    WOOD,
                ),
                turned(
                    "cylinder",
                    [0.04, 1.25, 0.04],
                    [0.0, 0.6, -0.22],
                    [20.0, 0.0, 0.0],
                    WOOD,
                ),
                part("box", [0.66, 0.04, 0.1], [0.0, 0.72, 0.03], WOOD),
                part("box", [0.6, 0.48, 0.03], [0.0, 0.98, 0.0], CREAM),
                part("box", [0.54, 0.22, 0.02], [0.0, 1.09, 0.025], "#a0c4ff"),
                part("sphere", [0.5, 0.18, 0.02], [0.0, 0.86, 0.03], LEAF),
                part("sphere", [0.1, 0.1, 0.02], [0.15, 1.12, 0.04], "#ffd166"),
                part("cylinder", [0.12, 0.12, 0.12], [0.42, 0.06, 0.15], trim),
            ];
            ("easel", "decor", Value::Null, parts)
        }
        Trait::Sporty => {
            let parts = vec![
                part("cylinder", [0.4, 0.06, 0.4], [0.0, 0.03, -0.25], trim),
                finished(
                    part("cylinder", [0.07, 1.5, 0.07], [0.0, 0.81, -0.25], STEEL),
                    "metal",
                ),
                part("round", [0.6, 0.42, 0.04], [0.0, 1.55, -0.2], CREAM),
                part("box", [0.24, 0.18, 0.02], [0.0, 1.5, -0.17], trim),
                part("torus", [0.36, 0.03, 0.36], [0.0, 1.38, 0.0], "#ff9f1c"),
                finished(
                    turned(
                        "cone",
                        [0.3, 0.2, 0.3],
                        [0.0, 1.27, 0.0],
                        [180.0, 0.0, 0.0],
                        CREAM,
                    ),
                    "glass",
                ),
                part("sphere", [0.24, 0.24, 0.24], [0.35, 0.12, 0.25], "#e76f51"),
                turned(
                    "torus",
                    [0.25, 0.02, 0.25],
                    [0.35, 0.12, 0.25],
                    [90.0, 0.0, 0.0],
                    "#2b2d42",
                ),
            ];
            ("ball and hoop", "decor", Value::Null, parts)
        }
        Trait::Cozy => {
            let parts = vec![
                finished(
                    part("cylinder", [1.6, 0.02, 1.1], [0.0, 0.01, 0.0], trim),
                    "matte",
                ),
                part("torus", [1.6, 0.02, 1.1], [0.0, 0.02, 0.0], CREAM),
                part("round", [0.45, 0.18, 0.45], [-0.35, 0.11, 0.1], shell),
                part("round", [0.42, 0.16, 0.42], [0.35, 0.1, 0.12], &soft),
                part("round", [0.3, 0.12, 0.3], [0.0, 0.08, -0.3], trim),
            ];
            let spot = json!({ "use": "seat", "spot": { "at": [-0.35, 0.2, 0.1], "face": 0 } });
            ("rug and cushions", "furniture", spot, parts)
        }
        Trait::Curious => {
            let mut parts = vec![
                part("round", [0.06, 1.1, 0.32], [-0.47, 0.55, 0.0], WOOD),
                part("round", [0.06, 1.1, 0.32], [0.47, 0.55, 0.0], WOOD),
            ];
            for y in [0.02, 0.37, 0.72, 1.08] {
                parts.push(part("box", [0.9, 0.04, 0.32], [0.0, y, 0.0], WOOD));
            }
            let spines = [trim, shell, "#e76f51", "#2a9d8f", "#e9c46a", &soft];
            for (row, y) in [0.17, 0.52, 0.87].into_iter().enumerate() {
                for at in 0..5 {
                    let x = -0.34 + 0.13 * at as f64 + 0.03 * row as f64;
                    let high = 0.22 + 0.03 * ((at + row) % 3) as f64;
                    parts.push(part(
                        "box",
                        [0.08, high, 0.22],
                        [x, y - 0.13 + high / 2.0, 0.0],
                        spines[(at + 2 * row) % spines.len()],
                    ));
                }
            }
            parts.extend([
                part("cylinder", [0.1, 0.08, 0.1], [0.2, 1.14, 0.0], WOOD),
                part("sphere", [0.24, 0.24, 0.24], [0.2, 1.3, 0.0], "#4ea8de"),
                turned(
                    "torus",
                    [0.28, 0.02, 0.28],
                    [0.2, 1.3, 0.0],
                    [90.0, 0.0, 20.0],
                    "#e9c46a",
                ),
            ]);
            ("bookshelf", "furniture", Value::Null, parts)
        }
    };
    let mut asset = json!({ "name": format!("{name}'s {what}"), "kind": kind, "parts": parts });
    if let Value::Object(extra) = extra {
        for (key, value) in extra {
            asset[key] = value;
        }
    }
    asset
}

/// Whether a touch goes by the door rather than inside.
pub fn by_the_door(character: Trait) -> bool {
    character == Trait::Gardener
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::island::model::Kind;
    use crate::island::rules::{self, asset_bounds, check_asset, fits_plot, footprint, overlaps};
    use crate::island::starter::bot_look;

    const UNDERFOOT: f64 = 0.1;

    #[test]
    fn the_members_names_are_joined_the_way_a_person_says_them() {
        assert_eq!(names(&["Pip"]), "Pip");
        assert_eq!(names(&["Pip", "Bolt"]), "Pip & Bolt");
        assert_eq!(names(&["Pip", "Bolt", "Mochi"]), "Pip, Bolt & Mochi");
        assert_eq!(
            names(&["Pip", "Bolt", "Mochi", "Zuzu"]),
            "Pip, Bolt, Mochi & Zuzu"
        );
    }

    /// Every style, with one to four members: a roofless building on the
    /// tile, a doorway in its front wall, and every bed inside its walls.
    #[test]
    fn every_house_with_every_count_of_members_is_built_and_sleeps_them_all() {
        for style in Style::ALL {
            let (house, _) = check_asset(house(style, "#fde2e4", "#7aa5d6"))
                .unwrap_or_else(|why| panic!("{style:?}: {why}"));
            assert_eq!(house.kind, Kind::Building);
            let bounds = asset_bounds(&house.parts);
            assert!(
                fits_plot(&bounds, HOUSE_AT.0, HOUSE_AT.1, 0.0),
                "{style:?}: {bounds:?}"
            );
            // Walls 1.6 to 1.8 m, and a lintel that leaves 1.4 m under it.
            let tallest_wall = house
                .parts
                .iter()
                .filter(|p| p.shape == crate::island::model::Shape::Round && p.size[1] >= 1.0)
                .map(|p| rules::part_bounds(p).max[1])
                .fold(0.0, f64::max);
            assert!(
                (1.6..=1.8).contains(&tallest_wall),
                "{style:?}: {tallest_wall}"
            );
            let lintel = house
                .parts
                .iter()
                .map(rules::part_bounds)
                .filter(|b| b.min[1] > 1.3 && b.min[1] < 1.6 && b.max[1] <= 1.75)
                .count();
            assert!(lintel >= 1, "{style:?} has a lintel over its door");
            let walls: Vec<_> = house
                .parts
                .iter()
                .filter(|p| {
                    rules::part_bounds(p).max[1] > UNDERFOOT && rules::part_bounds(p).max[1] <= 2.2
                })
                .map(footprint)
                .collect();
            for count in 1..=4 {
                let (bed, _) = check_asset(bed("Pip", "#7aa5d6")).unwrap();
                let bed_box = asset_bounds(&bed.parts);
                let row = bed_row(style, count);
                assert_eq!(row.len(), count);
                for (x, z) in &row {
                    let shape = rules::placed_box(&bed_box, *x, *z, 0.0, 0.0);
                    for wall in &walls {
                        assert!(
                            !overlaps(&shape, wall),
                            "{style:?} with {count}: a bed in a wall"
                        );
                    }
                    // Inside the house's walls: within its box, and behind
                    // its front.
                    assert!(
                        shape.iter().all(|p| {
                            p[0] > bounds.min[0]
                                && p[0] < bounds.max[0]
                                && p[1] > bounds.min[2]
                                && p[1] < door(style).1
                        }),
                        "{style:?} with {count}"
                    );
                }
                // Side by side, never on top of each other.
                for pair in row.windows(2) {
                    assert!(pair[1].0 - pair[0].0 >= 2.0 * BED_HALF);
                }
            }
            // A doorway: nothing stands across the front wall's middle below
            // the lintel.
            let (dx, dz) = door(style);
            let gap = rules::placed_box(
                &Bounds {
                    min: [-0.5, 0.0, -0.05],
                    max: [0.5, 1.4, 0.05],
                },
                dx,
                dz,
                0.0,
                0.0,
            );
            for (part, seen) in house.parts.iter().zip(house.parts.iter().map(footprint)) {
                let b = rules::part_bounds(part);
                if b.max[1] > UNDERFOOT && b.min[1] < 1.4 {
                    assert!(!overlaps(&gap, &seen), "{style:?}: the doorway is blocked");
                }
            }
        }
    }

    #[test]
    fn a_founder_chooses_by_its_trait_and_keeps_its_choice() {
        assert_eq!(choose(9, "b_1", Trait::Cozy), choose(9, "b_1", Trait::Cozy));
        let share = |character: Trait, style: Style| {
            (0..400)
                .filter(|at| choose(at * 31, &format!("b_{at}"), character) == style)
                .count()
        };
        assert!(share(Trait::Gardener, Style::Garden) > share(Trait::Gardener, Style::Round) * 2);
        let seen: std::collections::BTreeSet<_> = (0..200)
            .map(|at| choose(at, &format!("b_{at}"), Trait::ALL[at as usize % 8]))
            .collect();
        assert_eq!(seen.len(), Style::ALL.len());
    }

    #[test]
    fn every_bed_and_every_touch_is_an_asset_the_host_takes() {
        let mut rng = Rng::new(3);
        for character in Trait::ALL {
            let look = bot_look(&mut rng);
            let (made, _) = check_asset(touch(*character, "Pip", &look))
                .unwrap_or_else(|why| panic!("{character:?}: {why}"));
            assert!(made.name.starts_with("Pip's "), "{}", made.name);
            assert!(matches!(made.kind, Kind::Furniture | Kind::Decor));
            if *character == Trait::Cozy {
                assert_eq!(made.r#use, Some(crate::island::model::Use::Seat));
            }
        }
        let (bed, _) = check_asset(bed("Pip", "#7aa5d6")).unwrap();
        let size = asset_bounds(&bed.parts);
        assert!((size.min[2] + BED_BACK).abs() < 1e-6 && (size.max[2] - BED_FOOT).abs() < 1e-6);
        assert!((size.max[0] - BED_HALF).abs() < 1e-6);
        assert_eq!(bed.r#use, Some(crate::island::model::Use::Bed));
    }
}
