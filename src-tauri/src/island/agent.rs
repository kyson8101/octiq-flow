//! The agents' door (`/hook/island` → `island_agent`): an agent looks at the
//! island, builds assets, gives a wish its present, and, when it is a
//! registered agent in its own chat, styles its robot and arranges its plot.
//!
//! Who is building is the chat's, never the arguments': the hook proves the
//! chat by its capability, and `team::lead_for_chat` names the registered
//! agent behind it (`Caller`). Any other chat builds as `{ name: "Chat",
//! chatKey }`. A worker and a room seat may only look. An asset is rebuilt
//! only by its maker, and a present is given only from an asset the same
//! maker made.
use std::collections::BTreeSet;
use std::path::Path;

use serde::Deserialize;
use serde_json::{json, Value};

use super::layout::Rng;
use super::model::*;
use super::rules::{self, invalid, not_yours, Bounds, PLACE_Y_MAX};
use super::{guide, room};
use crate::team::TeamAgent;

/// Every action the door knows.
pub const ACTIONS: &[&str] = &["look", "build", "grant", "style", "place", "propose"];

/// Who is calling, as the host knows it.
#[derive(Clone, Debug)]
pub struct Caller {
    pub chat_key: String,
    /// The registered agent the chat is led by (`team::lead_for_chat`), and
    /// its name, when it still is one.
    pub agent: Option<(String, String)>,
    /// An orchestration worker's chat (`is_worker_chat`).
    pub worker: bool,
    /// An additional agent in a room: its process is not the chat's own.
    pub seat: bool,
}

impl Caller {
    /// Who an asset or a grant is made by: the agent when there is one, else
    /// the chat.
    pub fn maker(&self) -> Maker {
        match &self.agent {
            Some((id, name)) => Maker {
                name: name.clone(),
                agent_id: Some(id.clone()),
                chat_key: None,
            },
            None => Maker {
                name: "Chat".into(),
                agent_id: None,
                chat_key: Some(self.chat_key.clone()),
            },
        }
    }
}

fn args_of<T: for<'de> Deserialize<'de>>(args: Value) -> Result<T, String> {
    serde_json::from_value(match args {
        Value::Null => json!({}),
        args => args,
    })
    .map_err(|e| invalid(format!("Those arguments are not valid: {e}.")))
}

/// One call through the door. `listed` says whether the chat is in the
/// person's chat list: an asset or a present is made in a chat they can open.
pub fn call(
    path: &Path,
    roster: &[TeamAgent],
    caller: &Caller,
    action: &str,
    args: Value,
    now: i64,
    listed: &dyn Fn() -> Result<bool, String>,
) -> Result<Value, String> {
    if !ACTIONS.contains(&action) {
        return Err(invalid(
            "Unknown island action. The actions are look, build, grant, style, place and propose.",
        ));
    }
    if action != "look" {
        if caller.worker {
            return Err(not_yours(
                "An orchestration worker can look at the island but not build on it: building, granting and styling belong to a chat the person talks to.",
            ));
        }
        if caller.seat {
            return Err(not_yours(
                "Only the chat's own agent can build on the island. An additional agent in a room is one voice in the chat, not its registered agent.",
            ));
        }
        if !listed()? {
            return Err(not_yours("This chat is not in the active chat index."));
        }
    }
    let _guard = super::locked();
    let mut island = super::ensure(path, Some(roster), now, super::random_seed)?;
    let (answer, what, id) = match action {
        "look" => return look(&island, roster, caller, args),
        "build" => {
            let (answer, id) = build(&mut island, caller, args, now)?;
            (answer, "asset", id)
        }
        "grant" => {
            let (answer, id) = grant(&mut island, roster, caller, args, now)?;
            (answer, "grant", id)
        }
        "propose" => {
            let (answer, id) = propose(&mut island, roster, caller, args, now)?;
            (answer, "wish", id)
        }
        "style" => {
            let (answer, id) = style(&mut island, caller, args)?;
            (answer, "style", id)
        }
        _ => {
            let (answer, id) = place(&mut island, caller, args, now)?;
            (answer, "place", id)
        }
    };
    super::save(path, &mut island, now, what, Some(&id))?;
    Ok(answer)
}

fn plot_view(plot: &Plot) -> Value {
    json!({
        "id": plot.id, "ring": plot.ring, "slot": plot.slot, "q": plot.q, "r": plot.r,
        "x": plot.x, "z": plot.z, "facing": plot.facing, "radius": plot.radius,
    })
}

fn bounds_view(bounds: &Bounds) -> Value {
    json!({
        "min": bounds.min.map(rules::mm),
        "max": bounds.max.map(rules::mm),
    })
}

fn asset_line(asset: &Asset) -> Value {
    let mut line = json!({
        "id": asset.id, "rev": asset.rev, "name": asset.name, "kind": asset.kind,
        "parts": asset.parts.len(),
    });
    if let Some(slot) = asset.slot {
        line["slot"] = json!(slot);
    }
    if let Some(r#use) = asset.r#use {
        line["use"] = json!(r#use);
    }
    line
}

/// What stands on a plot: each placement, its asset, and the asset's own box
/// (before its turn), so an agent can tell where there is room.
fn placed_on(island: &Island, plot: &str) -> Vec<Value> {
    island
        .placed
        .iter()
        .filter(|p| p.plot == plot)
        .filter_map(|p| {
            let asset = island.assets.iter().find(|a| a.id == p.asset)?;
            let mut line = json!({
                "placementId": p.id, "assetId": asset.id, "name": asset.name,
                "kind": asset.kind, "x": p.x, "z": p.z, "y": p.y, "turn": p.turn,
                "box": bounds_view(&rules::asset_bounds(&asset.parts)),
                "madeBy": asset.by.name,
            });
            if let Some(r#use) = asset.r#use {
                line["use"] = json!(r#use);
            }
            Some(line)
        })
        .collect()
}

fn worn_view(island: &Island, worn: &std::collections::BTreeMap<Slot, String>) -> Value {
    Value::Object(
        worn.iter()
            .map(|(slot, id)| {
                let name = island
                    .assets
                    .iter()
                    .find(|a| &a.id == id)
                    .map(|a| a.name.clone());
                (
                    slot.word().to_owned(),
                    json!({ "assetId": id, "name": name }),
                )
            })
            .collect(),
    )
}

/// A robot as `look` shows it: its look, its plot and what it has. A 波特's
/// plot is its home, with who it shares it with.
fn resident_view(island: &Island, roster: &[TeamAgent], who: &Owner) -> Value {
    let (name, character) = super::resident_name(island, Some(roster), who)
        .map(|(name, character)| (Some(name), character))
        .unwrap_or((None, None));
    let (look, worn) = match who.kind {
        OwnerKind::Bot => island
            .bots
            .iter()
            .find(|bot| bot.id == who.id)
            .map(|bot| (json!(bot.look), worn_view(island, &bot.look.worn)))
            .unwrap_or((Value::Null, json!({}))),
        OwnerKind::Agent => {
            let patch = island.looks.get(&who.id).cloned().unwrap_or_default();
            (json!(patch), worn_view(island, &patch.worn))
        }
        OwnerKind::Home => (Value::Null, json!({})),
    };
    let plot = super::plot_of(island, who);
    let mut view = json!({
        "kind": who.kind, "id": who.id, "name": name, "trait": character,
        "look": look,
        "wears": worn,
        "plot": plot.map(plot_view),
        "placed": plot.map(|plot| placed_on(island, &plot.id)).unwrap_or_default(),
    });
    if let Some(plot) = plot.filter(|plot| plot.owner.kind == OwnerKind::Home) {
        let members: Vec<String> = plot
            .members
            .iter()
            .filter_map(|id| island.bots.iter().find(|bot| &bot.id == id))
            .map(|bot| bot.name.clone())
            .collect();
        view["home"] = json!({ "plotId": plot.id, "members": members });
    }
    view
}

/// The caller's own: its robot, plot and placements when it is a registered
/// agent, and the assets it made either way.
fn you_view(island: &Island, roster: &[TeamAgent], caller: &Caller) -> Value {
    let maker = caller.maker();
    let assets: Vec<Value> = island
        .assets
        .iter()
        .filter(|asset| asset.by.same(&maker))
        .map(asset_line)
        .collect();
    let mut you = match &caller.agent {
        Some((id, _)) => resident_view(island, roster, &Owner::agent(id)),
        None => json!({ "name": "Chat", "chatKey": caller.chat_key }),
    };
    you["assets"] = json!(assets);
    you
}

fn look(
    island: &Island,
    roster: &[TeamAgent],
    caller: &Caller,
    args: Value,
) -> Result<Value, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Args {
        #[serde(default)]
        wish_id: Option<String>,
    }
    let args: Args = args_of(args)?;
    let names = |who: &Owner| super::resident_name(island, Some(roster), who).map(|(name, _)| name);
    let open: Vec<Value> = island
        .wishes
        .iter()
        .filter(|wish| wish.state == WishState::Open)
        .map(|wish| {
            json!({
                "id": wish.id, "who": wish.who, "name": names(&wish.who),
                "want": wish.want, "slot": wish.slot, "text": wish.text,
            })
        })
        .collect();
    let residents: Vec<Value> = super::residents(island, Some(roster))
        .iter()
        .map(|resident| {
            let character = (resident.who.kind == OwnerKind::Bot).then_some(resident.character);
            json!({
                "kind": resident.who.kind, "id": resident.who.id,
                "name": names(&resident.who), "trait": character,
            })
        })
        .collect();
    let mut answer = json!({
        "guide": guide::text(),
        "you": you_view(island, roster, caller),
        "openWishes": open,
        "residents": residents,
    });
    if let Some(id) = args
        .wish_id
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty())
    {
        let wish = island
            .wishes
            .iter()
            .find(|wish| wish.id == id)
            .ok_or_else(|| invalid(format!("There is no wish {id} on the island.")))?;
        let mut shown = json!(wish);
        if wish.state == WishState::Open {
            if let Some((name, character)) = super::resident_name(island, Some(roster), &wish.who) {
                shown["brief"] = json!(super::wishes::brief(wish, &name, character));
            }
        }
        answer["wish"] = shown;
        answer["wisher"] = resident_view(island, roster, &wish.who);
    }
    Ok(answer)
}

/// The assets a maker keeps, against `MAKER_ASSETS_MAX`.
fn made_by(island: &Island, maker: &Maker) -> usize {
    island
        .assets
        .iter()
        .filter(|asset| asset.by.same(maker))
        .count()
}

fn build(
    island: &mut Island,
    caller: &Caller,
    args: Value,
    now: i64,
) -> Result<(Value, String), String> {
    let (draft, asset_id) = rules::check_asset(args)?;
    let maker = caller.maker();
    let id = match asset_id {
        Some(id) => rebuild(island, caller, &maker, &id, draft, now)?,
        None => {
            if island.assets.len() >= super::ASSETS_MAX {
                return Err(invalid(format!(
                    "The island holds {} assets, the most it keeps. Rebuild one you made (pass its assetId) instead.",
                    super::ASSETS_MAX
                )));
            }
            if made_by(island, &maker) >= super::MAKER_ASSETS_MAX {
                return Err(invalid(format!(
                    "{} has made {} assets, the most one maker keeps. Rebuild one of them (pass its assetId) instead.",
                    maker.name,
                    super::MAKER_ASSETS_MAX
                )));
            }
            let mut rng = Rng::for_change(island.seed, island.rev, now, super::SALT_BUILD);
            super::add_asset(island, draft, maker, now, &mut rng)
        }
    };
    let asset = island
        .assets
        .iter()
        .find(|asset| asset.id == id)
        .ok_or("The asset was not kept.")?;
    let mut answer = asset_line(asset);
    answer["assetId"] = json!(asset.id);
    answer["box"] = bounds_view(&rules::asset_bounds(&asset.parts));
    answer["next"] = json!(if asset.kind == Kind::Accessory {
        "Give it with island_grant (wishId, assetId), or wear it yourself with island_style."
    } else {
        "Give it with island_grant (wishId, assetId), or place it on your own plot with island_place."
    });
    Ok((answer, id))
}

/// Rebuild an asset in place: by its maker, or by a registered agent for an
/// island starter on its own plot, which is then the agent's. The kind (and
/// an accessory's slot) stays, and wherever it stands it must still fit.
fn rebuild(
    island: &mut Island,
    caller: &Caller,
    maker: &Maker,
    id: &str,
    draft: rules::Draft,
    now: i64,
) -> Result<String, String> {
    let at = island
        .assets
        .iter()
        .position(|asset| asset.id == id)
        .ok_or_else(|| invalid(format!("There is no asset {id} on the island.")))?;
    let asset = &island.assets[at];
    let own_plot = caller
        .agent
        .as_ref()
        .and_then(|(agent, _)| super::plot_of(island, &Owner::agent(agent)))
        .map(|plot| plot.id.clone());
    let starter_here = asset.by.is_island()
        && own_plot.as_ref().is_some_and(|plot| {
            island
                .placed
                .iter()
                .any(|p| p.asset == id && &p.plot == plot)
        });
    if !asset.by.same(maker) && !starter_here {
        return Err(not_yours(format!(
            "{id} (\"{}\") was made by {}, and only its maker rebuilds it. Build a new asset instead.",
            asset.name, asset.by.name
        )));
    }
    if asset.kind != draft.kind {
        return Err(invalid(format!(
            "A rebuild keeps the asset's kind: {id} is {}. Build a new asset for {}.",
            asset.kind.word(),
            draft.kind.word()
        )));
    }
    if asset.slot != draft.slot {
        return Err(invalid(format!(
            "A rebuild keeps an accessory's slot: {id} is worn on the {}.",
            asset.slot.map(Slot::word).unwrap_or("?")
        )));
    }
    if starter_here && made_by(island, maker) >= super::MAKER_ASSETS_MAX {
        return Err(invalid(format!(
            "{} has made {} assets, the most one maker keeps.",
            maker.name,
            super::MAKER_ASSETS_MAX
        )));
    }
    let asset = &mut island.assets[at];
    asset.name = draft.name;
    asset.r#use = draft.r#use;
    asset.spot = draft.spot;
    asset.parts = draft.parts;
    asset.rev += 1;
    asset.updated_at = now;
    asset.by = maker.clone();
    let bounds = rules::asset_bounds(&asset.parts);
    let name = asset.name.clone();
    for placement in island.placed.iter().filter(|p| p.asset == id) {
        if !rules::fits_plot(&bounds, placement.x, placement.z, placement.turn) {
            return Err(invalid(format!(
                "Rebuilt, {name} would stick out of the plot where it stands (placement {}, at x {}, z {}): keep it smaller, or move it first.",
                placement.id,
                rules::show(placement.x),
                rules::show(placement.z)
            )));
        }
    }
    let plots: BTreeSet<String> = island
        .placed
        .iter()
        .filter(|p| p.asset == id)
        .map(|p| p.plot.clone())
        .collect();
    for plot in plots {
        let parts = parts_on(island, &plot, None);
        if parts > super::PLOT_PARTS_MAX {
            return Err(invalid(format!(
                "Rebuilt, {name} would bring a plot it stands on to {parts} parts, and a plot holds at most {} between its placements.",
                super::PLOT_PARTS_MAX
            )));
        }
    }
    Ok(id.to_owned())
}

/// The parts of every asset placed on a plot, but the placement `except`.
fn parts_on(island: &Island, plot: &str, except: Option<&str>) -> usize {
    island
        .placed
        .iter()
        .filter(|p| p.plot == plot && Some(p.id.as_str()) != except)
        .filter_map(|p| island.assets.iter().find(|a| a.id == p.asset))
        .map(|asset| asset.parts.len())
        .sum()
}

/// Whether a plot has room for one more placement of `parts` parts, the
/// placement `except` (one being moved) left out.
pub(super) fn plot_room(
    island: &Island,
    plot: &str,
    parts: usize,
    except: Option<&str>,
) -> Result<(), String> {
    let placements = island
        .placed
        .iter()
        .filter(|p| p.plot == plot && Some(p.id.as_str()) != except)
        .count();
    if placements >= super::PLOT_PLACEMENTS_MAX {
        return Err(invalid(format!(
            "A plot holds at most {} placements, and this one is full: take one away first.",
            super::PLOT_PLACEMENTS_MAX
        )));
    }
    let total = parts_on(island, plot, except) + parts;
    if total > super::PLOT_PARTS_MAX {
        return Err(invalid(format!(
            "A plot holds at most {} parts between its placements, and this would make {total}: build something simpler or take something away.",
            super::PLOT_PARTS_MAX
        )));
    }
    Ok(())
}

fn number(value: Option<f64>, what: &str) -> Result<Option<f64>, String> {
    match value {
        Some(v) if !v.is_finite() => Err(invalid(format!("{what} must be a finite number."))),
        other => Ok(other.map(rules::mm)),
    }
}

/// Where a placement goes: both of `x`, `z`, checked to keep the asset on
/// its plot, or neither, and the island finds room.
fn spot_on_plot(
    island: &Island,
    plot: &str,
    asset: &Asset,
    (x, z): (Option<f64>, Option<f64>),
    turn: f64,
    owner_name: &str,
) -> Result<(f64, f64), String> {
    let bounds = rules::asset_bounds(&asset.parts);
    match (number(x, "x")?, number(z, "z")?) {
        (Some(x), Some(z)) => {
            if rules::fits_plot(&bounds, x, z, turn) {
                Ok((x, z))
            } else {
                Err(invalid(format!(
                    "At x {}, z {} (turned {}°) the {} would stick out of the plot's hexagonal tile (|z| ≤ 5.456 and |x| + |z|/√3 ≤ 6.3): choose a spot further in.",
                    rules::show(x),
                    rules::show(z),
                    rules::show(turn),
                    asset.name
                )))
            }
        }
        (None, None) => room::find_room(
            island,
            plot,
            &bounds,
            turn,
            room::first_look(island, plot, asset.kind),
            &[],
        )
        .ok_or_else(|| {
            invalid(format!(
                "There is no room left on {owner_name}'s plot for {}: pass x and z (plot coordinates on the hexagonal tile, +z towards the plaza) to place it yourself, or build something smaller.",
                asset.name
            ))
        }),
        _ => Err(invalid(
            "Give both x and z, or neither and the island finds room.",
        )),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GrantArgs {
    #[serde(default)]
    wish_id: Option<String>,
    #[serde(default)]
    asset_id: Option<String>,
    #[serde(default)]
    look: Option<Value>,
    #[serde(default)]
    x: Option<f64>,
    #[serde(default)]
    z: Option<f64>,
    #[serde(default)]
    turn: Option<f64>,
}

fn grant(
    island: &mut Island,
    roster: &[TeamAgent],
    caller: &Caller,
    args: Value,
    now: i64,
) -> Result<(Value, String), String> {
    let args: GrantArgs = args_of(args)?;
    let wish_id = args
        .wish_id
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty())
        .ok_or_else(|| invalid("Name the wish to grant: wishId."))?;
    let at = island
        .wishes
        .iter()
        .position(|wish| wish.id == wish_id)
        .ok_or_else(|| invalid(format!("There is no wish {wish_id} on the island.")))?;
    let wish = island.wishes[at].clone();
    if wish.state != WishState::Open {
        return Err(invalid(format!(
            "Wish {wish_id} is {} already; there is nothing to give.",
            wish.state.word()
        )));
    }
    let name = super::resident_name(island, Some(roster), &wish.who)
        .map(|(name, _)| name)
        .unwrap_or_else(|| "the robot".into());
    let maker = caller.maker();
    let mut answer = json!({ "granted": wish.id, "to": name });
    let mut given = Grant {
        asset: None,
        look: false,
        by: maker.clone(),
        at: now,
    };
    if wish.want == Want::Look {
        if args.asset_id.is_some() {
            return Err(invalid(
                "This wish is for a fresh look, not an asset: pass look, and no assetId.",
            ));
        }
        let look = args.look.ok_or_else(|| {
            invalid("This wish is for a fresh look: pass look with the new frame, colours, eyes or antenna.")
        })?;
        if look.get("worn").is_some_and(|worn| !worn.is_null()) {
            return Err(invalid(
                "A look wish is a fresh coat of paint, so leave worn out: what a robot wears comes with its accessory wishes.",
            ));
        }
        let change = rules::check_look(look, island, &|_| false)?;
        if change.is_empty() {
            return Err(invalid(
                "That look changes nothing: set at least one of frame, shell, trim, glow, eyes or antenna.",
            ));
        }
        restyle(island, &wish.who, &change)?;
        given.look = true;
        answer["look"] = json!(true);
    } else {
        if args.look.is_some() {
            return Err(invalid(format!(
                "This wish is for {}: pass the assetId of one you built, not a look.",
                wanted(&wish)
            )));
        }
        let asset_id = args
            .asset_id
            .map(|id| id.trim().to_owned())
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                invalid(format!(
                    "Pass the assetId of the {} you built for it (island_build answers it).",
                    wanted(&wish)
                ))
            })?;
        let asset = island
            .assets
            .iter()
            .find(|a| a.id == asset_id)
            .cloned()
            .ok_or_else(|| invalid(format!("There is no asset {asset_id} on the island.")))?;
        if !asset.by.same(&maker) {
            return Err(not_yours(format!(
                "{asset_id} (\"{}\") was made by {}: a present is given only from an asset you built yourself.",
                asset.name, asset.by.name
            )));
        }
        if asset.kind.want() != wish.want || asset.slot != wish.slot {
            return Err(invalid(format!(
                "The wish is for {}, and {asset_id} (\"{}\") is {}.",
                wanted(&wish),
                asset.name,
                described(&asset)
            )));
        }
        let mut rng = Rng::for_change(island.seed, island.rev, now, super::SALT_GRANT);
        let plot = if super::wishes::public_project(&wish) {
            let lead = roster
                .iter()
                .find(|agent| agent.id == wish.who.id)
                .is_some_and(|agent| {
                    agent.reports_to.is_none()
                        || roster
                            .iter()
                            .any(|member| member.reports_to.as_deref() == Some(&agent.id))
                });
            if !lead {
                return Err(invalid(
                    "Only a registered lead may request a public island project.",
                ));
            }
            super::claim(
                island,
                Owner {
                    kind: OwnerKind::Home,
                    id: format!("public:{}", wish.id),
                },
                now,
                &mut rng,
            )?
        } else {
            super::plot_of(island, &wish.who)
                .map(|plot| plot.id.clone())
                .ok_or_else(|| invalid(format!("{name} has no plot to give it on.")))?
        };
        match asset.kind {
            Kind::Accessory => {
                let slot = asset.slot.ok_or("An accessory has no slot.")?;
                let before = worn_in(island, &wish.who, slot);
                let mut change = rules::LookChange::default();
                change.worn.insert(slot, Some(asset.id.clone()));
                restyle(island, &wish.who, &change)?;
                // A 波特's own backpack, once a present takes its place, is
                // worn by nobody and can be worn by nobody again.
                super::forget_orphans(island, &before.into_iter().collect::<Vec<_>>());
                answer["worn"] = json!(slot);
            }
            Kind::Building => {
                let placed = replace_building(
                    island,
                    &plot,
                    &asset,
                    (args.x, args.z),
                    args.turn,
                    &name,
                    &mut rng,
                )?;
                answer["placed"] = placement_line(&placed);
            }
            Kind::Furniture | Kind::Decor => {
                let turn = number(args.turn, "turn")?
                    .map(rules::degrees)
                    .unwrap_or(0.0);
                if wish.who.kind == OwnerKind::Agent {
                    answer["replaced"] =
                        json!(super::inventory::replace(island, &wish.who, &asset));
                }
                plot_room(island, &plot, asset.parts.len(), None)?;
                let at = spot_on_plot(island, &plot, &asset, (args.x, args.z), turn, &name)?;
                let placed =
                    super::new_placement(island, &plot, &asset.id, at, 0.0, turn, &mut rng);
                answer["placed"] = placement_line(&placed);
            }
        }
        answer["retired"] = json!(super::inventory::limit(island, &wish.who, Some(&asset.id)));
        given.asset = Some(asset.id.clone());
    }
    let wish = &mut island.wishes[at];
    wish.state = WishState::Granted;
    wish.grant = Some(given);
    wish.closed_at = Some(now);
    super::prune_closed(island);
    Ok((answer, wish_id))
}

/// A wish's want in words: "an accessory for the neck", "furniture".
fn wanted(wish: &Wish) -> String {
    match (wish.want, wish.slot) {
        (Want::Accessory, Some(slot)) => format!("an accessory for the {} slot", slot.word()),
        (Want::Look, _) => "a fresh look".into(),
        (Want::Building, _) => "a building".into(),
        (want, _) => want.word().into(),
    }
}

fn described(asset: &Asset) -> String {
    match asset.slot {
        Some(slot) => format!("an accessory for the {} slot", slot.word()),
        None if asset.kind == Kind::Building => "a building".into(),
        None => asset.kind.word().into(),
    }
}

fn placement_line(placement: &Placement) -> Value {
    json!({
        "placementId": placement.id, "assetId": placement.asset,
        "x": placement.x, "z": placement.z, "y": placement.y, "turn": placement.turn,
    })
}

/// What a resident wears in a slot now.
fn worn_in(island: &Island, who: &Owner, slot: Slot) -> Option<String> {
    match who.kind {
        OwnerKind::Bot => island
            .bots
            .iter()
            .find(|bot| bot.id == who.id)
            .and_then(|bot| bot.look.worn.get(&slot).cloned()),
        OwnerKind::Agent => island
            .looks
            .get(&who.id)
            .and_then(|look| look.worn.get(&slot).cloned()),
        OwnerKind::Home => None,
    }
}

/// Lay a look change over a resident's look: a bot's whole look, or a
/// registered agent's patch.
fn restyle(island: &mut Island, who: &Owner, change: &rules::LookChange) -> Result<(), String> {
    match who.kind {
        OwnerKind::Bot => {
            let bot = island
                .bots
                .iter_mut()
                .find(|bot| bot.id == who.id)
                .ok_or_else(|| invalid("That 波特 does not live on the island any more."))?;
            change.apply_to_look(&mut bot.look);
        }
        OwnerKind::Agent => {
            change.apply_to_patch(island.looks.entry(who.id.clone()).or_default());
        }
        OwnerKind::Home => return Err(invalid("A home has no look of its own.")),
    }
    Ok(())
}

/// A granted building replaces the wisher's: where the old one stood, else
/// in the middle of the plot, unless the agent said where.
fn replace_building(
    island: &mut Island,
    plot: &str,
    asset: &Asset,
    (x, z): (Option<f64>, Option<f64>),
    turn: Option<f64>,
    owner_name: &str,
    rng: &mut Rng,
) -> Result<Placement, String> {
    let buildings: Vec<Placement> = island
        .placed
        .iter()
        .filter(|p| {
            p.plot == plot
                && island
                    .assets
                    .iter()
                    .any(|a| a.id == p.asset && a.kind == Kind::Building)
        })
        .cloned()
        .collect();
    let (old_x, old_z, old_turn) = buildings
        .first()
        .map(|p| (p.x, p.z, p.turn))
        .unwrap_or((0.0, 0.0, 0.0));
    island
        .placed
        .retain(|p| !buildings.iter().any(|b| b.id == p.id));
    let turn = number(turn, "turn")?
        .map(rules::degrees)
        .unwrap_or(old_turn);
    let bounds = rules::asset_bounds(&asset.parts);
    let at = match (x, z) {
        (None, None) => [(old_x, old_z), (0.0, 0.0)]
            .into_iter()
            .find(|(x, z)| rules::fits_plot(&bounds, *x, *z, turn))
            .ok_or_else(|| {
                invalid(format!(
                    "{} does not fit on {owner_name}'s plot where the old building stood, or in the middle: every corner of a building's box stays on the hexagonal tile (|z| ≤ 5.456 and |x| + |z|/√3 ≤ 6.3).",
                    asset.name
                ))
            })?,
        given => spot_on_plot(island, plot, asset, given, turn, owner_name)?,
    };
    plot_room(island, plot, asset.parts.len(), None)?;
    let placed = super::new_placement(island, plot, &asset.id, at, 0.0, turn, rng);
    let old: Vec<String> = buildings.into_iter().map(|b| b.asset).collect();
    super::forget_orphans(island, &old);
    Ok(placed)
}

/// Accessories a registered agent may wear: ones it made, ones it was
/// given, and whatever it wears now.
fn wearable(island: &Island, agent: &str, maker: &Maker) -> BTreeSet<String> {
    let me = Owner::agent(agent);
    let mut ids: BTreeSet<String> = island
        .assets
        .iter()
        .filter(|asset| asset.by.same(maker))
        .map(|asset| asset.id.clone())
        .collect();
    ids.extend(
        island
            .wishes
            .iter()
            .filter(|wish| wish.who == me)
            .filter_map(|wish| wish.grant.as_ref()?.asset.clone()),
    );
    if let Some(patch) = island.looks.get(agent) {
        ids.extend(patch.worn.values().cloned());
    }
    ids
}

fn style(island: &mut Island, caller: &Caller, args: Value) -> Result<(Value, String), String> {
    let Some((agent, _)) = &caller.agent else {
        return Err(not_yours(
            "island_style changes a registered agent's own robot, and this chat has no registered agent.",
        ));
    };
    let mine = wearable(island, agent, &caller.maker());
    let change = rules::check_look(args, island, &|asset| mine.contains(&asset.id))?;
    if change.is_empty() {
        return Err(invalid(
            "That look changes nothing: set at least one of frame, shell, trim, glow, eyes, antenna or worn.",
        ));
    }
    let patch = island.looks.entry(agent.clone()).or_default();
    change.apply_to_patch(patch);
    Ok((json!({ "look": patch }), agent.clone()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlaceArgs {
    #[serde(default)]
    asset_id: Option<String>,
    #[serde(default)]
    placement_id: Option<String>,
    #[serde(default)]
    x: Option<f64>,
    #[serde(default)]
    z: Option<f64>,
    #[serde(default)]
    y: Option<f64>,
    #[serde(default)]
    turn: Option<f64>,
    #[serde(default)]
    remove: Option<bool>,
}

/// Whether a registered agent may place this asset on its plot: one it
/// made, or an island starter already on that plot.
fn placeable(island: &Island, asset: &Asset, maker: &Maker, plot: &str) -> Result<(), String> {
    if !asset.kind.placed() {
        return Err(invalid(format!(
            "{} (\"{}\") is an accessory: accessories are worn (island_style), not placed.",
            asset.id, asset.name
        )));
    }
    let starter_here = asset.by.is_island()
        && island
            .placed
            .iter()
            .any(|p| p.asset == asset.id && p.plot == plot);
    if asset.by.same(maker) || starter_here {
        return Ok(());
    }
    Err(not_yours(format!(
        "{} (\"{}\") is not yours to place: place an asset you made, or a starter already on your plot.",
        asset.id, asset.name
    )))
}

fn place(
    island: &mut Island,
    caller: &Caller,
    args: Value,
    now: i64,
) -> Result<(Value, String), String> {
    let Some((agent, name)) = caller.agent.clone() else {
        return Err(not_yours(
            "island_place arranges a registered agent's own plot, and this chat has no registered agent.",
        ));
    };
    let args: PlaceArgs = args_of(args)?;
    let maker = caller.maker();
    let plot = super::plot_of(island, &Owner::agent(&agent))
        .map(|plot| plot.id.clone())
        .ok_or_else(|| invalid("You have no plot on the island yet."))?;
    let given = |id: Option<String>| {
        id.map(|id| id.trim().to_owned())
            .filter(|id| !id.is_empty())
    };
    let placement_id = given(args.placement_id);
    let mine = |island: &Island, id: &str| {
        island
            .placed
            .iter()
            .position(|p| p.id == id && p.plot == plot)
            .ok_or_else(|| invalid(format!("There is no placement {id} on your plot.")))
    };
    if args.remove == Some(true) {
        let id =
            placement_id.ok_or_else(|| invalid("Name the placement to take away: placementId."))?;
        let at = mine(island, &id)?;
        let removed = island.placed.remove(at);
        super::forget_orphans(island, &[removed.asset]);
        return Ok((json!({ "removed": id }), id));
    }
    let y = number(args.y, "y")?;
    if let Some(y) = y {
        if !(0.0..=PLACE_Y_MAX).contains(&y) {
            return Err(invalid(format!(
                "y is 0 to {} (to stand something on a table).",
                rules::show(PLACE_Y_MAX)
            )));
        }
    }
    let turn = number(args.turn, "turn")?.map(rules::degrees);
    let asset_id = given(args.asset_id);
    let find_asset = |island: &Island, id: &str| {
        island
            .assets
            .iter()
            .find(|a| a.id == id)
            .cloned()
            .ok_or_else(|| invalid(format!("There is no asset {id} on the island.")))
    };
    let placed = match placement_id {
        // Move what is already there, or put another asset in its place.
        Some(id) => {
            let at = mine(island, &id)?;
            let before = island.placed[at].clone();
            let asset = find_asset(island, asset_id.as_deref().unwrap_or(&before.asset))?;
            if asset.id != before.asset {
                placeable(island, &asset, &maker, &plot)?;
            }
            plot_room(island, &plot, asset.parts.len(), Some(&id))?;
            let turn = turn.unwrap_or(before.turn);
            let (x, z) = match (args.x, args.z) {
                (None, None) => (before.x, before.z),
                // One of the two given: the other stays where it was.
                (x, z) => spot_on_plot(
                    island,
                    &plot,
                    &asset,
                    (x.or(Some(before.x)), z.or(Some(before.z))),
                    turn,
                    &name,
                )?,
            };
            if !rules::fits_plot(&rules::asset_bounds(&asset.parts), x, z, turn) {
                return Err(invalid(format!(
                    "Turned {}°, {} would stick out of your plot where it stands: move it further in too.",
                    rules::show(turn),
                    asset.name
                )));
            }
            let placement = &mut island.placed[at];
            placement.asset = asset.id.clone();
            placement.x = x;
            placement.z = z;
            placement.y = y.unwrap_or(before.y);
            placement.turn = turn;
            let placed = placement.clone();
            if before.asset != placed.asset {
                super::forget_orphans(island, &[before.asset]);
            }
            placed
        }
        None => {
            let id = asset_id.ok_or_else(|| {
                invalid("Name what to place: assetId (or placementId to move a placement).")
            })?;
            let asset = find_asset(island, &id)?;
            placeable(island, &asset, &maker, &plot)?;
            plot_room(island, &plot, asset.parts.len(), None)?;
            let turn = turn.unwrap_or(0.0);
            let at = spot_on_plot(island, &plot, &asset, (args.x, args.z), turn, &name)?;
            let mut rng = Rng::for_change(island.seed, island.rev, now, super::SALT_PLACE);
            super::new_placement(
                island,
                &plot,
                &asset.id,
                at,
                y.unwrap_or(0.0),
                turn,
                &mut rng,
            )
        }
    };
    let id = placed.id.clone();
    super::inventory::limit(island, &Owner::agent(&agent), Some(&placed.asset));
    Ok((placement_line(&placed), id))
}

/// A registered lead's concrete public proposal, queued as an ordinary wish.
fn propose(
    island: &mut Island,
    roster: &[TeamAgent],
    caller: &Caller,
    args: Value,
    now: i64,
) -> Result<(Value, String), String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Args {
        text: String,
    }
    let args: Args = args_of(args)?;
    let agent_id = caller
        .agent
        .as_ref()
        .map(|(id, _)| id.as_str())
        .ok_or_else(|| not_yours("Only a registered lead can propose public island projects."))?;
    let agent = roster
        .iter()
        .find(|agent| agent.id == agent_id)
        .ok_or_else(|| not_yours("The lead must still be registered."))?;
    if agent.reports_to.is_some()
        && !roster
            .iter()
            .any(|member| member.reports_to.as_deref() == Some(agent_id))
    {
        return Err(not_yours(
            "Only a registered lead can propose public island projects.",
        ));
    }
    let text = args.text.trim();
    if text.is_empty() || text.chars().count() > 110 || text.chars().any(char::is_control) {
        return Err(invalid(
            "Describe the public improvement in one line, 1–110 characters.",
        ));
    }
    let who = Owner::agent(agent_id);
    let text = format!("a public island project: {text}");
    if let Some(wish) = island.wishes.iter().find(|wish| {
        wish.who == who
            && matches!(wish.state, WishState::Open | WishState::Queued)
            && wish.text == text
    }) {
        return Ok((
            json!({"wishId":wish.id,"state":wish.state.word()}),
            wish.id.clone(),
        ));
    }
    if super::has_open_wish(island, &who) || super::open_wishes(island) >= super::OPEN_MAX {
        return Err(invalid(
            "Finish or dismiss the existing wish before proposing another public project.",
        ));
    }
    let mut rng = Rng::for_change(island.seed, island.rev, now, super::SALT_GRANT);
    let id = super::new_id("w", &mut rng, &|id| {
        island.wishes.iter().any(|wish| wish.id == id)
    });
    island.wishes.push(Wish {
        id: id.clone(),
        who,
        want: Want::Building,
        slot: None,
        text,
        made_at: now,
        state: WishState::Queued,
        grant: None,
        closed_at: None,
    });
    Ok((json!({"wishId":id,"state":"queued"}), id))
}
