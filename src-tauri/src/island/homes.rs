//! Where 波特 live: homes shared by up to four of them, built together.
//!
//! A new 波特 moves into the first home with room, in ring and slot order;
//! only when every home is full is a new one made, on the first free cell a
//! 波特 may have (`layout::rings_for`). The members build the house
//! together (`home.rs`): its shape is the founder's choice, its walls the
//! founder's shell and its trim the next member's. Each member brings a bed
//! and one touch of its own. Whenever someone moves in or out, the house is
//! built again in place (the same asset, its revision moved on) and the beds
//! are laid again along the back wall; the last one out frees the plot.
//!
//! A building given to a member as a present takes the house's place and is
//! never rebuilt; beds and touches then find room in it like any present.
use std::collections::BTreeSet;

use super::home::{self, Style};
use super::layout::{new_id, Rng};
use super::model::*;
use super::room;
use super::rules::{self, mm};

/// The most 波特 one home holds.
pub const MEMBERS_MAX: usize = 4;

fn plot_at(island: &Island, plot: &str) -> Result<usize, String> {
    island
        .plots
        .iter()
        .position(|p| p.id == plot)
        .ok_or_else(|| format!("There is no home {plot} on the island."))
}

fn bot_at(island: &Island, bot: &str) -> Result<usize, String> {
    island
        .bots
        .iter()
        .position(|b| b.id == bot)
        .ok_or_else(|| rules::invalid(format!("There is no 波特 {bot} on the island.")))
}

/// Move a 波特 that has just arrived (it is in `island.bots` already) into a
/// home. The home's plot.
pub fn move_in(island: &mut Island, bot: &str, now: i64, rng: &mut Rng) -> Result<String, String> {
    let mut homes: Vec<&Plot> = island
        .plots
        .iter()
        .filter(|p| p.owner.kind == OwnerKind::Home && p.members.len() < MEMBERS_MAX)
        .collect();
    homes.sort_by_key(|p| (p.ring, p.slot));
    let plot = match homes.first() {
        Some(plot) => plot.id.clone(),
        None => {
            let id = new_id("h", rng, &|id| {
                island.plots.iter().any(|p| p.owner.id == id)
            });
            super::claim(
                island,
                Owner {
                    kind: OwnerKind::Home,
                    id,
                },
                now,
                rng,
            )?
        }
    };
    let at = plot_at(island, &plot)?;
    island.plots[at].members.push(bot.to_owned());
    let me = bot_at(island, bot)?;
    island.bots[me].home = plot.clone();
    settle(island, &plot, now, rng)?;
    Ok(plot)
}

/// Move a 波特 out of its home: its bed and its touch go with it. The last
/// one out frees the plot, and whatever stood on it goes too, unless
/// something else still has it. The home's plot, or `None` for a 波特 that
/// lived in no home the island knows.
pub fn move_out(
    island: &mut Island,
    bot: &str,
    now: i64,
    rng: &mut Rng,
) -> Result<Option<String>, String> {
    let me = bot_at(island, bot)?;
    let (plot, name) = (island.bots[me].home.clone(), island.bots[me].name.clone());
    let Ok(at) = plot_at(island, &plot) else {
        return Ok(None);
    };
    island.plots[at].members.retain(|member| member != bot);
    let made_by_me = Maker::bot(&name);
    let mut had: Vec<String> = Vec::new();
    island.placed.retain(|p| {
        let mine = p.plot == plot
            && island
                .assets
                .iter()
                .any(|a| a.id == p.asset && a.by == made_by_me && a.kind != Kind::Building);
        if mine {
            had.push(p.asset.clone());
        }
        !mine
    });
    if island.plots[at].members.is_empty() {
        island.plots.remove(at);
        island.placed.retain(|p| {
            let here = p.plot == plot;
            if here {
                had.push(p.asset.clone());
            }
            !here
        });
    } else {
        settle(island, &plot, now, rng)?;
    }
    let unused: BTreeSet<String> = had
        .into_iter()
        .filter(|asset| !super::in_use(island, asset))
        .collect();
    island.assets.retain(|asset| !unused.contains(&asset.id));
    Ok(Some(plot))
}

/// The placement on a plot of a member's bed, or of its touch.
fn own_placement(island: &Island, plot: &str, name: &str, bed: bool) -> Option<usize> {
    let maker = Maker::bot(name);
    island.placed.iter().position(|p| {
        p.plot == plot
            && island.assets.iter().any(|a| {
                a.id == p.asset
                    && a.by == maker
                    && a.kind != Kind::Building
                    && (a.r#use == Some(Use::Bed)) == bed
            })
    })
}

/// Build a home again for whoever lives there now: the house in place, a
/// bed for each member along the back wall, and a touch for each member
/// that has none placed.
fn settle(island: &mut Island, plot: &str, now: i64, rng: &mut Rng) -> Result<(), String> {
    let at = plot_at(island, plot)?;
    let members: Vec<Bot> = island.plots[at]
        .members
        .iter()
        .filter_map(|id| island.bots.iter().find(|b| &b.id == id).cloned())
        .collect();
    let Some(founder) = members.first() else {
        return Ok(());
    };
    let style = home::choose(island.seed, &founder.id, founder.r#trait);
    let trim = members.get(1).unwrap_or(founder).look.trim.clone();
    let names: Vec<&str> = members.iter().map(|m| m.name.as_str()).collect();
    let by = Maker::bot(&home::names(&names));
    let (draft, _) = rules::check_asset(home::house(style, &founder.look.shell, &trim))?;

    // The members' own house is built again in place; a building given as a
    // present is left as it is.
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
    let ours = buildings.iter().find(|p| {
        island
            .assets
            .iter()
            .any(|a| a.id == p.asset && a.by.key().is_none())
    });
    let mut restyled = false;
    let house = match ours {
        Some(placement) => {
            let asset = island
                .assets
                .iter_mut()
                .find(|a| a.id == placement.asset)
                .ok_or("The home's house was not kept.")?;
            restyled = Style::from_name(&asset.name) != Some(style);
            if asset.parts != draft.parts || asset.by != by || asset.name != draft.name {
                asset.name = draft.name;
                asset.parts = draft.parts;
                asset.rev += 1;
                asset.updated_at = now;
                asset.by = by;
            }
            Some((placement.x, placement.z))
        }
        None if buildings.is_empty() => {
            let id = super::add_asset(island, draft, by, now, rng);
            super::new_placement(island, plot, &id, home::HOUSE_AT, 0.0, 0.0, rng);
            Some(home::HOUSE_AT)
        }
        None => None,
    };

    // A bed for each member: laid side by side along the back wall of the
    // members' own house, or wherever there is room in a present.
    for member in &members {
        if own_placement(island, plot, &member.name, true).is_some() {
            continue;
        }
        let (draft, _) = rules::check_asset(home::bed(&member.name, &member.look.trim))?;
        let bounds = rules::asset_bounds(&draft.parts);
        let spot = match house {
            Some(_) => Some(home::HOUSE_AT),
            None => {
                let start = room::first_look(island, plot, Kind::Furniture);
                room::find_room(island, plot, &bounds, 0.0, start, &[])
            }
        };
        if let Some(spot) = spot {
            let id = super::add_asset(island, draft, Maker::bot(&member.name), now, rng);
            super::new_placement(island, plot, &id, spot, 0.0, 0.0, rng);
        }
    }
    if let Some((hx, hz)) = house {
        let row = home::bed_row(style, members.len());
        for (member, (bx, bz)) in members.iter().zip(row) {
            if let Some(bed) = own_placement(island, plot, &member.name, true) {
                let placement = &mut island.placed[bed];
                placement.x = mm(hx + bx);
                placement.z = mm(hz + bz);
                placement.y = 0.0;
                placement.turn = 0.0;
            }
        }
    }

    // A touch of each member's own. A house that changed its shape has
    // them all placed again, as the room they stood in is gone.
    if restyled {
        let mut gone = Vec::new();
        for member in &members {
            if let Some(touch) = own_placement(island, plot, &member.name, false) {
                gone.push(island.placed.remove(touch).asset);
            }
        }
        island.assets.retain(|a| !gone.contains(&a.id));
    }
    let keep_clear: Vec<room::Obstacle> = house
        .map(|(hx, hz)| vec![room::keep_clear(&home::bed_zone(style), hx, hz)])
        .unwrap_or_default();
    let (hx, hz) = house.unwrap_or_else(|| room::first_look(island, plot, Kind::Furniture));
    for member in &members {
        if own_placement(island, plot, &member.name, false).is_some() {
            continue;
        }
        let (draft, _) =
            rules::check_asset(home::touch(member.r#trait, &member.name, &member.look))?;
        let bounds = rules::asset_bounds(&draft.parts);
        let start = if home::by_the_door(member.r#trait) {
            let (dx, dz) = home::door(style);
            (hx + dx + 1.1, hz + dz + 0.5)
        } else {
            (hx, hz)
        };
        // A plot with no room left for it does without.
        if let Some(spot) = room::find_room(island, plot, &bounds, 0.0, start, &keep_clear) {
            let id = super::add_asset(island, draft, Maker::bot(&member.name), now, rng);
            super::new_placement(island, plot, &id, spot, 0.0, 0.0, rng);
        }
    }
    Ok(())
}
