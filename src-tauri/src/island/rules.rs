//! What an agent may send: an asset, a look, a placement. Every rule of
//! `docs/island.md` is checked here, against the words the agent wrote, and a
//! refusal says which part broke which rule so the agent can fix it.
//!
//! The geometry mirrors what the page draws: a part is a box of `size`
//! centred at `at`, turned by `turn` degrees as three.js turns an `XYZ`
//! Euler (the matrix `Rx·Ry·Rz`). The bounds and the roofless rule are asked
//! of that turned box's eight corners, never of `size` alone.
use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

use super::model::*;

/// Slack for numbers that are equal on paper and differ in the last bits
/// after a sine or two. Every number is kept to the millimetre, so nothing
/// an agent can write falls inside it.
pub const EPS: f64 = 1e-6;

/// The highest a placement may be lifted, to stand on a table.
pub const PLACE_Y_MAX: f64 = 1.2;

/// How far below the ground a part's bottom may sit, but an accessory's.
pub const GROUND_SLACK: f64 = 0.05;

/// The smallest a part may be along any axis.
pub const SIZE_MIN: f64 = 0.02;

/// The longest an asset's name may be.
pub const NAME_MAX: usize = 60;

/// The roofless rule's numbers (`docs/island.md`, Buildings have no roof).
pub const THICK_ABOVE: f64 = 1.2;
pub const THICK_MAX: f64 = 0.5;
pub const HIGH_ABOVE: f64 = 1.5;
pub const HIGH_COVER_MAX: f64 = 0.15;

/// The words of every roofless refusal start with why there is a rule.
pub const ROOFLESS: &str = "Island buildings have no roof, so the person can watch inside";

/// A refusal of what the agent sent, noted as such for the hook
/// (`outcome::refuse`).
pub fn invalid(message: impl Into<String>) -> String {
    crate::outcome::refuse(crate::outcome::ReasonClass::Validation, message)
}

/// A refusal of who is asking, or of what is theirs to touch.
pub fn not_yours(message: impl Into<String>) -> String {
    crate::outcome::refuse(crate::outcome::ReasonClass::ScopeRefused, message)
}

/// A number kept to the millimetre, and never a negative zero.
pub fn mm(value: f64) -> f64 {
    let kept = (value * 1000.0).round() / 1000.0;
    if kept == 0.0 {
        0.0
    } else {
        kept
    }
}

/// Degrees in `(-180, 180]`, to the thousandth. The same turn, written once.
pub fn degrees(value: f64) -> f64 {
    let mut turned = value % 360.0;
    if turned <= -180.0 {
        turned += 360.0;
    } else if turned > 180.0 {
        turned -= 360.0;
    }
    mm(turned)
}

/// A number as a refusal writes it: to the millimetre, with no trailing
/// zeros.
pub fn show(value: f64) -> String {
    format!("{}", mm(value))
}

fn show3(value: [f64; 3]) -> String {
    format!(
        "{} × {} × {}",
        show(value[0]),
        show(value[1]),
        show(value[2])
    )
}

/// `#rrggbb` in lower case, or `None` for anything else.
pub fn colour(text: &str) -> Option<String> {
    let text = text.trim();
    let hex = text.strip_prefix('#')?;
    (hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()))
        .then(|| text.to_ascii_lowercase())
}

/// What one kind of asset is held to.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub parts: usize,
    /// Every part's turned box stays within this of the origin along x and z.
    pub half: f64,
    /// And between these along y.
    pub low: f64,
    pub high: f64,
}

impl Limits {
    pub fn of(kind: Kind) -> Self {
        match kind {
            Kind::Accessory => Limits {
                parts: 40,
                half: 0.6,
                low: -0.6,
                high: 0.9,
            },
            Kind::Furniture => Limits {
                parts: 60,
                half: 1.5,
                low: 0.0,
                high: 2.5,
            },
            Kind::Decor => Limits {
                parts: 80,
                half: 2.0,
                low: 0.0,
                high: 5.0,
            },
            Kind::Building => Limits {
                parts: 200,
                half: 5.0,
                low: 0.0,
                high: 3.0,
            },
        }
    }

    /// The kind's largest extent: the most a part may measure along an axis.
    pub fn largest(self) -> f64 {
        (2.0 * self.half).max(self.high - self.low)
    }

    /// The lowest a part's bottom may go: an accessory hangs off its anchor,
    /// anything else may sink a little into the ground.
    pub fn floor(self, kind: Kind) -> f64 {
        if kind == Kind::Accessory {
            self.low
        } else {
            -GROUND_SLACK
        }
    }

    fn says(self, kind: Kind) -> String {
        format!(
            "{} stays within x, z ±{} and y {}..{}",
            kind.word(),
            show(self.half),
            show(self.floor(kind)),
            show(self.high)
        )
    }
}

/// The matrix three.js builds for an `XYZ` Euler of these degrees:
/// `Rx·Ry·Rz`, row by row.
pub fn rotation(turn: [f64; 3]) -> [[f64; 3]; 3] {
    let (a, b) = (turn[0].to_radians().cos(), turn[0].to_radians().sin());
    let (c, d) = (turn[1].to_radians().cos(), turn[1].to_radians().sin());
    let (e, f) = (turn[2].to_radians().cos(), turn[2].to_radians().sin());
    let (ae, af, be, bf) = (a * e, a * f, b * e, b * f);
    [
        [c * e, -c * f, d],
        [af + be * d, ae - bf * d, -b * c],
        [bf - ae * d, be + af * d, a * c],
    ]
}

/// The eight corners of a part's box, turned about its centre.
pub fn corners(part: &Part) -> [[f64; 3]; 8] {
    let r = rotation(part.turn.unwrap_or([0.0; 3]));
    let half = part.size.map(|s| s / 2.0);
    let mut out = [[0.0; 3]; 8];
    for (i, corner) in out.iter_mut().enumerate() {
        let v = [
            if i & 1 == 0 { -half[0] } else { half[0] },
            if i & 2 == 0 { -half[1] } else { half[1] },
            if i & 4 == 0 { -half[2] } else { half[2] },
        ];
        for (row, value) in corner.iter_mut().enumerate() {
            *value = part.at[row] + r[row][0] * v[0] + r[row][1] * v[1] + r[row][2] * v[2];
        }
    }
    out
}

/// An axis-aligned box.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub min: [f64; 3],
    pub max: [f64; 3],
}

impl Bounds {
    fn of(points: &[[f64; 3]]) -> Self {
        let mut bounds = Bounds {
            min: [f64::INFINITY; 3],
            max: [f64::NEG_INFINITY; 3],
        };
        for point in points {
            bounds.take(point);
        }
        bounds
    }

    fn take(&mut self, point: &[f64; 3]) {
        for (axis, value) in point.iter().enumerate() {
            self.min[axis] = self.min[axis].min(*value);
            self.max[axis] = self.max[axis].max(*value);
        }
    }

    pub fn size(&self) -> [f64; 3] {
        [0, 1, 2].map(|axis| self.max[axis] - self.min[axis])
    }
}

/// A part's turned box, as an axis-aligned one.
pub fn part_bounds(part: &Part) -> Bounds {
    Bounds::of(&corners(part))
}

/// The box round every part of an asset: "the asset's whole box".
pub fn asset_bounds(parts: &[Part]) -> Bounds {
    let mut bounds = Bounds::of(&[]);
    for part in parts {
        for corner in corners(part) {
            bounds.take(&corner);
        }
    }
    bounds
}

type Point = [f64; 2];

fn cross(o: Point, a: Point, b: Point) -> f64 {
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

/// The convex hull of some points, counter-clockwise, with no point on an
/// edge.
pub fn hull(mut points: Vec<Point>) -> Vec<Point> {
    points.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    points.dedup_by(|a, b| (a[0] - b[0]).abs() < EPS && (a[1] - b[1]).abs() < EPS);
    if points.len() < 3 {
        return points;
    }
    let mut lower: Vec<Point> = Vec::new();
    for &p in &points {
        while lower.len() >= 2 && cross(lower[lower.len() - 2], lower[lower.len() - 1], p) <= EPS {
            lower.pop();
        }
        lower.push(p);
    }
    let mut upper: Vec<Point> = Vec::new();
    for &p in points.iter().rev() {
        while upper.len() >= 2 && cross(upper[upper.len() - 2], upper[upper.len() - 1], p) <= EPS {
            upper.pop();
        }
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// The area a convex polygon covers.
pub fn area(polygon: &[Point]) -> f64 {
    let n = polygon.len();
    if n < 3 {
        return 0.0;
    }
    let twice: f64 = (0..n)
        .map(|i| {
            let (a, b) = (polygon[i], polygon[(i + 1) % n]);
            a[0] * b[1] - b[0] * a[1]
        })
        .sum();
    twice.abs() / 2.0
}

/// How narrow a convex polygon is at its narrowest: the least distance
/// between two parallel lines that hold it. It is reached with one line along
/// one of its edges, so the edges are all that need asking.
pub fn narrowest(polygon: &[Point]) -> f64 {
    let n = polygon.len();
    if n < 3 {
        return 0.0;
    }
    (0..n)
        .filter_map(|i| {
            let (a, b) = (polygon[i], polygon[(i + 1) % n]);
            let length = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
            (length > EPS).then(|| {
                let normal = [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
                polygon
                    .iter()
                    .map(|p| ((p[0] - a[0]) * normal[0] + (p[1] - a[1]) * normal[1]).abs())
                    .fold(0.0, f64::max)
            })
        })
        .fold(f64::INFINITY, f64::min)
}

/// What a part covers seen from above: its turned box's corners, flattened
/// onto the ground.
pub fn footprint(part: &Part) -> Vec<Point> {
    hull(corners(part).iter().map(|c| [c[0], c[2]]).collect())
}

/// An asset that has passed every rule, made the way the file keeps it.
#[derive(Clone, Debug, PartialEq)]
pub struct Draft {
    pub name: String,
    pub kind: Kind,
    pub slot: Option<Slot>,
    pub r#use: Option<Use>,
    pub spot: Option<Spot>,
    pub parts: Vec<Part>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssetInput {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    slot: Option<String>,
    #[serde(default)]
    r#use: Option<String>,
    #[serde(default)]
    spot: Option<Value>,
    #[serde(default)]
    parts: Option<Vec<Value>>,
    /// The asset to rebuild, read by the action that builds.
    #[serde(default)]
    asset_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PartInput {
    shape: String,
    size: [f64; 3],
    at: [f64; 3],
    #[serde(default)]
    turn: Option<[f64; 3]>,
    color: String,
    #[serde(default)]
    finish: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SpotInput {
    at: [f64; 3],
    #[serde(default)]
    face: f64,
}

/// A name of one line, 1 to 60 characters once trimmed.
pub fn name(text: Option<&str>) -> Result<String, String> {
    let text = text.unwrap_or_default().trim();
    if text.is_empty() {
        return Err(invalid("Give the asset a name."));
    }
    if text.chars().any(char::is_control) {
        return Err(invalid("The asset's name must be one line of plain text."));
    }
    if text.chars().count() > NAME_MAX {
        return Err(invalid(format!(
            "The asset's name is longer than {NAME_MAX} characters."
        )));
    }
    Ok(text.to_owned())
}

fn finite(values: &[f64]) -> bool {
    values.iter().all(|v| v.is_finite())
}

/// Check an asset an agent sent, every rule of its kind, and keep it the way
/// the file does: numbers to the millimetre, turns in `(-180, 180]`, colours
/// in lower case, `use: none` left out. Also hands back the `assetId` it
/// named, if any, for a rebuild.
pub fn check_asset(input: Value) -> Result<(Draft, Option<String>), String> {
    let input: AssetInput = serde_json::from_value(match input {
        Value::Null => Value::Object(Default::default()),
        input => input,
    })
    .map_err(|e| invalid(format!("That is not an island asset: {e}.")))?;
    let name = name(input.name.as_deref())?;
    let kind_word = input.kind.unwrap_or_default();
    let kind = Kind::parse(&kind_word).ok_or_else(|| {
        invalid(format!(
            "kind \"{}\" is not one of: {}.",
            kind_word.trim(),
            Kind::words()
        ))
    })?;
    let slot = match (kind, input.slot.as_deref().map(str::trim)) {
        (Kind::Accessory, Some(word)) => Some(Slot::parse(word).ok_or_else(|| {
            invalid(format!("slot \"{word}\" is not one of: {}.", Slot::words()))
        })?),
        (Kind::Accessory, None) => {
            return Err(invalid(format!(
                "An accessory needs a slot: {}.",
                Slot::words()
            )))
        }
        (_, Some(_)) => {
            return Err(invalid(
                "Only an accessory has a slot; furniture, decor and buildings are placed.",
            ))
        }
        (_, None) => None,
    };
    let r#use = match input.r#use.as_deref().map(str::trim) {
        None => None,
        Some(_) if !matches!(kind, Kind::Furniture | Kind::Decor | Kind::Building) => {
            return Err(invalid("use is for furniture, decor and buildings only."))
        }
        Some(word) if kind == Kind::Building && matches!(word, "seat" | "desk" | "bed") => {
            return Err(invalid("use is for furniture and decor only when it is seat, desk or bed; buildings can use read, paint, garden, perform, play or observe."));
        }
        Some(word) if word.eq_ignore_ascii_case("none") => None,
        Some(word) => Some(Use::parse(word).ok_or_else(|| {
            invalid(format!(
                "use \"{word}\" is not one of: {}, none.",
                Use::words()
            ))
        })?),
    };
    let limits = Limits::of(kind);
    let given = input.parts.unwrap_or_default();
    if given.is_empty() {
        return Err(invalid("Give the asset at least one part."));
    }
    if given.len() > limits.parts {
        return Err(invalid(format!(
            "A {} is at most {} parts; this one has {}.",
            kind.word(),
            limits.parts,
            given.len()
        )));
    }
    let parts = given
        .into_iter()
        .enumerate()
        .map(|(at, part)| check_part(kind, at + 1, part))
        .collect::<Result<Vec<_>, _>>()?;
    let spot = match input.spot {
        None | Some(Value::Null) => None,
        Some(spot) => Some(check_spot(kind, r#use, spot)?),
    };
    if kind == Kind::Building {
        roofless(&parts)?;
    }
    Ok((
        Draft {
            name,
            kind,
            slot,
            r#use,
            spot,
            parts,
        },
        input
            .asset_id
            .map(|id| id.trim().to_owned())
            .filter(|id| !id.is_empty()),
    ))
}

/// One part, numbered from 1 as the refusal names it.
fn check_part(kind: Kind, number: usize, part: Value) -> Result<Part, String> {
    let part: PartInput = serde_json::from_value(part)
        .map_err(|e| invalid(format!("Part {number} is not a part: {e}.")))?;
    let shape = Shape::parse(&part.shape).ok_or_else(|| {
        invalid(format!(
            "Part {number}: shape \"{}\" is not one of: {}.",
            part.shape.trim(),
            Shape::words()
        ))
    })?;
    let turn = part.turn.unwrap_or([0.0; 3]);
    if !finite(&part.size) || !finite(&part.at) || !finite(&turn) {
        return Err(invalid(format!(
            "Part {number}: every number must be finite."
        )));
    }
    let limits = Limits::of(kind);
    let size = part.size.map(mm);
    if let Some(bad) = size
        .iter()
        .find(|s| **s < SIZE_MIN || **s > limits.largest() + EPS)
    {
        return Err(invalid(format!(
            "Part {number}: every size is {} to {} m for {} (one is {}).",
            show(SIZE_MIN),
            show(limits.largest()),
            kind.word(),
            show(*bad)
        )));
    }
    let color = colour(&part.color).ok_or_else(|| {
        invalid(format!(
            "Part {number}: color must be #rrggbb (it is \"{}\").",
            part.color.trim()
        ))
    })?;
    let finish = match part.finish.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(word) => Some(Finish::parse(word).ok_or_else(|| {
            invalid(format!(
                "Part {number}: finish \"{word}\" is not one of: {}.",
                Finish::words()
            ))
        })?),
    };
    let turn = turn.map(degrees);
    let checked = Part {
        shape,
        size,
        at: part.at.map(mm),
        turn: (turn != [0.0; 3]).then_some(turn),
        color,
        finish,
    };
    let bounds = part_bounds(&checked);
    let outside = |value: f64, low: f64, high: f64| value < low - EPS || value > high + EPS;
    let reaches = if outside(bounds.min[0], -limits.half, limits.half) {
        Some(format!("x = {}", show(bounds.min[0])))
    } else if outside(bounds.max[0], -limits.half, limits.half) {
        Some(format!("x = {}", show(bounds.max[0])))
    } else if outside(bounds.min[2], -limits.half, limits.half) {
        Some(format!("z = {}", show(bounds.min[2])))
    } else if outside(bounds.max[2], -limits.half, limits.half) {
        Some(format!("z = {}", show(bounds.max[2])))
    } else if outside(bounds.min[1], limits.floor(kind), limits.high) {
        Some(format!("y = {}", show(bounds.min[1])))
    } else if outside(bounds.max[1], limits.floor(kind), limits.high) {
        Some(format!("y = {}", show(bounds.max[1])))
    } else {
        None
    };
    if let Some(reaches) = reaches {
        return Err(invalid(format!(
            "Part {number} ({}, {} m at [{}, {}, {}]) reaches {reaches}{}; a {}.",
            shape.word(),
            show3(size),
            show(checked.at[0]),
            show(checked.at[1]),
            show(checked.at[2]),
            if checked.turn.is_some() {
                " once turned"
            } else {
                ""
            },
            limits.says(kind)
        )));
    }
    Ok(checked)
}

fn check_spot(kind: Kind, r#use: Option<Use>, spot: Value) -> Result<Spot, String> {
    if r#use.is_none() {
        return Err(invalid(
            "A spot needs a use such as seat, desk, read, paint, garden, perform, play or observe.",
        ));
    }
    let spot: SpotInput =
        serde_json::from_value(spot).map_err(|e| invalid(format!("That is not a spot: {e}.")))?;
    if !finite(&spot.at) || !spot.face.is_finite() {
        return Err(invalid("The spot's numbers must be finite."));
    }
    let at = spot.at.map(mm);
    let limits = Limits::of(kind);
    let reach = limits.half + 1.0;
    let (low, high) = (limits.floor(kind) - 1.0, limits.high + 1.0);
    if at[0].abs() > reach + EPS
        || at[2].abs() > reach + EPS
        || at[1] < low - EPS
        || at[1] > high + EPS
    {
        return Err(invalid(format!(
            "The spot is too far from the {}: keep it within 1 m of its bounds (x, z ±{}, y {}..{}).",
            kind.word(),
            show(reach),
            show(low),
            show(high)
        )));
    }
    Ok(Spot {
        at,
        face: degrees(spot.face),
    })
}

/// The two roofless rules for a building, in the words an agent can act on.
pub fn roofless(parts: &[Part]) -> Result<(), String> {
    for (index, part) in parts.iter().enumerate() {
        let bounds = part_bounds(part);
        if bounds.max[1] > THICK_ABOVE + EPS && narrowest(&footprint(part)) > THICK_MAX + EPS {
            return Err(invalid(format!(
                "{ROOFLESS}: part {} ({}, {} m, from {} to {} m up) is more than {} m thick both ways above {} m. A slab, a solid block or a sloped roof up there hides the room; keep walls, posts and beams {} m thick or less one way, and floors and big blocks below {} m.",
                index + 1,
                part.shape.word(),
                show3(part.size),
                show(bounds.min[1]),
                show(bounds.max[1]),
                show(THICK_MAX),
                show(THICK_ABOVE),
                show(THICK_MAX),
                show(THICK_ABOVE),
            )));
        }
    }
    let whole = asset_bounds(parts);
    let floor = whole.size()[0] * whole.size()[2];
    let high: Vec<(usize, f64)> = parts
        .iter()
        .enumerate()
        .filter(|(_, part)| part_bounds(part).min[1] >= HIGH_ABOVE - EPS)
        .map(|(index, part)| (index, area(&footprint(part))))
        .collect();
    let covered: f64 = high.iter().map(|(_, area)| area).sum();
    if covered > HIGH_COVER_MAX * floor + EPS {
        let (largest, _) =
            high.iter().copied().fold(
                (0, 0.0),
                |best, next| if next.1 > best.1 { next } else { best },
            );
        let part = &parts[largest];
        let bounds = part_bounds(part);
        return Err(invalid(format!(
            "{ROOFLESS}: the parts wholly above {} m cover {:.1}% of the building's floor ({} of {} m²), and at most {}% may be covered. The largest is part {} ({}, {} m, from {} to {} m up). Use fewer or thinner beams, or bring signs and lamps lower.",
            show(HIGH_ABOVE),
            covered / floor * 100.0,
            show(covered),
            show(floor),
            show(HIGH_COVER_MAX * 100.0),
            largest + 1,
            part.shape.word(),
            show3(part.size),
            show(bounds.min[1]),
            show(bounds.max[1]),
        )));
    }
    Ok(())
}

/// A change to a look, checked: each field it sets, and per slot an
/// accessory to wear (`Some`) or to take off (`None`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LookChange {
    pub frame: Option<Frame>,
    pub shell: Option<String>,
    pub trim: Option<String>,
    pub glow: Option<String>,
    pub eyes: Option<Eyes>,
    pub antenna: Option<Antenna>,
    pub worn: BTreeMap<Slot, Option<String>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LookInput {
    #[serde(default)]
    frame: Option<String>,
    #[serde(default)]
    shell: Option<String>,
    #[serde(default)]
    trim: Option<String>,
    #[serde(default)]
    glow: Option<String>,
    #[serde(default)]
    eyes: Option<String>,
    #[serde(default)]
    antenna: Option<String>,
    #[serde(default)]
    worn: Option<BTreeMap<String, Option<String>>>,
}

impl LookChange {
    pub fn is_empty(&self) -> bool {
        self == &LookChange::default()
    }

    /// Laid over an agent's patch: what it sets replaces, the rest stays.
    pub fn apply_to_patch(&self, patch: &mut LookPatch) {
        patch.frame = self.frame.or(patch.frame);
        patch.shell = self.shell.clone().or(patch.shell.take());
        patch.trim = self.trim.clone().or(patch.trim.take());
        patch.glow = self.glow.clone().or(patch.glow.take());
        patch.eyes = self.eyes.or(patch.eyes);
        patch.antenna = self.antenna.or(patch.antenna);
        wear(&mut patch.worn, &self.worn);
    }

    /// Laid over a bot's whole look.
    pub fn apply_to_look(&self, look: &mut Look) {
        look.frame = self.frame.unwrap_or(look.frame);
        look.shell = self.shell.clone().unwrap_or_else(|| look.shell.clone());
        look.trim = self.trim.clone().unwrap_or_else(|| look.trim.clone());
        look.glow = self.glow.clone().unwrap_or_else(|| look.glow.clone());
        look.eyes = self.eyes.unwrap_or(look.eyes);
        look.antenna = self.antenna.unwrap_or(look.antenna);
        wear(&mut look.worn, &self.worn);
    }
}

fn wear(worn: &mut BTreeMap<Slot, String>, change: &BTreeMap<Slot, Option<String>>) {
    for (slot, asset) in change {
        match asset {
            Some(asset) => {
                worn.insert(*slot, asset.clone());
            }
            None => {
                worn.remove(slot);
            }
        }
    }
}

/// Check a look patch. `worn` names, per slot, an accessory asset of that
/// slot that `may_wear` allows, or null (or "") to take one off.
pub fn check_look(
    input: Value,
    island: &Island,
    may_wear: &dyn Fn(&Asset) -> bool,
) -> Result<LookChange, String> {
    let input: LookInput = serde_json::from_value(match input {
        Value::Null => Value::Object(Default::default()),
        input => input,
    })
    .map_err(|e| invalid(format!("That is not a look: {e}.")))?;
    // A field left out, null or "" changes nothing.
    let given =
        |value: Option<String>| value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    let frame = match given(input.frame) {
        None => None,
        Some(word) => Some(Frame::parse(&word).ok_or_else(|| {
            invalid(format!(
                "frame \"{word}\" is not one of: {}.",
                Frame::words()
            ))
        })?),
    };
    let eyes = match given(input.eyes) {
        None => None,
        Some(word) => Some(Eyes::parse(&word).ok_or_else(|| {
            invalid(format!("eyes \"{word}\" is not one of: {}.", Eyes::words()))
        })?),
    };
    let antenna = match given(input.antenna) {
        None => None,
        Some(word) => Some(Antenna::parse(&word).ok_or_else(|| {
            invalid(format!(
                "antenna \"{word}\" is not one of: {}.",
                Antenna::words()
            ))
        })?),
    };
    let paint = |field: &str, value: Option<String>| -> Result<Option<String>, String> {
        match given(value) {
            None => Ok(None),
            Some(value) => colour(&value)
                .map(Some)
                .ok_or_else(|| invalid(format!("{field} must be #rrggbb (it is \"{value}\")."))),
        }
    };
    let mut worn = BTreeMap::new();
    for (word, asset) in input.worn.unwrap_or_default() {
        let slot = Slot::parse(&word).ok_or_else(|| {
            invalid(format!(
                "worn: \"{}\" is not a slot; the slots are {}.",
                word.trim(),
                Slot::words()
            ))
        })?;
        let asset = asset
            .map(|id| id.trim().to_owned())
            .filter(|id| !id.is_empty());
        if let Some(id) = &asset {
            let found =
                island.assets.iter().find(|a| &a.id == id).ok_or_else(|| {
                    invalid(format!("worn.{}: there is no asset {id}.", slot.word()))
                })?;
            if found.kind != Kind::Accessory || found.slot != Some(slot) {
                return Err(invalid(format!(
                    "worn.{}: {id} (\"{}\") is not an accessory for the {} slot.",
                    slot.word(),
                    found.name,
                    slot.word()
                )));
            }
            if !may_wear(found) {
                return Err(not_yours(format!(
                    "worn.{}: {id} (\"{}\") is not yours to wear: wear an accessory you made, or one you were given.",
                    slot.word(),
                    found.name
                )));
            }
        }
        worn.insert(slot, asset);
    }
    Ok(LookChange {
        frame,
        shell: paint("shell", input.shell)?,
        trim: paint("trim", input.trim)?,
        glow: paint("glow", input.glow)?,
        eyes,
        antenna,
        worn,
    })
}

/// The four corners of an asset's box seen from above, grown by `grow` on
/// every side, turned by `turn` degrees about y and moved to `(x, z)`, as
/// three.js places a group with `rotation.y = turn`.
pub fn placed_box(bounds: &Bounds, x: f64, z: f64, turn: f64, grow: f64) -> Vec<Point> {
    let (sin, cos) = turn.to_radians().sin_cos();
    let (x0, x1) = (bounds.min[0] - grow, bounds.max[0] + grow);
    let (z0, z1) = (bounds.min[2] - grow, bounds.max[2] + grow);
    [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]
        .iter()
        .map(|[lx, lz]| [x + lx * cos + lz * sin, z - lx * sin + lz * cos])
        .collect()
}

/// A point of an asset's own, placed on a plot the same way.
pub fn placed_point(point: [f64; 3], x: f64, y: f64, z: f64, turn: f64) -> [f64; 3] {
    let (sin, cos) = turn.to_radians().sin_cos();
    [
        x + point[0] * cos + point[2] * sin,
        y + point[1],
        z - point[0] * sin + point[2] * cos,
    ]
}

/// Whether an asset of these bounds, placed so, stays on its plot's tile:
/// every corner of its box after the turn. The tile is convex, so the whole
/// box is on it when its corners are.
pub fn fits_plot(bounds: &Bounds, x: f64, z: f64, turn: f64) -> bool {
    placed_box(bounds, x, z, turn, 0.0)
        .iter()
        .all(|p| super::layout::on_tile(p[0], p[1]))
}

/// Whether two convex polygons overlap by more than a touch: no edge of
/// either separates them.
pub fn overlaps(a: &[Point], b: &[Point]) -> bool {
    for polygon in [a, b] {
        let n = polygon.len();
        for i in 0..n {
            let (p, q) = (polygon[i], polygon[(i + 1) % n]);
            let length = ((q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2)).sqrt();
            if length < EPS {
                continue;
            }
            let axis = [-(q[1] - p[1]) / length, (q[0] - p[0]) / length];
            let project = |poly: &[Point]| {
                poly.iter()
                    .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), p| {
                        let d = p[0] * axis[0] + p[1] * axis[1];
                        (lo.min(d), hi.max(d))
                    })
            };
            let (a_lo, a_hi) = project(a);
            let (b_lo, b_hi) = project(b);
            if a_hi <= b_lo + EPS || b_hi <= a_lo + EPS {
                return false;
            }
        }
    }
    true
}
