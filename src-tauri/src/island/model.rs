//! What `island.json` holds, field for field as `docs/island.md` names it.
//!
//! The page reads this shape as it is written (`island_get` answers the
//! island whole), so a field here is a field of the contract. Nothing in the
//! file is derived for an answer except `radius`, which is worked out from
//! the plots on every save, and `brief` on an open wish, which is added to the
//! answer and never stored.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The file's own version. A file of another version is refused rather than
/// read as this one.
pub const VERSION: u32 = 1;

/// A closed set of words, spelled as the file and the tools spell them.
macro_rules! words {
    ($(#[$meta:meta])* $name:ident { $($variant:ident = $word:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $word)] $variant),+
        }

        // Every set of words gets the same helpers; not every set needs all.
        #[allow(dead_code)]
        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            pub fn word(self) -> &'static str {
                match self {
                    $($name::$variant => $word),+
                }
            }

            /// The word an agent wrote, in any case and with spaces round it.
            pub fn parse(text: &str) -> Option<Self> {
                match text.trim().to_ascii_lowercase().as_str() {
                    $($word => Some($name::$variant),)+
                    _ => None,
                }
            }

            /// Every word, for a refusal that says what would do.
            pub fn words() -> String {
                Self::ALL
                    .iter()
                    .map(|word| word.word())
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        }
    };
}

words!(
    /// What an asset is for. Only furniture, decor and buildings are placed;
    /// an accessory is worn.
    Kind {
        Accessory = "accessory",
        Furniture = "furniture",
        Decor = "decor",
        Building = "building",
    }
);

words!(
    /// Where an accessory is worn.
    Slot {
        Head = "head",
        Face = "face",
        Neck = "neck",
        Back = "back",
        Hand = "hand",
    }
);

words!(
    /// What a robot does at a piece of furniture or decor. `none`, the
    /// default, is no word at all: it is left out of the file.
    Use {
        Seat = "seat",
        Desk = "desk",
        Bed = "bed",
    }
);

words!(
    /// The one shape a part is, scaled to its box.
    Shape {
        Block = "box",
        Round = "round",
        Cylinder = "cylinder",
        Cone = "cone",
        Sphere = "sphere",
        Torus = "torus",
        Wedge = "wedge",
    }
);

words!(
    Finish {
        Matte = "matte",
        Soft = "soft",
        Shiny = "shiny",
        Metal = "metal",
        Glass = "glass",
        Glow = "glow",
    }
);

words!(
    /// A robot's head and body proportions.
    Frame {
        Round = "round",
        Boxy = "boxy",
        Slim = "slim",
        Stout = "stout",
    }
);

words!(
    Eyes {
        Pill = "pill",
        Round = "round",
        Happy = "happy",
        Sleepy = "sleepy",
        Star = "star",
        Heart = "heart",
        Visor = "visor",
        Chevron = "chevron",
    }
);

words!(
    /// `none` is a robot with no antenna, which is a look of its own; an
    /// agent's look that never set one is the page's default instead.
    Antenna {
        Ball = "ball",
        Halo = "halo",
        Crown = "crown",
        Star = "star",
        Leaf = "leaf",
        Moon = "moon",
        Twin = "twin",
        Sun = "sun",
        Spark = "spark",
        Bar = "bar",
        Sprout = "sprout",
        Bare = "none",
    }
);

words!(
    /// An island bot's character, which flavours what it wishes for.
    Trait {
        Cozy = "cozy",
        Curious = "curious",
        Sporty = "sporty",
        Artsy = "artsy",
        Tinkerer = "tinkerer",
        Dreamy = "dreamy",
        Foodie = "foodie",
        Gardener = "gardener",
    }
);

words!(
    Want {
        Accessory = "accessory",
        Furniture = "furniture",
        Decor = "decor",
        Building = "building",
        Look = "look",
    }
);

words!(
    /// Who a plot or a wish belongs to. A plot is an agent's or a home
    /// (shared by up to four 波特); a wish is an agent's or a bot's.
    OwnerKind {
        Agent = "agent",
        Bot = "bot",
        Home = "home",
    }
);

words!(
    WishState {
        Open = "open",
        Granted = "granted",
        Dismissed = "dismissed",
    }
);

words!(
    /// How often a resident makes a wish, as the person sets it.
    WishPace {
        Often = "often",
        Sometimes = "sometimes",
        Rarely = "rarely",
        Never = "never",
    }
);

// Written by hand: `words!` makes the enum, and has no word for a default.
#[allow(clippy::derivable_impls)]
impl Default for WishPace {
    fn default() -> Self {
        WishPace::Sometimes
    }
}

impl Kind {
    /// The wish an asset of this kind grants.
    pub fn want(self) -> Want {
        match self {
            Kind::Accessory => Want::Accessory,
            Kind::Furniture => Want::Furniture,
            Kind::Decor => Want::Decor,
            Kind::Building => Want::Building,
        }
    }

    pub fn placed(self) -> bool {
        self != Kind::Accessory
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Island {
    pub version: u32,
    /// Every saved change moves it on by one.
    pub rev: u64,
    /// The island's own randomness. Kept under 2^31 so a page can hand it to
    /// a 32-bit generator as it is.
    pub seed: u64,
    pub created_at: i64,
    pub updated_at: i64,
    /// The land's radius, worked out from the plots on every save.
    pub radius: f64,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub plots: Vec<Plot>,
    #[serde(default)]
    pub bots: Vec<Bot>,
    /// A registered agent's look, as a patch over the page's defaults for it.
    #[serde(default)]
    pub looks: BTreeMap<String, LookPatch>,
    #[serde(default)]
    pub assets: Vec<Asset>,
    #[serde(default)]
    pub placed: Vec<Placement>,
    #[serde(default)]
    pub wishes: Vec<Wish>,
    /// When the wish thread last saved a look. A server that was off picks up
    /// from here, at most an hour back.
    #[serde(default)]
    pub last_roll_at: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub wish_pace: WishPace,
}

/// Who a plot or a wish belongs to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    pub kind: OwnerKind,
    pub id: String,
}

impl Owner {
    pub fn agent(id: &str) -> Self {
        Self {
            kind: OwnerKind::Agent,
            id: id.to_owned(),
        }
    }

    pub fn bot(id: &str) -> Self {
        Self {
            kind: OwnerKind::Bot,
            id: id.to_owned(),
        }
    }
}

/// A hexagonal tile of the honeycomb (`layout.rs`): a registered agent's
/// own, or a home its members share.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plot {
    pub id: String,
    pub owner: Owner,
    /// A home's 波特, by id, in the order they moved in. None on an agent's
    /// plot.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<String>,
    pub ring: u32,
    pub slot: u32,
    /// Its cell, in axial coordinates.
    pub q: i32,
    pub r: i32,
    /// Its centre, in world metres.
    pub x: f64,
    pub z: f64,
    /// The yaw in degrees of its `+z`: the flat edge that faces the plaza.
    pub facing: f64,
    /// The tile's centre-to-corner.
    pub radius: f64,
    pub claimed_at: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bot {
    pub id: String,
    pub name: String,
    pub r#trait: Trait,
    /// Whole: every field set.
    pub look: Look,
    /// The plot of the home it lives in.
    #[serde(default)]
    pub home: String,
    pub arrived_at: i64,
}

/// A whole look, as a bot has one.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Look {
    pub frame: Frame,
    pub shell: String,
    pub trim: String,
    pub glow: String,
    pub eyes: Eyes,
    pub antenna: Antenna,
    /// Per slot, the id of the accessory asset worn there.
    #[serde(default)]
    pub worn: BTreeMap<Slot, String>,
}

/// A look as a registered agent keeps it: what it set, over the page's
/// defaults for the rest.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<Frame>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trim: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glow: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eyes: Option<Eyes>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub antenna: Option<Antenna>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub worn: BTreeMap<Slot, String>,
}

/// One shape scaled to a box, in its asset's own coordinates.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub shape: Shape,
    pub size: [f64; 3],
    /// The centre of the part's box.
    pub at: [f64; 3],
    /// Degrees about x, y and z, as three.js applies an `XYZ` Euler.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<[f64; 3]>,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish: Option<Finish>,
}

/// Where a robot sits (its hips) or stands (its feet), in the asset's own
/// coordinates, and the way it faces.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spot {
    pub at: [f64; 3],
    pub face: f64,
}

/// Who made an asset or granted a wish: a registered agent, else a chat.
/// The island's own starter assets name neither, and nor does a 波特's own
/// backpack, which is made under the 波特's name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Maker {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_key: Option<String>,
}

/// The name the island's own starter assets are made under.
pub const ISLAND_MAKER: &str = "Island";

impl Maker {
    pub fn island() -> Self {
        Self {
            name: ISLAND_MAKER.into(),
            agent_id: None,
            chat_key: None,
        }
    }

    /// A 波特 making its own backpack.
    pub fn bot(name: &str) -> Self {
        Self {
            name: name.into(),
            agent_id: None,
            chat_key: None,
        }
    }

    pub fn is_island(&self) -> bool {
        self.key().is_none() && self.name == ISLAND_MAKER
    }

    /// The one maker an asset's limits are counted against: the agent when
    /// there is one, else the chat. `None` for the island itself and for a
    /// 波特: what they made is nobody else's to rebuild, give or place.
    pub fn key(&self) -> Option<String> {
        match (&self.agent_id, &self.chat_key) {
            (Some(agent), _) => Some(format!("agent:{agent}")),
            (None, Some(chat)) => Some(format!("chat:{chat}")),
            (None, None) => None,
        }
    }

    /// Whether two makers are the same agent, else the same chat.
    pub fn same(&self, other: &Maker) -> bool {
        self.key().is_some() && self.key() == other.key()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,
    /// Moves on when the asset is rebuilt.
    pub rev: u64,
    pub name: String,
    pub kind: Kind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<Slot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#use: Option<Use>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spot: Option<Spot>,
    pub parts: Vec<Part>,
    pub by: Maker,
    pub made_at: i64,
    pub updated_at: i64,
}

/// An asset standing on a plot, in the plot's own coordinates.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub id: String,
    pub plot: String,
    pub asset: String,
    pub x: f64,
    pub z: f64,
    /// 0 to 1.2, to stand something on a table.
    pub y: f64,
    /// Degrees about y.
    pub turn: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Wish {
    pub id: String,
    pub who: Owner,
    pub want: Want,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<Slot>,
    /// The host's words, one line of at most 140 characters, read after
    /// "<name> wishes for".
    pub text: String,
    pub made_at: i64,
    pub state: WishState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant: Option<Grant>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub look: bool,
    pub by: Maker,
    pub at: i64,
}
