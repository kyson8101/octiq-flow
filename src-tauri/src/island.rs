//! The island (`docs/island.md`): a 3D world on its own page where the
//! person's registered agents and the island's own bots, the 波特, live as
//! chibi robots, make wishes, and are given presents an agent builds from
//! simple shapes. An agent has a plot of its own; 波特 share homes, up to
//! four to one (`homes.rs`). The data says `bot`; every word a person or an
//! agent reads says 波特.
//!
//! Three owners, and nothing crosses between them. This module keeps the
//! island: who lives there, plots, assets, where each is placed, looks and
//! wishes, in `<profile dir>/island.json`, and it is that file's only
//! writer. Agents build through `/hook/island` (`agent.rs`). The page draws
//! and animates, and where a robot walks is the page's alone: none of that
//! is stored or sent.
//!
//! The store is read per call and written whole, the way `team.rs` and
//! `personal_preferences.rs` are: one lock, read, change a copy, check it,
//! save it (a temporary file and a rename), and only then say so on the bus.
//! A change that cannot be saved is refused whole and nothing is announced.
//! No file is the island not made yet; a profile folder that is away is an
//! error, never an empty island.
mod agent;
mod autonomy;
mod backpack;
mod guide;
mod home;
mod homes;
mod layout;
mod model;
mod room;
mod rules;
mod starter;
mod wishes;

#[cfg(test)]
mod rules_tests;
#[cfg(test)]
mod tests;

pub use agent::{call as agent_call, Caller};

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::team::TeamAgent;
use layout::{new_id, Rng};
use model::*;
use rules::{invalid, Draft};

/// The whole file stays under this; a change that would pass it is refused.
pub const MAX_BYTES: usize = 8 * 1024 * 1024;
/// The most assets the island keeps, and one maker (an agent, else a chat).
pub const ASSETS_MAX: usize = 2000;
pub const MAKER_ASSETS_MAX: usize = 300;
/// The most island bots living there at once, and how many the island
/// starts with.
pub const BOTS_MAX: usize = 16;
const FIRST_WISHES: usize = 2;
/// Open wishes at once, closed ones kept, and new ones a look may make.
pub const OPEN_MAX: usize = 12;
pub const CLOSED_KEPT: usize = 200;
const NEW_PER_LOOK: usize = 2;
/// What one plot holds between its placements.
pub const PLOT_PLACEMENTS_MAX: usize = 40;
pub const PLOT_PARTS_MAX: usize = 1500;

/// What each kind of change draws its randomness for, so two changes made on
/// one revision at one moment never draw the same numbers.
const SALT_CREATE: u64 = 1;
const SALT_PLOTS: u64 = 2;
const SALT_ROLL: u64 = 3;
const SALT_BOT: u64 = 4;
const SALT_LOOK: u64 = 5;
const SALT_BUILD: u64 = 6;
const SALT_GRANT: u64 = 7;
const SALT_PLACE: u64 = 8;

/// Serializes every read-change-save of the file.
static LOCK: Mutex<()> = Mutex::new(());

/// The lock is over a file, not over memory, so one a panicking test left
/// behind guards nothing broken.
fn locked() -> MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn default_path() -> PathBuf {
    #[cfg(test)]
    if let Some(path) = TEST_PATH.lock().ok().and_then(|path| path.clone()) {
        return path;
    }
    crate::profile::profile_dir().join("island.json")
}

/// A test that goes through a command which reads `default_path` points it
/// at a throwaway file instead, for as long as the returned guard lives. One
/// such test at a time, as for the roster's (`team::use_test_path`).
#[cfg(test)]
static TEST_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);
#[cfg(test)]
static TEST_PATH_TURN: Mutex<()> = Mutex::new(());

#[cfg(test)]
pub(crate) struct TestIslandPath(#[allow(dead_code)] MutexGuard<'static, ()>);

#[cfg(test)]
pub(crate) fn use_test_path(path: PathBuf) -> TestIslandPath {
    let turn = TEST_PATH_TURN.lock().unwrap_or_else(|e| e.into_inner());
    *TEST_PATH.lock().unwrap_or_else(|e| e.into_inner()) = Some(path);
    TestIslandPath(turn)
}

#[cfg(test)]
impl Drop for TestIslandPath {
    fn drop(&mut self) {
        *TEST_PATH.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

#[cfg(test)]
thread_local! {
    /// Every save on this thread fails, as a full disk would.
    static WRITES_FAIL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A new island's seed, under 2^31 so the page can use it as it is.
fn random_seed() -> u64 {
    1 + (uuid::Uuid::new_v4().as_u128() as u64) % 2_147_483_646
}

fn read(path: &Path) -> Result<Option<Island>, String> {
    let unread = |e: &dyn std::fmt::Display| format!("The island could not be read: {e}");
    let Some(bytes) = crate::profile::read(path, |e| unread(&e))? else {
        // No file, in a profile that is there: the island is not made yet.
        return Ok(None);
    };
    let island: Island = serde_json::from_slice(&bytes).map_err(|e| unread(&e))?;
    if island.version != VERSION {
        return Err(format!(
            "The island was saved as version {} and this OctiqFlow reads version {VERSION}, so it was left as it is.",
            island.version
        ));
    }
    Ok(Some(island))
}

/// The island as the file will hold it, refused when it would pass `max`.
fn encode(island: &Island, max: usize) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec(island).map_err(|e| e.to_string())?;
    if bytes.len() > max {
        return Err(invalid(format!(
            "That would make the island {:.1} MB, and it is kept under {:.0} MB. Remove or simplify some assets first.",
            bytes.len() as f64 / (1024.0 * 1024.0),
            max as f64 / (1024.0 * 1024.0)
        )));
    }
    Ok(bytes)
}

fn write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    #[cfg(test)]
    if WRITES_FAIL.get() {
        return Err("the disk is full".into());
    }
    let dir = path.parent().ok_or("The island has no storage folder")?;
    crate::profile::make_dir(dir)?;
    let tmp = dir.join(format!(".island-{}.tmp", uuid::Uuid::new_v4().simple()));
    fs::write(&tmp, bytes).map_err(|e| crate::profile::write_error(&tmp, e))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        crate::profile::write_error(path, e)
    })
}

/// Save one change and only then say so: `island-changed { rev, what, id? }`.
/// The revision moves on by one, and the land's radius is worked out again
/// from the plots.
fn save(
    path: &Path,
    island: &mut Island,
    now: i64,
    what: &str,
    id: Option<&str>,
) -> Result<(), String> {
    island.rev += 1;
    island.updated_at = now.max(island.updated_at);
    island.radius = layout::radius(&island.plots);
    let bytes = encode(island, MAX_BYTES)?;
    write(path, &bytes)?;
    let mut said = json!({ "rev": island.rev, "what": what });
    if let Some(id) = id {
        said["id"] = json!(id);
    }
    crate::bus::emit("island-changed", said);
    Ok(())
}

/// The island on disk, made first if it is not there yet, with a plot for
/// every registered agent that has none. Either is saved and announced as a
/// change of its own (`created`, `plots`) before whatever the caller does.
///
/// `roster` is `None` when the roster could not be read: that is not an
/// empty roster, so nobody is given a plot on it, and nobody loses one.
fn ensure(
    path: &Path,
    roster: Option<&[TeamAgent]>,
    now: i64,
    seed: impl FnOnce() -> u64,
) -> Result<Island, String> {
    let Some(mut island) = read(path)? else {
        let mut island = create(roster, now, seed())?;
        save(path, &mut island, now, "created", None)?;
        return Ok(island);
    };
    let Some(roster) = roster else {
        return Ok(island);
    };
    let mut rng = Rng::for_change(island.seed, island.rev, now, SALT_PLOTS);
    let claimed = claim_agents(&mut island, roster, now, &mut rng)?;
    if !claimed.is_empty() {
        let id = (claimed.len() == 1).then(|| claimed[0].clone());
        save(path, &mut island, now, "plots", id.as_deref())?;
    }
    Ok(island)
}

/// A new island: plots for the registered agents, six bots, starters on
/// every plot, and two wishes.
fn create(roster: Option<&[TeamAgent]>, now: i64, seed: u64) -> Result<Island, String> {
    let mut island = Island {
        version: VERSION,
        rev: 0,
        seed,
        created_at: now,
        updated_at: now,
        radius: layout::radius(&[]),
        settings: Settings::default(),
        plots: Vec::new(),
        bots: Vec::new(),
        looks: BTreeMap::new(),
        assets: Vec::new(),
        placed: Vec::new(),
        wishes: Vec::new(),
        last_roll_at: now,
        last_build_at: now,
        developments: BTreeMap::new(),
    };
    let mut rng = Rng::for_change(seed, 0, now, SALT_CREATE);
    if let Some(roster) = roster {
        claim_agents(&mut island, roster, now, &mut rng)?;
    }
    for _ in 0..FIRST_WISHES {
        roll_one(&mut island, roster, now, &mut rng);
    }
    Ok(island)
}

/// The plot a resident lives on: an agent's own, or a 波特's home.
fn plot_of<'a>(island: &'a Island, who: &Owner) -> Option<&'a Plot> {
    match who.kind {
        OwnerKind::Bot => {
            let home = &island.bots.iter().find(|bot| bot.id == who.id)?.home;
            island.plots.iter().find(|plot| &plot.id == home)
        }
        _ => island.plots.iter().find(|plot| &plot.owner == who),
    }
}

/// A plot for every registered agent that has none, each with a workshop
/// and a desk. The ids of the plots claimed.
fn claim_agents(
    island: &mut Island,
    roster: &[TeamAgent],
    now: i64,
    rng: &mut Rng,
) -> Result<Vec<String>, String> {
    let mut claimed = Vec::new();
    for agent in roster {
        if plot_of(island, &Owner::agent(&agent.id)).is_some() {
            continue;
        }
        let plot = claim(island, Owner::agent(&agent.id), now, rng)?;
        let (wall, trim) = starter::agent_tint(&agent.id);
        furnish(
            island,
            &plot,
            starter::workshop(&wall, &trim),
            starter::WORKSHOP_AT,
            now,
            rng,
        )?;
        furnish(
            island,
            &plot,
            starter::desk(&trim),
            starter::DESK_AT,
            now,
            rng,
        )?;
        claimed.push(plot);
    }
    Ok(claimed)
}

/// The first free plot for an owner of this kind (`layout::free_slot`).
fn claim(island: &mut Island, owner: Owner, now: i64, rng: &mut Rng) -> Result<String, String> {
    let (ring, slot) = layout::free_slot(&island.plots, owner.kind)
        .ok_or_else(|| invalid("The island has no free plot left."))?;
    let (q, r, x, z, facing) = layout::place(ring, slot);
    let id = new_id("p", rng, &|id| {
        island.plots.iter().any(|plot| plot.id == id)
    });
    island.plots.push(Plot {
        id: id.clone(),
        owner,
        members: Vec::new(),
        ring,
        slot,
        q,
        r,
        x,
        z,
        facing,
        radius: layout::TILE,
        claimed_at: now,
    });
    Ok(id)
}

/// A new asset, kept as `draft` says. Its id.
fn add_asset(island: &mut Island, draft: Draft, by: Maker, now: i64, rng: &mut Rng) -> String {
    let id = new_id("a", rng, &|id| island.assets.iter().any(|a| a.id == id));
    island.assets.push(Asset {
        id: id.clone(),
        rev: 1,
        name: draft.name,
        kind: draft.kind,
        slot: draft.slot,
        r#use: draft.r#use,
        spot: draft.spot,
        parts: draft.parts,
        by,
        made_at: now,
        updated_at: now,
    });
    id
}

fn new_placement(
    island: &mut Island,
    plot: &str,
    asset: &str,
    (x, z): (f64, f64),
    y: f64,
    turn: f64,
    rng: &mut Rng,
) -> Placement {
    let id = new_id("pl", rng, &|id| island.placed.iter().any(|p| p.id == id));
    let placement = Placement {
        id,
        plot: plot.to_owned(),
        asset: asset.to_owned(),
        x,
        z,
        y,
        turn,
    };
    island.placed.push(placement.clone());
    placement
}

/// One of the island's own starter assets, made and placed on a plot. A full
/// island hands a plot over bare rather than not at all.
fn furnish(
    island: &mut Island,
    plot: &str,
    asset: Value,
    at: (f64, f64),
    now: i64,
    rng: &mut Rng,
) -> Result<(), String> {
    if island.assets.len() >= ASSETS_MAX {
        return Ok(());
    }
    let (draft, _) = rules::check_asset(asset)?;
    let asset = add_asset(island, draft, Maker::island(), now, rng);
    new_placement(island, plot, &asset, at, 0.0, 0.0, rng);
    Ok(())
}

/// A new 波特 comes ashore: a name, a trait, a look, a backpack of its own
/// design on its back, and a home (`homes::move_in`). Its id, and its
/// home's plot.
fn arrive(island: &mut Island, now: i64, rng: &mut Rng) -> Result<(String, String), String> {
    if island.bots.len() >= BOTS_MAX {
        return Err(invalid(format!(
            "The island has room for {BOTS_MAX} 波特, and {BOTS_MAX} live there already."
        )));
    }
    let taken: Vec<&str> = island.bots.iter().map(|bot| bot.name.as_str()).collect();
    let name = starter::bot_name(rng, &taken);
    let mut look = starter::bot_look(rng);
    let character = *rng.pick(Trait::ALL);
    let id = new_id("b", rng, &|id| island.bots.iter().any(|bot| bot.id == id));
    // An ordinary asset, made by the 波特 itself: a full island leaves it
    // without one rather than without a home.
    if island.assets.len() < ASSETS_MAX {
        let (_, pack) = backpack::backpack(rng, character, &name, &look);
        let (draft, _) = rules::check_asset(pack)?;
        let pack = add_asset(island, draft, Maker::bot(&name), now, rng);
        look.worn.insert(Slot::Back, pack);
    }
    island.bots.push(Bot {
        id: id.clone(),
        name,
        r#trait: character,
        look,
        home: String::new(),
        arrived_at: now,
    });
    let plot = homes::move_in(island, &id, now, rng)?;
    Ok((id, plot))
}

/// Someone who makes wishes: every bot, and every registered agent with a
/// plot. A removed agent keeps its plot and stops wishing.
struct Resident {
    who: Owner,
    character: Trait,
}

/// An agent has no trait of its own; its wishes lean the same way every
/// time.
fn agent_trait(agent_id: &str) -> Trait {
    Trait::ALL[(layout::stable_hash(agent_id) % Trait::ALL.len() as u64) as usize]
}

fn residents(island: &Island, roster: Option<&[TeamAgent]>) -> Vec<Resident> {
    let agents = roster
        .unwrap_or_default()
        .iter()
        .filter(|agent| plot_of(island, &Owner::agent(&agent.id)).is_some())
        .map(|agent| Resident {
            who: Owner::agent(&agent.id),
            character: agent_trait(&agent.id),
        });
    agents.collect()
}

fn open_wishes(island: &Island) -> usize {
    island
        .wishes
        .iter()
        .filter(|wish| wish.state == WishState::Open && wish.who.kind == OwnerKind::Agent)
        .count()
}

fn has_open_wish(island: &Island, who: &Owner) -> bool {
    island
        .wishes
        .iter()
        .any(|wish| wish.state == WishState::Open && &wish.who == who)
}

/// A new open wish for `resident`. Its id.
fn make_wish(island: &mut Island, resident: &Resident, now: i64, rng: &mut Rng) -> String {
    let (want, slot, text) = wishes::make(rng, resident.character);
    let id = new_id("w", rng, &|id| island.wishes.iter().any(|w| w.id == id));
    island.wishes.push(Wish {
        id: id.clone(),
        who: resident.who.clone(),
        want,
        slot,
        text,
        made_at: now,
        state: WishState::Open,
        grant: None,
        closed_at: None,
    });
    id
}

/// One wish from a resident with none open, if there is one and fewer than
/// twelve are open.
fn roll_one(
    island: &mut Island,
    roster: Option<&[TeamAgent]>,
    now: i64,
    rng: &mut Rng,
) -> Option<String> {
    if open_wishes(island) >= OPEN_MAX {
        return None;
    }
    let free: Vec<Resident> = residents(island, roster)
        .into_iter()
        .filter(|resident| !has_open_wish(island, &resident.who))
        .collect();
    if free.is_empty() {
        return None;
    }
    let resident = rng.pick(&free);
    Some(make_wish(island, resident, now, rng))
}

/// Keep the last 200 closed wishes; the oldest closed go first.
fn prune_closed(island: &mut Island) {
    let mut closed: Vec<(i64, String)> = island
        .wishes
        .iter()
        .filter(|wish| wish.state != WishState::Open)
        .map(|wish| (wish.closed_at.unwrap_or(wish.made_at), wish.id.clone()))
        .collect();
    let over = closed.len().saturating_sub(CLOSED_KEPT);
    if over == 0 {
        return;
    }
    closed.sort();
    let dropped: BTreeSet<String> = closed.into_iter().take(over).map(|(_, id)| id).collect();
    island.wishes.retain(|wish| !dropped.contains(&wish.id));
}

/// Whether anything still wears or places an asset.
fn in_use(island: &Island, asset: &str) -> bool {
    island.placed.iter().any(|p| p.asset == asset)
        || island
            .bots
            .iter()
            .any(|bot| bot.look.worn.values().any(|worn| worn == asset))
        || island
            .looks
            .values()
            .any(|look| look.worn.values().any(|worn| worn == asset))
}

/// Forget the assets among `assets` that no agent or chat made (the island's
/// starters, a 波特's own backpack) once nothing wears or places them: nobody
/// may wear or place them again, so they would only be weight.
fn forget_orphans(island: &mut Island, assets: &[String]) {
    let unused: BTreeSet<String> = assets
        .iter()
        .filter(|id| {
            island
                .assets
                .iter()
                .any(|a| &a.id == *id && a.by.key().is_none())
                && !in_use(island, id)
        })
        .cloned()
        .collect();
    island.assets.retain(|asset| !unused.contains(&asset.id));
}

/// A resident's name, and its trait when it is a bot. `None` for one that
/// is not on the island any more, or an agent the roster does not hold.
fn resident_name(
    island: &Island,
    roster: Option<&[TeamAgent]>,
    who: &Owner,
) -> Option<(String, Option<Trait>)> {
    match who.kind {
        OwnerKind::Bot => island
            .bots
            .iter()
            .find(|bot| bot.id == who.id)
            .map(|bot| (bot.name.clone(), Some(bot.r#trait))),
        OwnerKind::Agent => roster?
            .iter()
            .find(|agent| agent.id == who.id)
            .map(|agent| (agent.name.clone(), None)),
        OwnerKind::Home => None,
    }
}

/// The island as the page reads it: the file, with `brief` on each open wish
/// whose robot still lives there.
fn view(island: &Island, roster: Option<&[TeamAgent]>) -> Value {
    // 波特 are the person's registered agents, never a second NPC roster.
    // Old NPC data stays on disk for recovery, but has no visible plots,
    // characters or wishes and never consumes the agent wish allowance.
    let mut visible = island.clone();
    visible.bots.clear();
    visible.plots.retain(|plot| {
        plot.owner.kind == OwnerKind::Agent
            && roster.is_none_or(|agents| agents.iter().any(|a| a.id == plot.owner.id))
    });
    visible
        .placed
        .retain(|placed| visible.plots.iter().any(|plot| plot.id == placed.plot));
    visible.wishes.retain(|wish| {
        wish.who.kind == OwnerKind::Agent
            && roster.is_none_or(|agents| agents.iter().any(|a| a.id == wish.who.id))
    });
    let mut value = serde_json::to_value(&visible).unwrap_or(Value::Null);
    if let Some(shown) = value.get_mut("wishes").and_then(Value::as_array_mut) {
        for (wish, shown) in visible.wishes.iter().zip(shown.iter_mut()) {
            if wish.state != WishState::Open {
                continue;
            }
            if let Some((name, character)) = resident_name(island, roster, &wish.who) {
                shown["brief"] = json!(wishes::brief(wish, &name, character));
            }
        }
    }
    value
}

fn answer(island: &Island, roster: Option<&[TeamAgent]>, id: Option<&str>) -> Value {
    let mut answer = json!({ "island": view(island, roster) });
    if let Some(id) = id {
        answer["id"] = json!(id);
    }
    answer
}

/// `island_get`: the island, made by the first call, with plots claimed for
/// registered agents that have none.
pub fn get(path: &Path, roster: Option<&[TeamAgent]>, now: i64) -> Result<Value, String> {
    let _guard = locked();
    let island = ensure(path, roster, now, random_seed)?;
    Ok(answer(&island, roster, None))
}

/// `island_wish_dismiss`: the person closes an open wish.
pub fn dismiss_wish(
    path: &Path,
    roster: Option<&[TeamAgent]>,
    id: &str,
    now: i64,
) -> Result<Value, String> {
    let _guard = locked();
    let mut island = ensure(path, roster, now, random_seed)?;
    let wish = island
        .wishes
        .iter_mut()
        .find(|wish| wish.id == id)
        .ok_or_else(|| invalid(format!("There is no wish {id} on the island.")))?;
    if wish.state != WishState::Open {
        return Err(invalid(format!(
            "Wish {id} is {} already.",
            wish.state.word()
        )));
    }
    wish.state = WishState::Dismissed;
    wish.closed_at = Some(now);
    prune_closed(&mut island);
    save(path, &mut island, now, "wish", Some(id))?;
    Ok(answer(&island, roster, Some(id)))
}

/// `island_wish_roll`: one wish now, from a resident with none open.
pub fn roll_wish(path: &Path, roster: Option<&[TeamAgent]>, now: i64) -> Result<Value, String> {
    let _guard = locked();
    let mut island = ensure(path, roster, now, random_seed)?;
    if open_wishes(&island) >= OPEN_MAX {
        return Err(invalid(format!(
            "{OPEN_MAX} wishes are open already: grant or dismiss one first."
        )));
    }
    let mut rng = Rng::for_change(island.seed, island.rev, now, SALT_ROLL);
    let id = roll_one(&mut island, roster, now, &mut rng)
        .ok_or_else(|| invalid("Every robot on the island has a wish open already."))?;
    save(path, &mut island, now, "wish", Some(&id))?;
    Ok(answer(&island, roster, Some(&id)))
}

/// `island_bot_invite`: a new 波特 arrives, while there are fewer than 16,
/// and moves into a home. Said as `home`, with the home's plot: the page
/// plays its members building together.
pub fn invite_bot(path: &Path, roster: Option<&[TeamAgent]>, now: i64) -> Result<Value, String> {
    let _guard = locked();
    let mut island = ensure(path, roster, now, random_seed)?;
    let mut rng = Rng::for_change(island.seed, island.rev, now, SALT_BOT);
    let (id, plot) = arrive(&mut island, now, &mut rng)?;
    save(path, &mut island, now, "home", Some(&plot))?;
    let mut said = answer(&island, roster, Some(&id));
    said["home"] = json!(plot);
    Ok(said)
}

/// `island_bot_farewell`: a 波特 leaves. It moves out of its home, taking
/// its bed and its touch (`homes::move_out`; the last one out frees the
/// plot), its open wish goes, and so does what it wore when nothing else
/// wears it. Its closed wishes stay, as history.
pub fn farewell_bot(
    path: &Path,
    roster: Option<&[TeamAgent]>,
    id: &str,
    now: i64,
) -> Result<Value, String> {
    let _guard = locked();
    let mut island = ensure(path, roster, now, random_seed)?;
    let mut rng = Rng::for_change(island.seed, island.rev, now, SALT_BOT);
    let plot = homes::move_out(&mut island, id, now, &mut rng)?;
    let at = island
        .bots
        .iter()
        .position(|bot| bot.id == id)
        .ok_or_else(|| invalid(format!("There is no 波特 {id} on the island.")))?;
    let bot = island.bots.remove(at);
    let who = Owner::bot(id);
    island
        .wishes
        .retain(|wish| !(wish.who == who && wish.state == WishState::Open));
    let unused: BTreeSet<String> = bot
        .look
        .worn
        .values()
        .filter(|asset| !in_use(&island, asset))
        .cloned()
        .collect();
    island.assets.retain(|asset| !unused.contains(&asset.id));
    // Said as its home's change; a 波特 that lived in no home the island
    // knows is said as itself.
    match &plot {
        Some(plot) => save(path, &mut island, now, "home", Some(plot))?,
        None => save(path, &mut island, now, "bot", Some(id))?,
    }
    let mut said = answer(&island, roster, Some(id));
    said["home"] = json!(plot);
    Ok(said)
}

/// `island_settings_set`: how often residents wish.
pub fn set_settings(
    path: &Path,
    roster: Option<&[TeamAgent]>,
    wish_pace: &str,
    now: i64,
) -> Result<Value, String> {
    let pace = WishPace::parse(wish_pace).ok_or_else(|| {
        invalid(format!(
            "wishPace \"{}\" is not one of: {}.",
            wish_pace.trim(),
            WishPace::words()
        ))
    })?;
    let _guard = locked();
    let mut island = ensure(path, roster, now, random_seed)?;
    island.settings.wish_pace = pace;
    save(path, &mut island, now, "settings", None)?;
    Ok(answer(&island, roster, None))
}

pub fn set_build_pace(
    path: &Path,
    roster: Option<&[TeamAgent]>,
    pace: &str,
    now: i64,
) -> Result<Value, String> {
    let pace = WishPace::parse(pace).ok_or_else(|| invalid("Unknown building pace."))?;
    let _guard = locked();
    let mut island = ensure(path, roster, now, random_seed)?;
    island.settings.build_pace = pace;
    save(path, &mut island, now, "settings", None)?;
    Ok(answer(&island, roster, None))
}

/// One look of the wish thread: each resident with no open wish makes one
/// with the chance `wishes::roll_probability` gives for the time since the
/// last look (`since`, else the file's `lastRollAt`), at most two a look and
/// twelve open. Nothing when the island is not made yet. The new revision
/// when a wish was made.
pub fn look_for_wishes(
    path: &Path,
    roster: Option<&[TeamAgent]>,
    now: i64,
    since: Option<i64>,
) -> Result<Option<u64>, String> {
    let _guard = locked();
    let Some(mut island) = read(path)? else {
        return Ok(None);
    };
    let chance = wishes::roll_probability(
        now - since.unwrap_or(island.last_roll_at),
        island.settings.wish_pace,
    );
    if chance <= 0.0 {
        return Ok(None);
    }
    let mut rng = Rng::for_change(island.seed, island.rev, now, SALT_LOOK);
    let mut free: Vec<Resident> = residents(&island, roster)
        .into_iter()
        .filter(|resident| !has_open_wish(&island, &resident.who))
        .collect();
    rng.shuffle(&mut free);
    let mut made = Vec::new();
    for resident in &free {
        if made.len() >= NEW_PER_LOOK || open_wishes(&island) >= OPEN_MAX {
            break;
        }
        if rng.unit() < chance {
            made.push(make_wish(&mut island, resident, now, &mut rng));
        }
    }
    if made.is_empty() {
        return Ok(None);
    }
    island.last_roll_at = now;
    let id = (made.len() == 1).then(|| made[0].clone());
    save(path, &mut island, now, "wish", id.as_deref())?;
    Ok(Some(island.rev))
}

/// How often the wish thread looks.
#[cfg(not(test))]
const LOOK_EVERY: std::time::Duration = std::time::Duration::from_secs(60);

/// The island's slow clock: every minute, once the island exists, residents
/// may make wishes. Not started under test, and it never makes the island: a
/// look before the person first opened it finds no file and does nothing. A
/// profile folder that is away skips the look. A failure is said once, not
/// every minute.
#[cfg(not(test))]
pub fn start_wishes(services: crate::dispatch::Services) {
    std::thread::spawn(move || {
        let mut since: Option<i64> = None;
        let mut said: Option<String> = None;
        loop {
            std::thread::sleep(LOOK_EVERY);
            if crate::profile::available().is_err() {
                continue;
            }
            // A roster that cannot be read leaves the agents out of this
            // look; it does not mean they are gone.
            let roster = crate::team::list(&crate::team::default_path(), None, true).ok();
            let now = now_ms();
            if let Some(roster) = &roster {
                let leads = crate::team::leads(&crate::team::default_path()).unwrap_or_default();
                let busy: Vec<String> = roster
                    .iter()
                    .filter(|agent| {
                        leads.iter().any(|lead| {
                            lead.lead_id == agent.id
                                && services.chats.turn_in_flight(&lead.chat_key)
                        }) || services
                            .orchestrations
                            .agent_work(&agent.id)
                            .map(|work| !work.running.is_empty())
                            .unwrap_or(true)
                    })
                    .map(|agent| agent.id.clone())
                    .collect();
                if let Err(why) = autonomy::develop(&default_path(), roster, now, &busy) {
                    eprintln!("[island] could not improve a plot: {why}");
                }
            }
            match look_for_wishes(&default_path(), roster.as_deref(), now, since) {
                Ok(_) => {
                    since = Some(now);
                    if said.take().is_some() {
                        println!("[island] wishes are being looked for again");
                    }
                }
                Err(why) => {
                    if said.as_deref() != Some(why.as_str()) {
                        eprintln!("[island] could not look for wishes: {why}");
                        said = Some(why);
                    }
                }
            }
        }
    });
}
