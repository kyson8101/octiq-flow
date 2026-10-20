//! What a robot wishes for, how often, and the brief a granting chat starts
//! with.
//!
//! A wish is one of the host's templates: a thing (by want and slot), one
//! colour or material, and one reason, written to be read after "<name>
//! wishes for". A resident's trait leans it towards some things (a gardener
//! towards flower beds, a tinkerer towards a workbench) without ruling the
//! rest out.
use super::layout::Rng;
use super::model::{Slot, Trait, Want, Wish, WishPace};

/// The longest a wish's text may be.
pub const TEXT_MAX: usize = 140;

/// The most time one look counts, so a server that was off does not wake
/// to a flood of wishes.
pub const LOOK_MAX_MS: i64 = 60 * 60 * 1000;

const HOUR_MS: f64 = 60.0 * 60.0 * 1000.0;

impl WishPace {
    /// The mean time between a resident's wishes, or `None` for never.
    pub fn hours(self) -> Option<f64> {
        match self {
            WishPace::Often => Some(2.0),
            WishPace::Sometimes => Some(8.0),
            WishPace::Rarely => Some(24.0),
            WishPace::Never => None,
        }
    }
}

/// The chance a resident with no open wish makes one in a look `dt_ms` after
/// the last: `1 - exp(-dt / pace)`, with `dt` at most an hour.
pub fn roll_probability(dt_ms: i64, pace: WishPace) -> f64 {
    let Some(hours) = pace.hours() else {
        return 0.0;
    };
    let dt = dt_ms.clamp(0, LOOK_MAX_MS) as f64;
    1.0 - (-dt / (hours * HOUR_MS)).exp()
}

/// Colours for cloth, paint and plastic.
const FABRIC: &[&str] = &[
    "mustard-yellow",
    "mint-green",
    "coral",
    "lavender",
    "sky-blue",
    "cherry-red",
    "peach",
    "teal",
    "sunflower-yellow",
    "plum",
    "rose-pink",
    "forest-green",
    "honey",
    "lilac",
    "tangerine",
    "seafoam",
    "cream",
    "navy",
    "amber",
    "indigo",
    "olive-green",
    "apricot",
    "polka-dot",
    "striped",
];

/// Wood and wood paint.
const WOOD: &[&str] = &[
    "oak",
    "birch",
    "walnut",
    "bamboo",
    "driftwood",
    "cherry-wood",
    "pine",
    "cedar",
    "wicker",
    "rattan",
    "pastel-blue",
    "sage-green",
    "butter-yellow",
    "white-painted",
];

const METAL: &[&str] = &[
    "copper",
    "brass",
    "silver",
    "tin",
    "rose-gold",
    "bronze",
    "sky-blue",
    "mint-green",
];

const BLOOM: &[&str] = &[
    "sunflower",
    "tulip-red",
    "lavender",
    "marigold",
    "poppy-red",
    "daisy-white",
    "bluebell",
    "pink-rose",
    "buttercup",
    "violet",
];

const LAMP: &[&str] = &[
    "amber-glass",
    "frosted",
    "paper",
    "copper",
    "brass",
    "moon-white",
    "lantern-red",
    "sea-glass",
];

const PAINT: &[&str] = &[
    "peach",
    "mint",
    "sky-blue",
    "butter-yellow",
    "lilac",
    "coral",
    "sage",
    "rose",
    "cream",
    "seafoam",
    "apricot",
    "lavender",
];

/// One thing a robot may wish for. `{a}` is "a" or "an", whichever the
/// colour or material `{c}` takes.
pub struct Template {
    pub want: Want,
    pub slot: Option<Slot>,
    pub phrase: &'static str,
    pub palette: &'static [&'static str],
    /// The traits it suits; anyone may still wish for it.
    pub traits: &'static [Trait],
    pub reasons: &'static [&'static str],
}

use Trait::*;

const fn t(
    want: Want,
    slot: Option<Slot>,
    phrase: &'static str,
    palette: &'static [&'static str],
    traits: &'static [Trait],
    reasons: &'static [&'static str],
) -> Template {
    Template {
        want,
        slot,
        phrase,
        palette,
        traits,
        reasons,
    }
}

const HEAD: Option<Slot> = Some(Slot::Head);
const FACE: Option<Slot> = Some(Slot::Face);
const NECK: Option<Slot> = Some(Slot::Neck);
const BACK: Option<Slot> = Some(Slot::Back);
const HAND: Option<Slot> = Some(Slot::Hand);
const A: Want = Want::Accessory;
const F: Want = Want::Furniture;
const D: Want = Want::Decor;
const B: Want = Want::Building;

pub const TEMPLATES: &[Template] = &[
    t(
        A,
        HEAD,
        "{a} {c} sun hat",
        FABRIC,
        &[Gardener, Sporty, Dreamy],
        &[
            "the noon sun is bright on the veg patch",
            "the beach walk gets so sunny",
            "it would shade the afternoon naps",
        ],
    ),
    t(
        A,
        HEAD,
        "{a} {c} bobble hat",
        FABRIC,
        &[Cozy],
        &[
            "the evenings by the sea are chilly",
            "its antenna gets cold at night",
        ],
    ),
    t(
        A,
        HEAD,
        "{a} {c} beret",
        FABRIC,
        &[Artsy],
        &[
            "every painter needs one",
            "to feel properly artistic at the easel",
        ],
    ),
    t(
        A,
        HEAD,
        "{a} {c} cap",
        FABRIC,
        &[Sporty],
        &[
            "for the morning runs round the plaza",
            "to keep the sun out of its eyes",
        ],
    ),
    t(
        A,
        HEAD,
        "{a} {c} chef's hat",
        FABRIC,
        &[Foodie],
        &["the pancakes deserve it", "to look the part at the café"],
    ),
    t(
        A,
        HEAD,
        "{a} {c} flower crown",
        BLOOM,
        &[Gardener, Dreamy, Artsy],
        &[
            "the spring fair is coming",
            "it wants to smell like the meadow",
        ],
    ),
    t(
        A,
        FACE,
        "a pair of {c} round glasses",
        METAL,
        &[Curious, Tinkerer, Artsy],
        &[
            "the small print on the maps is hard to read",
            "to look clever at the library",
        ],
    ),
    t(
        A,
        FACE,
        "a pair of {c} goggles",
        METAL,
        &[Tinkerer, Sporty],
        &["sparks fly at the workbench", "for diving off the pier"],
    ),
    t(
        A,
        FACE,
        "a pair of {c} sunglasses",
        FABRIC,
        &[Sporty, Dreamy],
        &[
            "the sea glitters too much at noon",
            "to look cool at the beach",
        ],
    ),
    t(
        A,
        NECK,
        "{a} {c} scarf",
        FABRIC,
        &[Cozy, Dreamy],
        &[
            "the cliff path gets windy at night",
            "the sea breeze is nippy in the morning",
        ],
    ),
    t(
        A,
        NECK,
        "{a} {c} bow tie",
        FABRIC,
        &[Artsy, Foodie],
        &[
            "for the dinner party on Friday",
            "to look dapper at the café",
        ],
    ),
    t(
        A,
        NECK,
        "{a} {c} bandana",
        FABRIC,
        &[Sporty, Gardener, Curious],
        &[
            "for the long hikes up the hill",
            "to mop its visor while digging",
        ],
    ),
    t(
        A,
        BACK,
        "{a} {c} backpack",
        FABRIC,
        &[Curious, Sporty],
        &[
            "the caves on the north shore need exploring",
            "to carry snacks on long walks",
        ],
    ),
    t(
        A,
        BACK,
        "{a} {c} cape",
        FABRIC,
        &[Dreamy, Artsy],
        &[
            "it dreams of flying over the island",
            "for the costume parade",
        ],
    ),
    t(
        A,
        BACK,
        "a pair of {c} wings",
        FABRIC,
        &[Dreamy],
        &[
            "to feel the wind like the gulls do",
            "it saw a gull and got ideas",
        ],
    ),
    t(
        A,
        HAND,
        "{a} {c} lantern",
        LAMP,
        &[Curious, Dreamy, Cozy],
        &[
            "for the night walks to the lighthouse",
            "the path home is dark after sunset",
        ],
    ),
    t(
        A,
        HAND,
        "{a} {c} watering can",
        METAL,
        &[Gardener],
        &[
            "the seedlings are thirsty",
            "carrying water in its hands is slow",
        ],
    ),
    t(
        A,
        HAND,
        "{a} {c} paintbrush",
        WOOD,
        &[Artsy],
        &[
            "the sunset needs painting",
            "its old brush lost its bristles",
        ],
    ),
    t(
        A,
        HAND,
        "{a} {c} wrench",
        METAL,
        &[Tinkerer],
        &[
            "something is always coming loose",
            "the gears in the old clock need tightening",
        ],
    ),
    t(
        A,
        HAND,
        "{a} {c} magnifying glass",
        METAL,
        &[Curious],
        &[
            "there are tiny shells to study on the beach",
            "to look at the ants up close",
        ],
    ),
    t(
        A,
        HAND,
        "{a} {c} teacup",
        FABRIC,
        &[Foodie, Cozy],
        &[
            "afternoon tea is a serious matter",
            "to share tea with a neighbour",
        ],
    ),
    t(
        A,
        HAND,
        "{a} {c} umbrella",
        FABRIC,
        &[Dreamy, Cozy],
        &[
            "the rain clouds keep sneaking up",
            "for walks in the drizzle",
        ],
    ),
    t(
        F,
        None,
        "{a} {c} armchair",
        FABRIC,
        &[Cozy, Dreamy],
        &["for reading by the window", "to sink into after a long day"],
    ),
    t(
        F,
        None,
        "{a} {c} rocking chair",
        WOOD,
        &[Cozy],
        &[
            "for watching the waves roll in",
            "its old seat creaks too much",
        ],
    ),
    t(
        F,
        None,
        "{a} {c} stool",
        WOOD,
        &[Tinkerer, Artsy, Foodie],
        &["to sit at the workbench", "for sitting at the easel"],
    ),
    t(
        F,
        None,
        "{a} {c} bench",
        WOOD,
        &[Sporty, Gardener],
        &["to rest after a run", "to sit among the flowers"],
    ),
    t(
        F,
        None,
        "{a} {c} workbench",
        WOOD,
        &[Tinkerer],
        &[
            "the kitchen table is covered in gears",
            "it has a gadget to finish",
        ],
    ),
    t(
        F,
        None,
        "{a} {c} café table",
        WOOD,
        &[Foodie, Cozy],
        &[
            "for croissants in the morning sun",
            "to invite a neighbour for tea",
        ],
    ),
    t(
        F,
        None,
        "{a} {c} writing desk",
        WOOD,
        &[Curious, Artsy, Dreamy],
        &["its notebooks need a home", "to write letters to the sea"],
    ),
    t(
        F,
        None,
        "{a} {c} hammock",
        FABRIC,
        &[Dreamy, Cozy],
        &["for naps between two palm trees", "to sway to sleep"],
    ),
    t(
        F,
        None,
        "{a} {c} bookshelf",
        WOOD,
        &[Curious, Cozy],
        &[
            "the books are piled on the floor",
            "it borrowed too many from the library",
        ],
    ),
    t(
        D,
        None,
        "{a} {c} flower bed",
        BLOOM,
        &[Gardener],
        &[
            "the path to the beach looks bare",
            "the bees need somewhere to visit",
        ],
    ),
    t(
        D,
        None,
        "{a} {c} planter",
        WOOD,
        &[Gardener, Cozy],
        &[
            "for the herbs on the windowsill",
            "the mint is taking over the garden",
        ],
    ),
    t(
        D,
        None,
        "{a} {c} lamp",
        LAMP,
        &[Cozy, Dreamy, Curious],
        &[
            "the evenings are getting darker",
            "to read late into the night",
        ],
    ),
    t(
        D,
        None,
        "{a} {c} telescope",
        METAL,
        &[Dreamy, Curious],
        &[
            "the stars over the island are dazzling",
            "a comet is due next week",
        ],
    ),
    t(
        D,
        None,
        "{a} {c} easel",
        WOOD,
        &[Artsy],
        &["the light at dusk is perfect", "the sea wants painting"],
    ),
    t(
        D,
        None,
        "{a} {c} bike rack",
        METAL,
        &[Sporty],
        &["the bikes keep falling over", "a new bike is on its way"],
    ),
    t(
        D,
        None,
        "{a} {c} birdbath",
        PAINT,
        &[Gardener, Dreamy],
        &["the gulls look thirsty", "to watch the birds splash about"],
    ),
    t(
        D,
        None,
        "{a} {c} signpost",
        WOOD,
        &[Curious],
        &[
            "visitors keep getting lost",
            "to point the way to the beach",
        ],
    ),
    t(
        D,
        None,
        "{a} {c} barbecue grill",
        METAL,
        &[Foodie, Sporty],
        &[
            "for sausages by the sea",
            "the whole island is invited on Sunday",
        ],
    ),
    t(
        D,
        None,
        "{a} {c} wind chime",
        METAL,
        &[Dreamy, Artsy],
        &["to hear the breeze sing", "the nights are too quiet"],
    ),
    t(
        D,
        None,
        "{a} {c} toolbox",
        METAL,
        &[Tinkerer],
        &[
            "its tools are scattered everywhere",
            "a spanner went missing again",
        ],
    ),
    t(
        B,
        None,
        "a little roofless greenhouse, painted {c}",
        PAINT,
        &[Gardener],
        &[
            "the seedlings need somewhere sheltered",
            "the tomatoes want the sun",
        ],
    ),
    t(
        B,
        None,
        "a little roofless studio, painted {c}",
        PAINT,
        &[Artsy],
        &[
            "the light here is perfect for painting",
            "its canvases need a home",
        ],
    ),
    t(
        B,
        None,
        "a little roofless reading nook, painted {c}",
        PAINT,
        &[Cozy, Curious, Dreamy],
        &[
            "for quiet afternoons with a book",
            "the library is too far to walk",
        ],
    ),
    t(
        B,
        None,
        "a little roofless tool shed, painted {c}",
        PAINT,
        &[Tinkerer, Gardener],
        &[
            "the tools need a home of their own",
            "the spades are lying all over the garden",
        ],
    ),
    t(
        B,
        None,
        "a little open-air café, painted {c}",
        PAINT,
        &[Foodie],
        &[
            "to serve tea to the whole island",
            "the pastries deserve a proper home",
        ],
    ),
    t(
        B,
        None,
        "a little roofless lookout, painted {c}",
        PAINT,
        &[Curious, Sporty, Dreamy],
        &[
            "to watch the boats come in",
            "the whales pass by in the spring",
        ],
    ),
];

/// The shell and trim names a look wish asks for.
const LOOK_SHELLS: &[&str] = &[
    "mint",
    "peach",
    "lilac",
    "butter-yellow",
    "sky-blue",
    "coral",
    "cream",
    "seafoam",
    "rose",
    "sage",
];
const LOOK_TRIMS: &[&str] = &[
    "coral",
    "navy",
    "teal",
    "plum",
    "sunflower",
    "cherry-red",
    "forest-green",
    "tangerine",
    "indigo",
    "copper",
];
const LOOK_REASONS: &[&str] = &[
    "the sea air has dulled the old one",
    "the summer fair is coming",
    "a new season wants new colours",
    "it fancies a whole new look",
];

/// How often a wish is for a fresh coat of paint, and how often it follows
/// the resident's trait.
const LOOK_SHARE: f64 = 0.1;
const TRAIT_SHARE: f64 = 0.7;

fn article(word: &str) -> &'static str {
    match word.chars().next() {
        Some('a' | 'e' | 'i' | 'o' | 'u') => "an",
        _ => "a",
    }
}

/// A template's text with this colour or material and reason.
pub fn written(template: &Template, colour: &str, reason: &str) -> String {
    let phrase = template
        .phrase
        .replace("{a}", article(colour))
        .replace("{c}", colour);
    format!("{phrase} — {reason}")
}

/// A look wish's text.
pub fn look_text(shell: &str, trim: &str, reason: &str) -> String {
    format!("a fresh coat of paint, {shell} with {trim} trim — {reason}")
}

/// What a resident with this trait wishes for: the want, its slot, and the
/// words.
pub fn make(rng: &mut Rng, character: Trait) -> (Want, Option<Slot>, String) {
    if rng.unit() < LOOK_SHARE {
        let text = look_text(
            rng.pick(LOOK_SHELLS),
            rng.pick(LOOK_TRIMS),
            rng.pick(LOOK_REASONS),
        );
        return (Want::Look, None, text);
    }
    let suited: Vec<&Template> = TEMPLATES
        .iter()
        .filter(|template| template.traits.contains(&character))
        .collect();
    let template = if !suited.is_empty() && rng.unit() < TRAIT_SHARE {
        *rng.pick(&suited)
    } else {
        rng.pick(TEMPLATES)
    };
    let text = written(
        template,
        rng.pick(template.palette),
        rng.pick(template.reasons),
    );
    // Every template, colour and reason together is held under the limit by
    // a test; this is what that test guards.
    debug_assert!(text.chars().count() <= TEXT_MAX, "{text}");
    (template.want, template.slot, text)
}

/// The message the page puts in a new chat's composer when the person grants
/// a wish: which wish, whose, what, and the three tools. Derived for an open
/// wish on every answer, never stored. An island bot is a 波特 in every word
/// the person or an agent reads; only the data says `bot`.
pub const PUBLIC_PROJECTS: [&str; 4] = [
    "a public concert pavilion where everyone can perform together",
    "a public games arcade for the whole island",
    "a public garden pavilion with new landscaping for everyone",
    "a public library and lounge for every team",
];

pub fn public_project(wish: &Wish) -> bool {
    wish.want == Want::Building
        && (PUBLIC_PROJECTS.contains(&wish.text.as_str())
            || wish.text.starts_with("a public island project: "))
}

pub fn brief(wish: &Wish, name: &str, character: Option<Trait>) -> String {
    if public_project(wish) {
        return format!("Lead {name} proposes {} (wish {}). Build a public island improvement, not a private home: call island_look with wishId first, make a building with island_build, then island_grant with wishId and assetId. The host gives it a new public plot, preserving offices, gifts and the playground. Include decorative landscaping as building parts when appropriate.", wish.text, wish.id);
    }
    let who = match character {
        Some(character) => format!("{name}, a 波特 ({}),", character.word()),
        None => name.to_owned(),
    };
    let id = &wish.id;
    let text = &wish.text;
    match (wish.want, wish.slot) {
        (Want::Look, _) => format!(
            "On the island, {who} wishes for {text} (wish {id}). Please grant it: call island_look with wishId \"{id}\" first to see {name}'s robot, then give it the new colours with island_grant, passing that wishId and a look (frame, shell, trim, glow, eyes, antenna). A look needs no island_build."
        ),
        (want, slot) => format!(
            "On the island, {who} wishes for {text} (wish {id}). Please make it as a present: call island_look with wishId \"{id}\" first for the building guide and {name}'s plot, then build it with island_build as kind \"{}\"{}. Then give it with island_grant, passing that wishId and the new assetId.",
            want.word(),
            slot.map(|slot| format!(" in slot \"{}\"", slot.word()))
                .unwrap_or_default()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::island::model::{Owner, WishState};

    #[test]
    fn every_wish_the_templates_can_write_is_one_line_of_at_most_140_characters() {
        let mut longest = String::new();
        for template in TEMPLATES {
            assert!(!template.reasons.is_empty() && !template.palette.is_empty());
            assert_eq!(
                template.slot.is_some(),
                template.want == Want::Accessory,
                "{}",
                template.phrase
            );
            for colour in template.palette {
                for reason in template.reasons {
                    let text = written(template, colour, reason);
                    assert!(text.starts_with("a ") || text.starts_with("an "), "{text}");
                    assert!(!text.contains('{') && !text.contains('\n'), "{text}");
                    if text.chars().count() > longest.chars().count() {
                        longest = text;
                    }
                }
            }
        }
        for shell in LOOK_SHELLS {
            for trim in LOOK_TRIMS {
                for reason in LOOK_REASONS {
                    let text = look_text(shell, trim, reason);
                    if text.chars().count() > longest.chars().count() {
                        longest = text;
                    }
                }
            }
        }
        assert!(longest.chars().count() <= TEXT_MAX, "{longest}");
        assert_eq!(
            written(
                &TEMPLATES[9],
                "mustard-yellow",
                "the cliff path gets windy at night"
            ),
            "a mustard-yellow scarf — the cliff path gets windy at night"
        );
        assert_eq!(written(&TEMPLATES[9], "amber", "x"), "an amber scarf — x");
    }

    #[test]
    fn every_trait_leans_towards_something_of_its_own() {
        for character in Trait::ALL {
            assert!(
                TEMPLATES
                    .iter()
                    .filter(|t| t.traits.contains(character))
                    .count()
                    >= 4,
                "{}",
                character.word()
            );
        }
        // And over many wishes, a gardener wishes for flower beds more than a
        // tinkerer does, and every want comes up.
        let mut rng = Rng::new(9);
        let count = |rng: &mut Rng, character: Trait, phrase: &str| {
            (0..2000)
                .filter(|_| make(rng, character).2.contains(phrase))
                .count()
        };
        assert!(
            count(&mut rng, Gardener, "flower bed") > 3 * count(&mut rng, Tinkerer, "flower bed")
        );
        let wants: std::collections::BTreeSet<_> =
            (0..2000).map(|_| make(&mut rng, Cozy).0).collect();
        assert_eq!(wants.len(), Want::ALL.len());
    }

    #[test]
    fn the_chance_of_a_wish_grows_with_time_up_to_an_hour() {
        assert_eq!(roll_probability(60_000, WishPace::Never), 0.0);
        assert_eq!(roll_probability(0, WishPace::Often), 0.0);
        let minute = roll_probability(60_000, WishPace::Sometimes);
        assert!((minute - (1.0 - (-1.0f64 / 480.0).exp())).abs() < 1e-12);
        assert!(roll_probability(60_000, WishPace::Often) > minute);
        assert!(roll_probability(60_000, WishPace::Rarely) < minute);
        // A day off counts as an hour.
        assert_eq!(
            roll_probability(24 * LOOK_MAX_MS, WishPace::Often),
            roll_probability(LOOK_MAX_MS, WishPace::Often)
        );
        assert_eq!(roll_probability(-5, WishPace::Often), 0.0);
    }

    #[test]
    fn a_brief_names_the_wish_the_robot_and_the_three_tools() {
        let wish = Wish {
            id: "w_1".into(),
            who: Owner::bot("b_1"),
            want: Want::Accessory,
            slot: Some(Slot::Neck),
            text: "a mustard-yellow scarf — the cliff path gets windy at night".into(),
            made_at: 0,
            state: WishState::Open,
            grant: None,
            closed_at: None,
        };
        let said = brief(&wish, "Pip", Some(Cozy));
        for needed in [
            "w_1",
            "On the island, Pip, a 波特 (cozy), wishes for a mustard-yellow scarf",
            "a mustard-yellow scarf",
            "island_look",
            "island_build",
            "island_grant",
            "\"accessory\" in slot \"neck\"",
        ] {
            assert!(said.contains(needed), "{needed}: {said}");
        }
        assert!(said.matches(". ").count() <= 3, "{said}");
        let look = Wish {
            want: Want::Look,
            slot: None,
            text: look_text("mint", "coral", "the summer fair is coming"),
            ..wish
        };
        let said = brief(&look, "Nova", None);
        assert!(said.contains("Nova wishes for a fresh coat of paint, mint with coral trim"));
        assert!(said.contains("island_grant") && said.contains("a look"));
    }
}
