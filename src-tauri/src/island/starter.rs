//! What a new resident is given: a 波特's name and look, and the roofless
//! workshop and desk a registered agent's plot is handed over with. A plot
//! is never handed over empty; a 波特's home is built by its members
//! (`home.rs`).
//!
//! The starter assets are written as an agent would write them and go
//! through the same checks (`rules::check_asset`); a test holds every one of
//! them to it. They are tinted from their owner and kept soft: round shapes,
//! warm wood, pastel walls.
use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::layout::{stable_hash, Rng};
use super::model::{Antenna, Eyes, Frame, Look};

/// 波特 names: short, and unique among the 波特 living there.
pub const NAMES: &[&str] = &[
    "Pip", "Bolt", "Nib", "Mochi", "Zuzu", "Rivet", "Sprocket", "Nori", "Kiki", "Bean", "Tofu",
    "Pico", "Dot", "Bloop", "Tink", "Widget", "Gizmo", "Momo", "Pudding", "Biscuit", "Noodle",
    "Bubbles", "Sprout", "Pebble", "Fizz", "Ziggy", "Chip", "Dash", "Echo", "Gumdrop", "Hopper",
    "Iggy", "Jelly", "Kip", "Lumi", "Muffin", "Nugget", "Pixel", "Quill", "Ripple", "Sushi",
    "Tiko", "Vela", "Waffle", "Yoyo", "Zip", "Acorn", "Button", "Clover", "Doodle", "Ember",
    "Fern", "Ginger", "Hazel", "Inky", "Juniper", "Kelp", "Lolly", "Marble", "Nimbus", "Olive",
    "Peanut", "Quince", "Rusty", "Sunny", "Toffee", "Umi", "Wisp", "Yuzu", "Boba", "Cocoa",
    "Dumpling", "Kumo", "Taro", "Miso", "Puffin", "Sparky", "Twig", "Wobble", "Bramble",
];

/// Body colours: soft and light.
const SHELLS: &[&str] = &[
    "#f3efe6", "#fde2e4", "#e2ece9", "#dfe7fd", "#fff1c1", "#e8dff5", "#fbe7c6", "#d7f2e9",
    "#f6f6f6", "#ffd8be", "#cde7f0", "#e9f5db",
];

/// Accents: brighter, so they read against a pastel shell.
const TRIMS: &[&str] = &[
    "#7aa5d6", "#f28482", "#84a59d", "#f6bd60", "#9381ff", "#ff9f1c", "#2ec4b6", "#e76f51",
    "#6a994e", "#bc6c25", "#ef476f", "#118ab2", "#8d99ae", "#ffb4a2",
];

/// Eyes and lights.
const GLOWS: &[&str] = &[
    "#9fe8ff", "#b9fbc0", "#ffe066", "#ffadad", "#cdb4db", "#a0c4ff", "#fdffb6", "#caffbf",
    "#ffc6ff", "#9bf6ff",
];

/// A registered agent's workshop: wall and trim, chosen by its id.
const WORKSHOP_TINTS: &[(&str, &str)] = &[
    ("#f6efe3", "#7aa5d6"),
    ("#fdf0ec", "#e07a5f"),
    ("#eef6f0", "#81b29a"),
    ("#f3effa", "#9381ff"),
    ("#fff6dd", "#f2a541"),
    ("#eaf4f8", "#4ea8de"),
    ("#fbeff4", "#d16ba5"),
    ("#f1f5e8", "#8ab17d"),
];

const FLOOR_WOOD: &str = "#d9b48f";
const WOOD: &str = "#c8956b";
const CREAM: &str = "#fdf8ef";
const INK: &str = "#3d405b";
const SCREEN: &str = "#9fe8ff";

/// A free name for a new bot, or a numbered one when every name is taken.
pub fn bot_name(rng: &mut Rng, taken: &[&str]) -> String {
    let free: Vec<&str> = NAMES
        .iter()
        .copied()
        .filter(|name| !taken.contains(name))
        .collect();
    if !free.is_empty() {
        return rng.pick(&free).to_string();
    }
    (2..)
        .map(|n| format!("{} {n}", rng.pick(NAMES)))
        .find(|name| !taken.contains(&name.as_str()))
        .unwrap_or_else(|| "Bot".into())
}

/// A whole look for a new bot, from pleasant palettes.
pub fn bot_look(rng: &mut Rng) -> Look {
    Look {
        frame: *rng.pick(Frame::ALL),
        shell: rng.pick(SHELLS).to_string(),
        trim: rng.pick(TRIMS).to_string(),
        glow: rng.pick(GLOWS).to_string(),
        eyes: *rng.pick(Eyes::ALL),
        antenna: *rng.pick(Antenna::ALL),
        worn: BTreeMap::new(),
    }
}

/// `#rrggbb` mixed `t` of the way from `a` to `b`.
pub fn mix(a: &str, b: &str, t: f64) -> String {
    let channel = |hex: &str, at: usize| {
        u8::from_str_radix(hex.get(1 + 2 * at..3 + 2 * at).unwrap_or("00"), 16).unwrap_or(0)
    };
    let mixed: Vec<u8> = (0..3)
        .map(|at| {
            let (x, y) = (f64::from(channel(a, at)), f64::from(channel(b, at)));
            (x + (y - x) * t).round().clamp(0.0, 255.0) as u8
        })
        .collect();
    format!("#{:02x}{:02x}{:02x}", mixed[0], mixed[1], mixed[2])
}

/// The wall and trim of a registered agent's workshop.
pub fn agent_tint(agent_id: &str) -> (String, String) {
    let (wall, trim) =
        WORKSHOP_TINTS[(stable_hash(agent_id) % WORKSHOP_TINTS.len() as u64) as usize];
    (wall.into(), trim.into())
}

fn part(shape: &str, size: [f64; 3], at: [f64; 3], color: &str) -> Value {
    json!({ "shape": shape, "size": size, "at": at, "color": color })
}

fn finished(shape: &str, size: [f64; 3], at: [f64; 3], color: &str, finish: &str) -> Value {
    json!({ "shape": shape, "size": size, "at": at, "color": color, "finish": finish })
}

/// The four corners of a rectangle, `x` and `z` from the middle.
fn four(x: f64, z: f64) -> [[f64; 2]; 4] {
    [[-x, -z], [x, -z], [-x, z], [x, z]]
}

/// A registered agent's roofless workshop: 5 × 4 m, walls 1.8 m, a 1.2 m
/// doorway in the front wall, a wooden floor and a sign over the door.
pub fn workshop(wall: &str, trim: &str) -> Value {
    let mut parts = vec![
        finished(
            "box",
            [5.0, 0.06, 4.0],
            [0.0, 0.03, 0.0],
            FLOOR_WOOD,
            "matte",
        ),
        part("round", [5.0, 1.8, 0.15], [0.0, 0.9, -1.925], wall),
        part("round", [0.15, 1.8, 3.7], [-2.425, 0.9, 0.0], wall),
        part("round", [0.15, 1.8, 3.7], [2.425, 0.9, 0.0], wall),
        // The front wall, either side of a doorway 1.2 m wide and 1.5 m high.
        part("round", [1.9, 1.8, 0.15], [-1.55, 0.9, 1.925], wall),
        part("round", [1.9, 1.8, 0.15], [1.55, 0.9, 1.925], wall),
        part("round", [1.2, 0.3, 0.15], [0.0, 1.65, 1.925], trim),
    ];
    for [x, z] in four(2.45, 1.95) {
        parts.push(part("cylinder", [0.3, 1.9, 0.3], [x, 0.95, z], trim));
        parts.push(part("sphere", [0.3, 0.3, 0.3], [x, 2.05, z], trim));
    }
    parts.extend([
        part("round", [1.0, 0.32, 0.06], [0.0, 2.0, 2.04], CREAM),
        finished("sphere", [0.12, 0.12, 0.04], [0.0, 2.0, 2.08], trim, "glow"),
        // A window box of flowers beside the door.
        part("round", [1.0, 0.22, 0.24], [1.55, 0.95, 2.12], WOOD),
        part("sphere", [0.16, 0.16, 0.16], [1.25, 1.12, 2.12], "#f4a6b8"),
        part("sphere", [0.16, 0.16, 0.16], [1.55, 1.12, 2.12], "#ffd166"),
        part("sphere", [0.16, 0.16, 0.16], [1.85, 1.12, 2.12], "#fdf8ef"),
        finished(
            "round",
            [1.1, 0.03, 0.55],
            [0.0, 0.015, 2.45],
            trim,
            "matte",
        ),
    ]);
    json!({ "name": "Workshop", "kind": "building", "parts": parts })
}

/// The desk inside a workshop, with a little screen on it. Its spot is in
/// front, facing it.
pub fn desk(trim: &str) -> Value {
    let mut parts = vec![part("round", [1.2, 0.06, 0.6], [0.0, 0.55, 0.0], WOOD)];
    for [x, z] in four(0.52, 0.24) {
        parts.push(part("cylinder", [0.07, 0.52, 0.07], [x, 0.26, z], trim));
    }
    parts.extend([
        part("round", [0.6, 0.4, 0.05], [0.0, 0.83, -0.17], INK),
        finished(
            "box",
            [0.52, 0.32, 0.02],
            [0.0, 0.83, -0.14],
            SCREEN,
            "glow",
        ),
        part("cylinder", [0.05, 0.12, 0.05], [0.0, 0.64, -0.19], INK),
        part("cylinder", [0.2, 0.02, 0.14], [0.0, 0.59, -0.19], INK),
        part("round", [0.36, 0.025, 0.12], [0.0, 0.593, 0.1], CREAM),
        part("cylinder", [0.08, 0.1, 0.08], [0.42, 0.63, 0.05], trim),
    ]);
    json!({
        "name": "Desk", "kind": "furniture", "use": "desk",
        "spot": { "at": [0.0, 0.0, 0.6], "face": 180 },
        "parts": parts,
    })
}

/// Where an agent's starters stand, in plot coordinates (`+z` towards the
/// plaza): the workshop a little back from the middle of the tile, and the
/// desk inside, against the back wall.
pub const WORKSHOP_AT: (f64, f64) = (0.0, -1.0);
pub const DESK_AT: (f64, f64) = (0.9, -2.5);
