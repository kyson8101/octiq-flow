//! Every 波特 wears a backpack it designed itself. The design is its own
//! choice, leaning on its trait (a gardener towards a flower pot, a tinkerer
//! towards a toolbox or a rocket) with the island's randomness deciding,
//! and it is made in the 波特's own colours, its trim and shell, with one
//! accent that stands out against the trim.
//!
//! A backpack is an ordinary accessory for the `back` slot, made by the 波特
//! (`by: { name }`, no agent and no chat), and goes through the same checks
//! as an agent's. Coordinates are the back anchor's: the middle of the
//! robot's back, `+z` the robot's front, so a pack hangs at negative z. The
//! robot's big head overhangs to about `z = -0.24`, so a pack reaches back to
//! about -0.30 and stays within about ±0.18 of the anchor's height.
use serde_json::{json, Value};

use super::layout::Rng;
use super::model::{Look, Trait};
use super::starter::mix;

/// The designs a 波特 chooses between, each a silhouette of its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Design {
    Classic,
    Turtle,
    Rocket,
    FlowerPot,
    Toolbox,
    StarPouch,
    Bento,
    Drum,
    Teddy,
}

impl Design {
    pub const ALL: [Design; 9] = [
        Design::Classic,
        Design::Turtle,
        Design::Rocket,
        Design::FlowerPot,
        Design::Toolbox,
        Design::StarPouch,
        Design::Bento,
        Design::Drum,
        Design::Teddy,
    ];

    /// What the pack is called after its 波特's name: "Pip's flower-pot pack".
    pub fn called(self) -> &'static str {
        match self {
            Design::Classic => "trusty pack",
            Design::Turtle => "turtle-shell pack",
            Design::Rocket => "rocket pack",
            Design::FlowerPot => "flower-pot pack",
            Design::Toolbox => "toolbox pack",
            Design::StarPouch => "star pouch",
            Design::Bento => "bento pack",
            Design::Drum => "drum pack",
            Design::Teddy => "teddy pack",
        }
    }
}

/// The designs a trait leans towards, the first more than the second.
fn leaning(character: Trait) -> &'static [Design] {
    match character {
        Trait::Gardener => &[Design::FlowerPot],
        Trait::Tinkerer => &[Design::Toolbox, Design::Rocket],
        Trait::Dreamy => &[Design::StarPouch, Design::Turtle],
        Trait::Foodie => &[Design::Bento],
        Trait::Sporty => &[Design::Rocket, Design::Classic],
        Trait::Artsy => &[Design::Drum, Design::StarPouch],
        Trait::Cozy => &[Design::Teddy, Design::Classic],
        Trait::Curious => &[Design::Classic, Design::Turtle],
    }
}

/// How likely a 波特 of this trait is to choose a design: every design may
/// come up, the ones it leans towards several times as often.
pub fn weight(character: Trait, design: Design) -> u64 {
    match leaning(character).iter().position(|d| *d == design) {
        Some(0) => 6,
        Some(_) => 4,
        None => 1,
    }
}

pub fn choose(rng: &mut Rng, character: Trait) -> Design {
    let total: u64 = Design::ALL.iter().map(|d| weight(character, *d)).sum();
    let mut pick = rng.next() % total;
    for design in Design::ALL {
        let weight = weight(character, design);
        if pick < weight {
            return design;
        }
        pick -= weight;
    }
    Design::Classic
}

/// Accents bright enough to stand out on a pack; the one chosen is among
/// the furthest from the 波特's trim.
const ACCENTS: &[&str] = &[
    "#ffd166", "#ef476f", "#06d6a0", "#118ab2", "#ff9f1c", "#9b5de5", "#f15bb5", "#00bbf9",
    "#fee440", "#8ac926",
];

const INK: &str = "#2b2d42";
const WOOD: &str = "#c8956b";
const STEEL: &str = "#c0c7d1";
const CREAM: &str = "#fdf8ef";

fn rgb(hex: &str) -> [f64; 3] {
    let channel =
        |at: usize| u8::from_str_radix(hex.get(1 + 2 * at..3 + 2 * at).unwrap_or("00"), 16);
    [0, 1, 2].map(|at| f64::from(channel(at).unwrap_or(0)))
}

fn distance(a: &str, b: &str) -> f64 {
    let (a, b) = (rgb(a), rgb(b));
    (0..3).map(|i| (a[i] - b[i]).powi(2)).sum::<f64>().sqrt()
}

/// The pack's colours: the 波特's trim for the body, a light of its shell,
/// a dark of its trim, and one accent against the trim.
struct Paint {
    body: String,
    light: String,
    dark: String,
    accent: String,
}

fn paint(look: &Look, rng: &mut Rng) -> Paint {
    let mut accents: Vec<&str> = ACCENTS.to_vec();
    accents.sort_by(|a, b| distance(b, &look.trim).total_cmp(&distance(a, &look.trim)));
    Paint {
        body: look.trim.clone(),
        light: mix(&look.shell, "#ffffff", 0.2),
        dark: mix(&look.trim, INK, 0.55),
        accent: rng.pick(&accents[..3]).to_string(),
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

/// The two straps every pack hangs from, against the robot's back.
fn straps(dark: &str) -> [Value; 2] {
    [-0.1, 0.1].map(|x| part("round", [0.05, 0.28, 0.03], [x, 0.0, -0.015], dark))
}

/// A 波特's backpack: the design it chose, and the asset as an agent would
/// write it.
pub fn backpack(rng: &mut Rng, character: Trait, name: &str, look: &Look) -> (Design, Value) {
    let design = choose(rng, character);
    let paint = paint(look, rng);
    let Paint {
        body,
        light,
        dark,
        accent,
    } = &paint;
    let mut parts: Vec<Value> = match design {
        // A rounded body, a flap over the top, a pocket on the front.
        Design::Classic => vec![
            part("round", [0.34, 0.3, 0.22], [0.0, -0.01, -0.14], body),
            part("round", [0.36, 0.1, 0.24], [0.0, 0.13, -0.145], light),
            part("round", [0.22, 0.13, 0.07], [0.0, -0.06, -0.27], accent),
            part("box", [0.06, 0.05, 0.02], [0.0, 0.09, -0.27], dark),
        ],
        // A dome with a rim round it and plates on its back.
        Design::Turtle => {
            let mut shell = vec![
                part("sphere", [0.38, 0.34, 0.24], [0.0, 0.0, -0.15], body),
                turned(
                    "torus",
                    [0.4, 0.05, 0.36],
                    [0.0, 0.0, -0.06],
                    [90.0, 0.0, 0.0],
                    light,
                ),
                part("sphere", [0.11, 0.11, 0.04], [0.0, 0.01, -0.27], accent),
            ];
            for (x, y) in [(-0.1, 0.08), (0.1, 0.08), (-0.1, -0.08), (0.1, -0.08)] {
                shell.push(part("sphere", [0.09, 0.09, 0.04], [x, y, -0.24], accent));
            }
            shell
        }
        // Two rockets side by side, pointed tops, little flames below.
        Design::Rocket => {
            let mut rocket = Vec::new();
            for x in [-0.085, 0.085] {
                rocket.push(part(
                    "cylinder",
                    [0.13, 0.26, 0.13],
                    [x, -0.02, -0.13],
                    body,
                ));
                rocket.push(part("cone", [0.13, 0.1, 0.13], [x, 0.16, -0.13], accent));
                rocket.push(finished(
                    turned(
                        "cone",
                        [0.08, 0.1, 0.08],
                        [x, -0.2, -0.13],
                        [180.0, 0.0, 0.0],
                        "#ffb703",
                    ),
                    "glow",
                ));
            }
            rocket.push(part("round", [0.32, 0.06, 0.1], [0.0, 0.0, -0.08], light));
            for x in [-0.16, 0.16] {
                rocket.push(part("wedge", [0.02, 0.08, 0.1], [x, -0.11, -0.13], dark));
            }
            rocket
        }
        // A pot with a rim, soil, and three to five little flowers.
        Design::FlowerPot => {
            let mut pot = vec![
                part("cylinder", [0.3, 0.2, 0.24], [0.0, -0.07, -0.14], body),
                part("torus", [0.33, 0.05, 0.27], [0.0, 0.03, -0.14], accent),
                part(
                    "cylinder",
                    [0.27, 0.02, 0.21],
                    [0.0, 0.035, -0.14],
                    "#7b5e3b",
                ),
            ];
            let blooms = [accent.as_str(), light, "#ffffff", "#f4a6b8", "#ffd166"];
            let spots = [
                (-0.09, -0.1),
                (0.0, -0.17),
                (0.09, -0.11),
                (-0.04, -0.2),
                (0.05, -0.07),
            ];
            let count = 3 + rng.below(3);
            for (at, (x, z)) in spots.iter().take(count).enumerate() {
                pot.push(part(
                    "cylinder",
                    [0.02, 0.1, 0.02],
                    [*x, 0.09, *z],
                    "#6a994e",
                ));
                pot.push(part(
                    "sphere",
                    [0.07, 0.07, 0.07],
                    [*x, 0.16, *z],
                    blooms[at],
                ));
            }
            pot
        }
        // A box with a lid and a handle, and a wrench on the front.
        Design::Toolbox => vec![
            part("round", [0.36, 0.22, 0.2], [0.0, -0.05, -0.13], body),
            part("box", [0.37, 0.04, 0.21], [0.0, 0.07, -0.13], light),
            part("box", [0.03, 0.06, 0.03], [-0.07, 0.12, -0.13], dark),
            part("box", [0.03, 0.06, 0.03], [0.07, 0.12, -0.13], dark),
            part("round", [0.17, 0.03, 0.04], [0.0, 0.16, -0.13], dark),
            part("box", [0.07, 0.05, 0.02], [0.0, 0.02, -0.24], accent),
            finished(
                turned(
                    "box",
                    [0.035, 0.15, 0.02],
                    [0.07, -0.07, -0.245],
                    [0.0, 0.0, -35.0],
                    STEEL,
                ),
                "metal",
            ),
            finished(
                turned(
                    "torus",
                    [0.07, 0.025, 0.07],
                    [0.115, 0.0, -0.245],
                    [90.0, 0.0, 0.0],
                    STEEL,
                ),
                "metal",
            ),
        ],
        // A soft pouch gathered at the top, and a glowing star of crossed bars.
        Design::StarPouch => {
            let mut pouch = vec![
                part("round", [0.32, 0.28, 0.2], [0.0, -0.03, -0.13], body),
                part("cylinder", [0.14, 0.06, 0.1], [0.0, 0.13, -0.13], light),
                part("torus", [0.15, 0.03, 0.11], [0.0, 0.11, -0.13], dark),
            ];
            let tilt = 15.0 * rng.below(4) as f64;
            for arm in [0.0, 60.0, 120.0] {
                pouch.push(finished(
                    turned(
                        "box",
                        [0.17, 0.045, 0.02],
                        [0.0, -0.03, -0.24],
                        [0.0, 0.0, arm + tilt],
                        accent,
                    ),
                    "glow",
                ));
            }
            pouch.push(finished(
                part("sphere", [0.05, 0.05, 0.03], [0.0, -0.03, -0.25], accent),
                "glow",
            ));
            pouch
        }
        // Two or three stacked lunch boxes, tied with a band and a knot.
        Design::Bento => {
            let layers = 2 + rng.below(2);
            let height = 0.3 / layers as f64;
            let mut bento = Vec::new();
            for at in 0..layers {
                let y = -0.15 + height * (at as f64 + 0.5);
                let colour = if at % 2 == 0 { body } else { light };
                bento.push(part(
                    "round",
                    [0.34, height - 0.012, 0.2],
                    [0.0, y, -0.13],
                    colour,
                ));
            }
            bento.extend([
                part("box", [0.05, 0.31, 0.215], [0.0, 0.0, -0.13], accent),
                part("sphere", [0.1, 0.06, 0.06], [0.0, 0.17, -0.13], accent),
                turned(
                    "cylinder",
                    [0.02, 0.24, 0.02],
                    [0.12, 0.04, -0.245],
                    [0.0, 0.0, -10.0],
                    WOOD,
                ),
                turned(
                    "cylinder",
                    [0.02, 0.24, 0.02],
                    [0.145, 0.04, -0.245],
                    [0.0, 0.0, -10.0],
                    WOOD,
                ),
            ]);
            bento
        }
        // A drum facing back, rims at both ends, and two sticks in it.
        Design::Drum => {
            let mut drum = vec![
                turned(
                    "cylinder",
                    [0.32, 0.18, 0.32],
                    [0.0, 0.0, -0.13],
                    [90.0, 0.0, 0.0],
                    body,
                ),
                turned(
                    "torus",
                    [0.34, 0.03, 0.34],
                    [0.0, 0.0, -0.045],
                    [90.0, 0.0, 0.0],
                    light,
                ),
                turned(
                    "torus",
                    [0.34, 0.03, 0.34],
                    [0.0, 0.0, -0.215],
                    [90.0, 0.0, 0.0],
                    light,
                ),
                turned(
                    "cylinder",
                    [0.29, 0.02, 0.29],
                    [0.0, 0.0, -0.225],
                    [90.0, 0.0, 0.0],
                    CREAM,
                ),
            ];
            for (x, lean) in [(-0.12, 30.0), (0.12, -30.0)] {
                drum.push(turned(
                    "cylinder",
                    [0.025, 0.22, 0.025],
                    [x, 0.1, -0.26],
                    [0.0, 0.0, lean],
                    WOOD,
                ));
                let top = [
                    x - 0.11 * f64::sin(f64::to_radians(lean)),
                    0.1 + 0.11 * f64::cos(f64::to_radians(lean)),
                ];
                drum.push(part(
                    "sphere",
                    [0.045, 0.045, 0.045],
                    [top[0], top[1], -0.26],
                    accent,
                ));
            }
            drum
        }
        // A round bear with ears, a muzzle, a nose, eyes and a bow.
        Design::Teddy => {
            let mut teddy = vec![part(
                "sphere",
                [0.34, 0.32, 0.24],
                [0.0, -0.02, -0.14],
                body,
            )];
            for x in [-0.12, 0.12] {
                teddy.push(part("sphere", [0.11, 0.11, 0.07], [x, 0.14, -0.14], body));
                teddy.push(part("sphere", [0.06, 0.06, 0.02], [x, 0.14, -0.18], light));
                teddy.push(part(
                    "sphere",
                    [0.035, 0.035, 0.02],
                    [x * 0.55, 0.04, -0.255],
                    INK,
                ));
            }
            teddy.extend([
                part("sphere", [0.14, 0.1, 0.06], [0.0, -0.05, -0.255], light),
                part("sphere", [0.045, 0.035, 0.025], [0.0, -0.025, -0.29], INK),
                part("round", [0.12, 0.05, 0.03], [0.0, -0.13, -0.235], accent),
            ]);
            teddy
        }
    };
    parts.extend(straps(dark));
    let asset = json!({
        "name": format!("{name}'s {}", design.called()),
        "kind": "accessory",
        "slot": "back",
        "parts": parts,
    });
    (design, asset)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::island::model::{Kind, Slot};
    use crate::island::rules::{asset_bounds, check_asset};
    use crate::island::starter::bot_look;

    #[test]
    fn every_design_for_every_trait_is_a_backpack_the_host_takes() {
        let mut seen = std::collections::BTreeSet::new();
        for seed in 0..400 {
            let mut rng = Rng::new(seed);
            let look = bot_look(&mut rng);
            let character = Trait::ALL[seed as usize % Trait::ALL.len()];
            let (design, pack) = backpack(&mut rng, character, "Pip", &look);
            seen.insert(design);
            let (draft, _) = check_asset(pack.clone())
                .unwrap_or_else(|why| panic!("{design:?} for {character:?}: {why}"));
            assert_eq!(
                (draft.kind, draft.slot),
                (Kind::Accessory, Some(Slot::Back))
            );
            assert_eq!(draft.name, format!("Pip's {}", design.called()));
            // It reads behind a chibi with a big head: about a third of a
            // metre across and tall, hanging back to about -0.3.
            let bounds = asset_bounds(&draft.parts);
            let size = bounds.size();
            assert!(
                (0.3..=0.42).contains(&size[0]),
                "{design:?} is {} wide",
                size[0]
            );
            assert!(
                (0.26..=0.5).contains(&size[1]),
                "{design:?} is {} tall",
                size[1]
            );
            assert!(
                bounds.min[2] >= -0.32 && bounds.max[2] <= 0.005,
                "{design:?}: {bounds:?}"
            );
            assert!(
                bounds.min[1] >= -0.26 && bounds.max[1] <= 0.24,
                "{design:?}: {bounds:?}"
            );
            // In its own colours.
            assert!(pack.to_string().contains(&look.trim), "{design:?}");
        }
        assert_eq!(seen.len(), Design::ALL.len(), "every design comes up");
    }

    #[test]
    fn a_trait_leans_towards_its_designs_and_two_packs_usually_differ() {
        let share = |character: Trait, design: Design| {
            let mut rng = Rng::new(7);
            (0..3000)
                .filter(|_| choose(&mut rng, character) == design)
                .count() as f64
                / 3000.0
        };
        assert!(share(Trait::Gardener, Design::FlowerPot) > 0.35);
        assert!(share(Trait::Foodie, Design::FlowerPot) < 0.15);
        assert!(
            share(Trait::Tinkerer, Design::Toolbox) > share(Trait::Tinkerer, Design::Teddy) * 3.0
        );
        // Any trait may still choose any design.
        for character in Trait::ALL {
            for design in Design::ALL {
                assert!(share(*character, design) > 0.0, "{character:?} {design:?}");
            }
        }
        // Two 波特 of random traits mostly carry different packs.
        let mut rng = Rng::new(11);
        let same = (0..2000)
            .filter(|_| {
                let a = *rng.pick(Trait::ALL);
                let b = *rng.pick(Trait::ALL);
                choose(&mut rng, a) == choose(&mut rng, b)
            })
            .count();
        assert!(same < 500, "{same} of 2000 pairs matched");
    }
}
