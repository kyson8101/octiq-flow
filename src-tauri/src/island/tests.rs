//! The island's store and its doors, end to end on a file of its own.
use std::path::Path;

use serde_json::{json, Value};

use super::agent::Caller;
use super::model::*;
use super::{layout, rules, starter};
use crate::team::TeamAgent;
use crate::test_dir::TestDir;

const NOW: i64 = 1_800_000_000_000;
const SEED: u64 = 12_345;

fn agent_named(id: &str, name: &str) -> TeamAgent {
    TeamAgent {
        id: id.into(),
        name: name.into(),
        role: String::new(),
        agent: crate::agent_chat::ChatAgent::Claude,
        model: "opus".into(),
        effort: None,
        access: crate::agent_provider::Access::Auto,
        project_id: None,
        reports_to: None,
        memory_note: None,
        avatar: None,
        team_id: None,
        persistent_prompt: String::new(),
        created_at: 0,
        updated_at: 0,
    }
}

fn roster() -> Vec<TeamAgent> {
    vec![agent_named("ag_nova", "Nova"), agent_named("ag_ada", "Ada")]
}

/// A made island on a file of its own.
struct Fixture {
    path: std::path::PathBuf,
    roster: Vec<TeamAgent>,
    _dir: TestDir,
}

impl Fixture {
    fn new() -> Self {
        let dir = TestDir::new("island");
        let fixture = Self {
            path: dir.join("island.json"),
            roster: roster(),
            _dir: dir,
        };
        let _guard = super::locked();
        // Legacy snapshots had six unregistered NPCs. Keep one explicit
        // fixture for backwards-compatible storage and gift/house validation;
        // production creation is tested separately and creates none.
        let mut legacy = super::ensure(&fixture.path, Some(&fixture.roster), NOW, || SEED).unwrap();
        let mut rng = layout::Rng::for_change(SEED, 0, NOW, super::SALT_CREATE);
        for _ in 0..6 {
            super::arrive(&mut legacy, NOW, &mut rng).unwrap();
        }
        legacy.radius = layout::radius(&legacy.plots);
        super::write(
            &fixture.path,
            &super::encode(&legacy, super::MAX_BYTES).unwrap(),
        )
        .unwrap();
        fixture
    }

    fn island(&self) -> Island {
        super::read(&self.path).unwrap().unwrap()
    }

    /// Change the island by hand, as a test sets the scene, and save it.
    fn edit(&self, change: impl FnOnce(&mut Island)) -> Island {
        let _guard = super::locked();
        let mut island = self.island();
        change(&mut island);
        super::save(&self.path, &mut island, NOW, "test", None).unwrap();
        island
    }

    /// An open wish for `who`, made by hand. Its id.
    fn wish(&self, who: &Owner, want: Want, slot: Option<Slot>) -> String {
        let id = format!("w_test{}", uuid::Uuid::new_v4().simple());
        let made = id.clone();
        self.edit(|island| {
            island
                .wishes
                .retain(|w| !(w.who == *who && w.state == WishState::Open));
            island.wishes.push(Wish {
                id: made,
                who: who.clone(),
                want,
                slot,
                text: "a thing — for a test".into(),
                made_at: NOW,
                state: WishState::Open,
                grant: None,
                closed_at: None,
            });
        });
        id
    }

    fn call(&self, caller: &Caller, action: &str, args: Value) -> Result<Value, String> {
        super::agent_call(&self.path, &self.roster, caller, action, args, NOW, &|| {
            Ok(true)
        })
    }

    fn bot(&self, at: usize) -> Bot {
        self.island().bots[at].clone()
    }
}

fn chat(key: &str) -> Caller {
    Caller {
        chat_key: key.into(),
        agent: None,
        worker: false,
        seat: false,
    }
}

fn nova() -> Caller {
    Caller {
        chat_key: "chat:nova-lead".into(),
        agent: Some(("ag_nova".into(), "Nova".into())),
        worker: false,
        seat: false,
    }
}

fn part(size: [f64; 3], at: [f64; 3]) -> Value {
    json!({ "shape": "round", "size": size, "at": at, "color": "#e9c46a" })
}

fn scarf() -> Value {
    json!({ "name": "Mustard scarf", "kind": "accessory", "slot": "neck",
            "parts": [part([0.7, 0.12, 0.5], [0.0, 0.0, 0.0])] })
}

fn armchair() -> Value {
    json!({ "name": "Armchair", "kind": "furniture", "use": "seat",
            "spot": { "at": [0, 0.35, 0.05], "face": 0 },
            "parts": [part([0.9, 0.35, 0.8], [0.0, 0.175, 0.0]), part([0.9, 0.6, 0.2], [0.0, 0.5, -0.3])] })
}

fn flower_bed() -> Value {
    json!({ "name": "Flower bed", "kind": "decor",
            "parts": [part([1.4, 0.3, 0.6], [0.0, 0.15, 0.0])] })
}

fn built(answer: &Value) -> String {
    answer["assetId"].as_str().expect("an asset id").to_string()
}

fn placements_on(island: &Island, plot: &str) -> Vec<Placement> {
    island
        .placed
        .iter()
        .filter(|p| p.plot == plot)
        .cloned()
        .collect()
}

fn plot_of(island: &Island, who: &Owner) -> Plot {
    super::plot_of(island, who).unwrap().clone()
}

fn asset_of<'a>(island: &'a Island, placement: &Placement) -> &'a Asset {
    island
        .assets
        .iter()
        .find(|a| a.id == placement.asset)
        .unwrap()
}

/// The homes, in ring and slot order.
fn homes(island: &Island) -> Vec<Plot> {
    let mut homes: Vec<Plot> = island
        .plots
        .iter()
        .filter(|p| p.owner.kind == OwnerKind::Home)
        .cloned()
        .collect();
    homes.sort_by_key(|p| (p.ring, p.slot));
    homes
}

/// Every non-building placement on a plot, as a box seen from above.
fn furniture_boxes(island: &Island, plot: &str) -> Vec<(String, Vec<[f64; 2]>)> {
    placements_on(island, plot)
        .into_iter()
        .filter(|p| asset_of(island, p).kind != Kind::Building)
        .map(|p| {
            let bounds = rules::asset_bounds(&asset_of(island, &p).parts);
            (
                p.id.clone(),
                rules::placed_box(&bounds, p.x, p.z, p.turn, 0.0),
            )
        })
        .collect()
}

#[test]
fn a_legacy_snapshot_keeps_its_npc_data_and_validates_its_plots_and_assets() {
    let f = Fixture::new();
    let island = f.island();
    assert_eq!((island.version, island.rev, island.seed), (1, 1, SEED));
    assert_eq!((island.created_at, island.last_roll_at), (NOW, NOW));
    assert_eq!(island.settings.wish_pace, WishPace::Sometimes);
    // The agents by the plaza, in roster order; six bots from ring 2.
    let agents: Vec<(u32, u32, &str)> = island
        .plots
        .iter()
        .filter(|p| p.owner.kind == OwnerKind::Agent)
        .map(|p| (p.ring, p.slot, p.owner.id.as_str()))
        .collect();
    assert_eq!(agents, vec![(1, 0, "ag_nova"), (1, 1, "ag_ada")]);
    assert_eq!(island.bots.len(), 6);
    for bot in &island.bots {
        let plot = plot_of(&island, &Owner::bot(&bot.id));
        assert_eq!(plot.ring, 2);
        assert_eq!(plot.radius, 6.3);
        assert!(starter::NAMES.contains(&bot.name.as_str()));
        assert!(rules::colour(&bot.look.shell).is_some());
        // Its own backpack, of its own design, on its back.
        assert_eq!(bot.look.worn.keys().collect::<Vec<_>>(), vec![&Slot::Back]);
        let pack = island
            .assets
            .iter()
            .find(|a| a.id == bot.look.worn[&Slot::Back])
            .unwrap();
        assert_eq!(pack.by, Maker::bot(&bot.name));
        assert_eq!((pack.kind, pack.slot), (Kind::Accessory, Some(Slot::Back)));
        assert!(
            pack.name.starts_with(&format!("{}'s ", bot.name)),
            "{}",
            pack.name
        );
    }
    let names: std::collections::BTreeSet<_> = island.bots.iter().map(|b| &b.name).collect();
    assert_eq!(names.len(), 6, "every 波特 has a name of its own");
    // The six live together: four in the first home, two in the next.
    let homes = homes(&island);
    assert_eq!(
        homes
            .iter()
            .map(|h| (h.ring, h.slot, h.members.len()))
            .collect::<Vec<_>>(),
        vec![(2, 0, 4), (2, 1, 2)]
    );
    let order: Vec<&String> = homes.iter().flat_map(|h| &h.members).collect();
    assert_eq!(order, island.bots.iter().map(|b| &b.id).collect::<Vec<_>>());
    // Every plot stands where its cell is and holds only what is on its tile.
    let mut expected = island.bots.len();
    for plot in &island.plots {
        let (q, r, x, z, facing) = layout::place(plot.ring, plot.slot);
        assert_eq!(
            (plot.q, plot.r, plot.x, plot.z, plot.facing),
            (q, r, x, z, facing)
        );
        let placed = placements_on(&island, &plot.id);
        for p in &placed {
            let asset = asset_of(&island, p);
            assert!(rules::fits_plot(
                &rules::asset_bounds(&asset.parts),
                p.x,
                p.z,
                p.turn
            ));
        }
        expected += placed.len();
        // An agent's plot is handed over with a workshop and a desk, made by
        // the island.
        if plot.owner.kind == OwnerKind::Agent {
            assert!(plot.members.is_empty());
            let kinds: Vec<Kind> = placed.iter().map(|p| asset_of(&island, p).kind).collect();
            assert_eq!(kinds, vec![Kind::Building, Kind::Furniture]);
            assert!(placed
                .iter()
                .all(|p| asset_of(&island, p).by == Maker::island()));
        }
    }
    assert_eq!(
        island.assets.len(),
        expected,
        "one asset for each placement and pack"
    );
    let open: Vec<&Wish> = island
        .wishes
        .iter()
        .filter(|w| w.state == WishState::Open)
        .collect();
    assert_eq!(open.len(), 2);
    assert_ne!(open[0].who, open[1].who);
    // Ring 2 is the outermost in use.
    assert_eq!(island.radius, rules::mm(14.0 * 3f64.sqrt() + 13.0));
    // The same seed at the same moment is the same island.
    let again = Fixture::new();
    let mut other = again.island();
    other.updated_at = island.updated_at;
    assert_eq!(other, island);
}

#[test]
fn get_answers_the_island_with_a_brief_on_each_open_wish_and_claims_new_agents() {
    let f = Fixture::new();
    let before = f.island();
    let answer = super::get(&f.path, Some(&f.roster), NOW + 1).unwrap();
    // Nothing to claim: nothing saved.
    assert_eq!(answer["island"]["rev"], 1);
    for wish in answer["island"]["wishes"].as_array().unwrap() {
        let brief = wish["brief"].as_str().expect("an open wish has a brief");
        assert!(brief.contains(wish["id"].as_str().unwrap()), "{brief}");
        assert!(brief.contains(wish["text"].as_str().unwrap()), "{brief}");
    }
    assert_eq!(super::read(&f.path).unwrap().unwrap(), before);

    // A newly registered agent is given the next plot by the plaza.
    let mut more = f.roster.clone();
    more.push(agent_named("ag_kip", "Kip"));
    let answer = super::get(&f.path, Some(&more), NOW + 2).unwrap();
    assert_eq!(answer["island"]["rev"], 2);
    let island = f.island();
    let kip = plot_of(&island, &Owner::agent("ag_kip"));
    assert_eq!((kip.ring, kip.slot), (1, 2));
    assert_eq!(placements_on(&island, &kip.id).len(), 2);
    // An agent no longer registered keeps its plot.
    super::get(&f.path, Some(&more[1..]), NOW + 3).unwrap();
    let island = f.island();
    assert!(island
        .plots
        .iter()
        .any(|p| p.owner == Owner::agent("ag_nova")));
    assert_eq!(island.rev, 2);
    // A roster that could not be read claims nothing and loses nothing.
    let answer = super::get(&f.path, None, NOW + 4).unwrap();
    assert_eq!(
        answer["island"]["plots"].as_array().unwrap().len(),
        island
            .plots
            .iter()
            .filter(|plot| plot.owner.kind == OwnerKind::Agent)
            .count()
    );
}

#[test]
fn a_dismissed_wish_is_closed_saved_and_announced() {
    let f = Fixture::new();
    let pip = f.bot(0);
    let id = f.wish(&Owner::bot(&pip.id), Want::Decor, None);
    let rev = f.island().rev;
    let tap = crate::bus::tap::Tap::on(&id);
    let answer = super::dismiss_wish(&f.path, Some(&f.roster), &id, NOW + 5).unwrap();
    assert_eq!(answer["id"], json!(id));
    let island = f.island();
    let wish = island.wishes.iter().find(|w| w.id == id).unwrap();
    assert_eq!(wish.state, WishState::Dismissed);
    assert_eq!(wish.closed_at, Some(NOW + 5));
    assert_eq!(island.rev, rev + 1);
    assert_eq!(
        tap.heard(),
        vec![(
            "island-changed".to_string(),
            json!({ "rev": rev + 1, "what": "wish", "id": id })
        )]
    );
    // Closed is closed, and a wish nobody made is nobody's.
    assert!(super::dismiss_wish(&f.path, Some(&f.roster), &id, NOW)
        .unwrap_err()
        .contains("dismissed already"));
    assert!(super::dismiss_wish(&f.path, Some(&f.roster), "w_none", NOW)
        .unwrap_err()
        .contains("no wish w_none"));
    assert_eq!(f.island().rev, rev + 1);
}

#[test]
fn a_change_that_cannot_be_saved_is_refused_whole_and_said_nowhere() {
    let f = Fixture::new();
    let pip = f.bot(0);
    let id = f.wish(&Owner::bot(&pip.id), Want::Decor, None);
    let before = f.island();
    let tap = crate::bus::tap::Tap::on(&id);
    super::WRITES_FAIL.set(true);
    let failed = super::dismiss_wish(&f.path, Some(&f.roster), &id, NOW + 9);
    super::WRITES_FAIL.set(false);
    assert_eq!(failed.unwrap_err(), "the disk is full");
    assert_eq!(f.island(), before, "nothing of the change was kept");
    assert!(tap.heard().is_empty(), "{:?}", tap.heard());
    // And one that would pass 8 MB is refused before anything is written.
    let why = super::encode(&before, 1000).unwrap_err();
    assert!(why.contains("kept under"), "{why}");
}

/// The doc's own words: a profile folder that is away is an error, never an
/// empty island, and nothing makes the folder again or writes into another
/// one put at its path.
#[test]
fn the_island_is_an_error_while_the_profile_folder_is_away() {
    use crate::profile::tests::{everything_in, Home};
    let home = Home::with_a_configured_base();
    let _process = crate::profile::started_in(&home.dir);
    let dir = crate::profile::profile_dir();
    let path = dir.join("island.json");
    let roster = roster();
    let made = super::get(&path, Some(&roster), NOW).unwrap();
    assert_eq!(made["island"]["rev"], 1);

    home.move_away();
    let why = crate::profile::available().unwrap_err();
    assert_eq!(super::get(&path, Some(&roster), NOW).unwrap_err(), why);
    assert_eq!(
        super::look_for_wishes(&path, Some(&roster), NOW + 3_600_000, None).unwrap_err(),
        why
    );
    assert!(!dir.exists(), "the island made the profile folder again");
    home.move_back();
    assert_eq!(
        super::get(&path, Some(&roster), NOW).unwrap()["island"],
        made["island"]
    );

    home.replace();
    let before = everything_in(&dir);
    assert!(super::invite_bot(&path, Some(&roster), NOW).is_err());
    assert_eq!(
        everything_in(&dir),
        before,
        "the island wrote into another folder"
    );
    home.move_back();

    home.unplug();
    assert!(super::roll_wish(&path, Some(&roster), NOW).is_err());
    home.plug_back();
    assert_eq!(super::read(&path).unwrap().unwrap().rev, 1);
}

#[test]
fn wishes_come_at_the_pace_set_two_a_look_and_twelve_open_at_most() {
    let f = Fixture::new();
    // No island yet is no look at all: nothing is made.
    let empty = TestDir::new("island-none");
    let none = empty.join("island.json");
    assert_eq!(
        super::look_for_wishes(&none, Some(&f.roster), NOW, None),
        Ok(None)
    );
    assert!(!none.exists());

    // Never is never.
    f.edit(|island| island.settings.wish_pace = WishPace::Never);
    assert_eq!(
        super::look_for_wishes(&f.path, Some(&f.roster), NOW + 3_600_000, None),
        Ok(None)
    );
    f.edit(|island| island.settings.wish_pace = WishPace::Often);
    let open = |island: &Island| {
        island
            .wishes
            .iter()
            .filter(|w| w.state == WishState::Open)
            .count()
    };
    let mut now = NOW;
    let mut since = None;
    for _ in 0..300 {
        now += 60_000;
        let before = open(&f.island());
        let made = super::look_for_wishes(&f.path, Some(&f.roster), now, since).unwrap();
        since = Some(now);
        let island = f.island();
        let after = open(&island);
        assert!(after <= super::OPEN_MAX);
        assert!(after - before <= 2, "{before} -> {after}");
        if made.is_some() {
            assert_eq!(island.last_roll_at, now);
        }
        // Nobody has two open at once.
        let mut who: Vec<&Owner> = island
            .wishes
            .iter()
            .filter(|w| w.state == WishState::Open)
            .map(|w| &w.who)
            .collect();
        let all = who.len();
        who.dedup();
        who.sort_by_key(|o| (o.kind, o.id.clone()));
        who.dedup();
        assert_eq!(who.len(), all);
    }
    // Five hours at one look a minute, often: every resident has asked.
    let island = f.island();
    assert_eq!(open(&island), f.roster.len().min(super::OPEN_MAX));
    // An agent no longer registered stops wishing.
    assert!(island
        .wishes
        .iter()
        .all(|w| w.who.kind == OwnerKind::Bot || w.who.id.starts_with("ag_")));
}

#[test]
fn a_roll_is_one_wish_now_and_refused_when_there_is_nobody_to_wish() {
    let f = Fixture::new();
    let mut made = Vec::new();
    for at in 0..20 {
        match super::roll_wish(&f.path, Some(&f.roster), NOW + at) {
            Ok(answer) => made.push(answer["id"].as_str().unwrap().to_string()),
            Err(why) => {
                assert!(why.contains("has a wish open already"), "{why}");
                break;
            }
        }
    }
    // Eight residents, two of whom wished when the island was made.
    assert_eq!(made.len(), 0);
    // Twelve open is the most, whoever is left.
    f.edit(|island| {
        for at in 0..10 {
            island.bots.push(Bot {
                id: format!("b_extra{at}"),
                name: format!("Extra {at}"),
                r#trait: Trait::Cozy,
                look: starter::bot_look(&mut layout::Rng::new(at)),
                home: String::new(),
                arrived_at: NOW,
            });
        }
    });
    let why = super::roll_wish(&f.path, Some(&f.roster), NOW).unwrap_err();
    assert!(why.contains("has a wish open already"), "{why}");
    assert_eq!(super::open_wishes(&f.island()), f.roster.len());
}

#[test]
fn the_last_two_hundred_closed_wishes_are_kept() {
    let f = Fixture::new();
    let island = f.edit(|island| {
        for at in 0..205 {
            island.wishes.push(Wish {
                id: format!("w_old{at}"),
                who: Owner::bot("b_gone"),
                want: Want::Decor,
                slot: None,
                text: "a thing — long ago".into(),
                made_at: at,
                state: WishState::Granted,
                grant: None,
                closed_at: Some(1000 + at),
            });
        }
        super::prune_closed(island);
    });
    let closed: Vec<&str> = island
        .wishes
        .iter()
        .filter(|w| w.state != WishState::Open)
        .map(|w| w.id.as_str())
        .collect();
    assert_eq!(closed.len(), super::CLOSED_KEPT);
    assert!(!closed.contains(&"w_old4") && closed.contains(&"w_old5"));
    assert_eq!(
        island
            .wishes
            .iter()
            .filter(|w| w.state == WishState::Open)
            .count(),
        2
    );
}

fn island_bots(f: &Fixture) -> usize {
    f.island().bots.len()
}

fn bot_named(island: &Island, id: &str) -> Bot {
    island.bots.iter().find(|b| b.id == id).unwrap().clone()
}

/// A home's own house, as the members built it.
fn house_of(island: &Island, plot: &str) -> Asset {
    placements_on(island, plot)
        .iter()
        .map(|p| asset_of(island, p))
        .find(|a| a.kind == Kind::Building)
        .unwrap()
        .clone()
}

/// Nothing a home holds stands on top of anything else, and every member
/// has its bed and its touch.
fn assert_home_in_order(island: &Island, plot: &str) {
    let boxes = furniture_boxes(island, plot);
    for (at, (one, shape)) in boxes.iter().enumerate() {
        for (other, theirs) in &boxes[at + 1..] {
            assert!(!rules::overlaps(shape, theirs), "{one} and {other} overlap");
        }
    }
    let home = island.plots.iter().find(|p| p.id == plot).unwrap();
    for member in &home.members {
        let bot = bot_named(island, member);
        assert_eq!(bot.home, plot);
        let own: Vec<&Asset> = placements_on(island, plot)
            .iter()
            .map(|p| asset_of(island, p))
            .filter(|a| a.by == Maker::bot(&bot.name))
            .collect();
        assert_eq!(own.len(), 2, "{} has a bed and a touch", bot.name);
        assert_eq!(own.iter().filter(|a| a.r#use == Some(Use::Bed)).count(), 1);
    }
}

#[test]
fn a_new_波特_moves_into_the_first_home_with_room_and_it_is_built_again() {
    let f = Fixture::new();
    let before = f.island();
    let second = homes(&before)[1].clone();
    let old = house_of(&before, &second.id);
    let tap = crate::bus::tap::Tap::on(&second.id);
    let answer = super::invite_bot(&f.path, Some(&f.roster), NOW + 1).unwrap();
    let id = answer["id"].as_str().unwrap().to_string();
    assert_eq!(answer["home"], json!(second.id));
    let island = f.island();
    let home = island.plots.iter().find(|p| p.id == second.id).unwrap();
    assert_eq!(home.members.len(), 3);
    assert_eq!(home.members[2], id);
    // The same house, built again under all three names; its shape is the
    // founder's, who still lives there.
    let new = house_of(&island, &second.id);
    assert_eq!((new.id.as_str(), new.rev), (old.id.as_str(), old.rev + 1));
    let names: Vec<String> = home
        .members
        .iter()
        .map(|m| bot_named(&island, m).name)
        .collect();
    let names: Vec<&str> = names.iter().map(String::as_str).collect();
    assert_eq!(new.by, Maker::bot(&super::home::names(&names)));
    assert_eq!(new.name, old.name);
    assert_home_in_order(&island, &second.id);
    let said = tap.heard();
    assert_eq!(said.last().unwrap().1["what"], "home");
    assert_eq!(said.last().unwrap().1["id"], json!(second.id));

    // Four to a home; then a new home on the next free cell of ring 2.
    while island_bots(&f) < super::BOTS_MAX {
        super::invite_bot(&f.path, Some(&f.roster), NOW + 2).unwrap();
    }
    let island = f.island();
    let all = homes(&island);
    assert_eq!(
        all.iter()
            .map(|h| (h.ring, h.slot, h.members.len()))
            .collect::<Vec<_>>(),
        vec![(2, 0, 4), (2, 1, 4), (2, 2, 4), (2, 3, 4)]
    );
    for home in &all {
        assert_home_in_order(&island, &home.id);
    }
    let why = super::invite_bot(&f.path, Some(&f.roster), NOW).unwrap_err();
    assert!(why.contains("room for 16 波特"), "{why}");
    let names: std::collections::BTreeSet<_> = island.bots.into_iter().map(|b| b.name).collect();
    assert_eq!(names.len(), 16);
}

#[test]
fn a_波特_moves_out_with_its_bed_and_touch_and_the_last_one_out_frees_the_home() {
    let f = Fixture::new();
    let island = f.island();
    let first = homes(&island)[0].clone();
    let (founder, pip) = (
        first.members[0].clone(),
        bot_named(&island, &first.members[1]),
    );
    // A present of its own, and one another 波特 wears too.
    let wish = f.wish(&Owner::bot(&pip.id), Want::Decor, None);
    let gift = built(&f.call(&chat("chat:giver"), "build", scarf()).unwrap());
    let shared = built(
        &f.call(&chat("chat:giver"), "build", json!({ "name": "Shared cap", "kind": "accessory", "slot": "head", "parts": [part([0.5, 0.2, 0.5], [0.0, 0.1, 0.0])] }))
            .unwrap(),
    );
    f.edit(|island| {
        for bot in island.bots.iter_mut() {
            if bot.id == pip.id {
                bot.look.worn.insert(Slot::Neck, gift.clone());
            }
            if bot.id == pip.id || bot.id == founder {
                bot.look.worn.insert(Slot::Head, shared.clone());
            }
        }
    });
    let before = f.island();
    let old = house_of(&before, &first.id);
    let mine: Vec<String> = placements_on(&before, &first.id)
        .iter()
        .filter(|p| asset_of(&before, p).by == Maker::bot(&pip.name))
        .map(|p| p.asset.clone())
        .collect();
    assert_eq!(mine.len(), 2);

    let answer = super::farewell_bot(&f.path, Some(&f.roster), &pip.id, NOW + 2).unwrap();
    assert_eq!(answer["home"], json!(first.id));
    let after = f.island();
    let home = after.plots.iter().find(|p| p.id == first.id).unwrap();
    assert_eq!(home.members.len(), 3);
    assert!(after.bots.iter().all(|b| b.id != pip.id));
    for gone in mine.iter().chain([&gift, &pip.look.worn[&Slot::Back]]) {
        assert!(after.assets.iter().all(|a| &a.id != gone), "{gone}");
    }
    assert!(
        after.assets.iter().any(|a| a.id == shared),
        "another still wears it"
    );
    assert!(after.wishes.iter().all(|w| w.id != wish));
    let rebuilt = house_of(&after, &first.id);
    assert_eq!(
        (rebuilt.id.as_str(), rebuilt.rev, rebuilt.name.as_str()),
        (old.id.as_str(), old.rev + 1, old.name.as_str())
    );
    assert_home_in_order(&after, &first.id);

    // The founder leaves: the next one chooses again, in the same house.
    super::farewell_bot(&f.path, Some(&f.roster), &founder, NOW + 3).unwrap();
    let after = f.island();
    let home = after
        .plots
        .iter()
        .find(|p| p.id == first.id)
        .unwrap()
        .clone();
    assert_eq!(home.members.len(), 2);
    let next = bot_named(&after, &home.members[0]);
    let style = super::home::choose(after.seed, &next.id, next.r#trait);
    let rebuilt = house_of(&after, &first.id);
    assert_eq!(
        (rebuilt.id.as_str(), rebuilt.name.as_str()),
        (old.id.as_str(), style.called())
    );
    assert_home_in_order(&after, &first.id);

    // The last ones out free the home, and what stood there goes.
    for member in &home.members {
        super::farewell_bot(&f.path, Some(&f.roster), member, NOW + 4).unwrap();
    }
    let after = f.island();
    assert!(after.plots.iter().all(|p| p.id != first.id));
    assert!(placements_on(&after, &first.id).is_empty());
    assert!(after.assets.iter().all(|a| a.id != old.id));
    assert!(super::farewell_bot(&f.path, Some(&f.roster), &pip.id, NOW)
        .unwrap_err()
        .contains("no 波特"));
    // The next to arrive moves in with the two in the other home; once it
    // is full, a new home takes the first free cell, the one just freed.
    let second = homes(&after)[0].clone();
    for _ in second.members.len()..super::homes::MEMBERS_MAX {
        let answer = super::invite_bot(&f.path, Some(&f.roster), NOW + 5).unwrap();
        assert_eq!(answer["home"], json!(second.id));
    }
    let answer = super::invite_bot(&f.path, Some(&f.roster), NOW + 6).unwrap();
    let made = f.island();
    let new = made
        .plots
        .iter()
        .find(|p| json!(p.id) == answer["home"])
        .unwrap();
    assert_eq!((new.ring, new.slot), (first.ring, first.slot));
    assert_eq!(new.owner.kind, OwnerKind::Home);
    assert_ne!(new.owner.id, first.owner.id);
}

#[test]
fn a_波特_with_no_home_the_island_knows_can_still_leave() {
    let f = Fixture::new();
    f.edit(|island| {
        island.bots.push(Bot {
            id: "b_lost".into(),
            name: "Lost".into(),
            r#trait: Trait::Curious,
            look: starter::bot_look(&mut layout::Rng::new(1)),
            home: "p_gone".into(),
            arrived_at: NOW,
        })
    });
    let tap = crate::bus::tap::Tap::on("b_lost");
    let answer = super::farewell_bot(&f.path, Some(&f.roster), "b_lost", NOW).unwrap();
    assert_eq!(answer["home"], Value::Null);
    assert!(f.island().bots.iter().all(|b| b.id != "b_lost"));
    assert_eq!(tap.heard().last().unwrap().1["what"], "bot");
}

#[test]
fn the_pace_is_one_of_four_words() {
    let f = Fixture::new();
    let answer = super::set_settings(&f.path, Some(&f.roster), "Often", NOW).unwrap();
    assert_eq!(answer["island"]["settings"]["wishPace"], "often");
    let why = super::set_settings(&f.path, Some(&f.roster), "hourly", NOW).unwrap_err();
    assert!(why.contains("often, sometimes, rarely, never"), "{why}");
}

#[test]
fn the_first_call_through_the_door_makes_the_island_too() {
    let dir = TestDir::new("island-door");
    let path = dir.join("island.json");
    let roster = roster();
    let answer = super::agent_call(&path, &roster, &nova(), "look", json!({}), NOW, &|| {
        Ok(true)
    })
    .unwrap();
    let island = super::read(&path).unwrap().unwrap();
    assert_eq!(island.rev, 1);
    assert_eq!(
        answer["you"]["plot"]["id"],
        json!(plot_of(&island, &Owner::agent("ag_nova")).id)
    );
}

#[test]
fn a_look_answers_the_guide_the_wish_its_robot_and_the_caller() {
    let f = Fixture::new();
    let pip = f.bot(0);
    let id = f.wish(&Owner::bot(&pip.id), Want::Accessory, Some(Slot::Neck));
    let answer = f.call(&nova(), "look", json!({ "wishId": id })).unwrap();
    assert!(answer["guide"]
        .as_str()
        .unwrap()
        .contains("Buildings have no roof"));
    assert_eq!(answer["wish"]["id"], json!(id));
    assert!(answer["wish"]["brief"]
        .as_str()
        .unwrap()
        .contains(&pip.name));
    assert_eq!(answer["wisher"]["name"], json!(pip.name));
    assert_eq!(answer["wisher"]["trait"], json!(pip.r#trait));
    // Its home: a house, and a bed and a touch for each of the four.
    let island = f.island();
    let home = plot_of(&island, &Owner::bot(&pip.id));
    assert_eq!(
        answer["wisher"]["placed"].as_array().unwrap().len(),
        placements_on(&island, &home.id).len()
    );
    assert_eq!(answer["wisher"]["home"]["plotId"], json!(home.id));
    let members = answer["wisher"]["home"]["members"].as_array().unwrap();
    assert_eq!(members.len(), 4);
    assert!(members.contains(&json!(pip.name)));
    assert_eq!(answer["wisher"]["plot"]["radius"], 6.3);
    assert_eq!(answer["you"]["name"], "Nova");
    assert_eq!(answer["you"]["placed"].as_array().unwrap().len(), 2);
    assert!(answer["openWishes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w["id"] == json!(id)));
    assert_eq!(
        answer["residents"].as_array().unwrap().len(),
        f.roster.len()
    );
    // A chat with no registered agent is "Chat", with what it made.
    let answer = f.call(&chat("chat:plain"), "look", json!({})).unwrap();
    assert_eq!(
        answer["you"],
        json!({ "name": "Chat", "chatKey": "chat:plain", "assets": [] })
    );
    assert!(f
        .call(&chat("chat:plain"), "look", json!({ "wishId": "w_none" }))
        .unwrap_err()
        .contains("no wish w_none"));
    // Looking saves nothing.
    assert_eq!(f.island().rev, 1 + 1);
}

#[test]
fn a_chat_builds_a_present_and_gives_it_and_the_robot_wears_it() {
    let f = Fixture::new();
    let pip = f.bot(0);
    let id = f.wish(&Owner::bot(&pip.id), Want::Accessory, Some(Slot::Neck));
    let giver = chat("chat:giver");
    let answer = f.call(&giver, "build", scarf()).unwrap();
    let scarf_id = built(&answer);
    assert_eq!(answer["kind"], "accessory");
    assert_eq!(answer["slot"], "neck");
    assert_eq!(answer["rev"], 1);
    let island = f.island();
    let made = island.assets.iter().find(|a| a.id == scarf_id).unwrap();
    assert_eq!(
        made.by,
        Maker {
            name: "Chat".into(),
            agent_id: None,
            chat_key: Some("chat:giver".into())
        }
    );
    let tap = crate::bus::tap::Tap::on(&id);
    let answer = f
        .call(
            &giver,
            "grant",
            json!({ "wishId": id, "assetId": scarf_id }),
        )
        .unwrap();
    assert_eq!(answer["worn"], "neck");
    assert_eq!(answer["to"], json!(pip.name));
    let island = f.island();
    let bot = island.bots.iter().find(|b| b.id == pip.id).unwrap();
    assert_eq!(bot.look.worn.get(&Slot::Neck), Some(&scarf_id));
    let wish = island.wishes.iter().find(|w| w.id == id).unwrap();
    assert_eq!(wish.state, WishState::Granted);
    assert_eq!(wish.closed_at, Some(NOW));
    let grant = wish.grant.as_ref().unwrap();
    assert_eq!(grant.asset.as_deref(), Some(scarf_id.as_str()));
    assert!(!grant.look);
    assert_eq!(grant.by.chat_key.as_deref(), Some("chat:giver"));
    assert_eq!(tap.heard()[0].1["what"], "grant");
    // Granted is granted.
    assert!(f
        .call(
            &giver,
            "grant",
            json!({ "wishId": id, "assetId": scarf_id })
        )
        .unwrap_err()
        .contains("granted already"));
}

#[test]
fn a_back_accessory_given_replaces_the_backpack_a_bot_designed() {
    let f = Fixture::new();
    let pip = f.bot(0);
    let own = pip.look.worn[&Slot::Back].clone();
    let id = f.wish(&Owner::bot(&pip.id), Want::Accessory, Some(Slot::Back));
    let giver = chat("chat:giver");
    let cape = built(
        &f.call(
            &giver,
            "build",
            json!({ "name": "Cape", "kind": "accessory", "slot": "back",
            "parts": [part([0.4, 0.4, 0.05], [0.0, 0.0, -0.1])] }),
        )
        .unwrap(),
    );
    f.call(&giver, "grant", json!({ "wishId": id, "assetId": cape }))
        .unwrap();
    let island = f.island();
    let bot = island.bots.iter().find(|b| b.id == pip.id).unwrap();
    assert_eq!(bot.look.worn[&Slot::Back], cape);
    assert!(
        island.assets.iter().all(|a| a.id != own),
        "its old pack is gone"
    );
    // Nobody but the 波特 made it: nobody rebuilds it, gives it or places it.
    let other = f.bot(1);
    let theirs = other.look.worn[&Slot::Back].clone();
    let mut pack = scarf();
    pack["assetId"] = json!(theirs);
    assert!(f
        .call(&giver, "build", pack)
        .unwrap_err()
        .contains("only its maker rebuilds it"));
}

#[test]
fn a_present_is_given_only_from_the_givers_own_asset_of_the_wished_kind() {
    let f = Fixture::new();
    let pip = f.bot(0);
    let id = f.wish(&Owner::bot(&pip.id), Want::Accessory, Some(Slot::Neck));
    let theirs = built(&f.call(&chat("chat:other"), "build", scarf()).unwrap());
    let why = f
        .call(
            &chat("chat:giver"),
            "grant",
            json!({ "wishId": id, "assetId": theirs }),
        )
        .unwrap_err();
    assert!(
        why.contains("a present is given only from an asset you built yourself"),
        "{why}"
    );
    let hat = built(
        &f.call(&chat("chat:giver"), "build", json!({ "name": "Hat", "kind": "accessory", "slot": "head", "parts": [part([0.5, 0.2, 0.5], [0.0, 0.1, 0.0])] }))
            .unwrap(),
    );
    let why = f
        .call(
            &chat("chat:giver"),
            "grant",
            json!({ "wishId": id, "assetId": hat }),
        )
        .unwrap_err();
    assert!(
        why.contains("The wish is for an accessory for the neck slot"),
        "{why}"
    );
    let why = f
        .call(
            &chat("chat:giver"),
            "grant",
            json!({ "wishId": id, "look": { "shell": "#ffffff" } }),
        )
        .unwrap_err();
    assert!(why.contains("not a look"), "{why}");
    let why = f
        .call(&chat("chat:giver"), "grant", json!({ "wishId": id }))
        .unwrap_err();
    assert!(why.contains("Pass the assetId"), "{why}");
    assert_eq!(
        f.island().wishes.iter().find(|w| w.id == id).unwrap().state,
        WishState::Open
    );
}

#[test]
fn furniture_and_decor_are_placed_where_there_is_room_or_where_the_agent_said() {
    let f = Fixture::new();
    let pip = f.bot(0);
    let giver = chat("chat:giver");
    let chair = built(&f.call(&giver, "build", armchair()).unwrap());
    let id = f.wish(&Owner::bot(&pip.id), Want::Furniture, None);
    let answer = f
        .call(&giver, "grant", json!({ "wishId": id, "assetId": chair }))
        .unwrap();
    let island = f.island();
    let plot = plot_of(&island, &Owner::bot(&pip.id));
    let placed: Placement = serde_json::from_value(json!({
        "id": answer["placed"]["placementId"], "plot": plot.id, "asset": chair,
        "x": answer["placed"]["x"], "z": answer["placed"]["z"], "y": 0, "turn": 0,
    }))
    .unwrap();
    // On the home's tile, clear of the beds and touches already there.
    let chair_asset = island.assets.iter().find(|a| a.id == chair).unwrap();
    let chair_box = rules::placed_box(
        &rules::asset_bounds(&chair_asset.parts),
        placed.x,
        placed.z,
        0.0,
        0.0,
    );
    for (other, shape) in furniture_boxes(&island, &plot.id) {
        if other != placed.id {
            assert!(
                !rules::overlaps(&chair_box, &shape),
                "the chair is on {other}"
            );
        }
    }
    // Decor goes to the front yard first.
    let bed_of_flowers = built(&f.call(&giver, "build", flower_bed()).unwrap());
    let id = f.wish(&Owner::bot(&pip.id), Want::Decor, None);
    let answer = f
        .call(
            &giver,
            "grant",
            json!({ "wishId": id, "assetId": bed_of_flowers }),
        )
        .unwrap();
    assert!(answer["placed"]["z"].as_f64().unwrap() > 2.0, "{answer}");
    // Where the agent said, when it is on the tile.
    let id = f.wish(&Owner::bot(&pip.id), Want::Decor, None);
    let answer = f
        .call(
            &giver,
            "grant",
            json!({ "wishId": id, "assetId": bed_of_flowers, "x": -3, "z": 2.5, "turn": 90 }),
        )
        .unwrap();
    assert_eq!(
        (
            answer["placed"]["x"].clone(),
            answer["placed"]["z"].clone(),
            answer["placed"]["turn"].clone()
        ),
        (json!(-3.0), json!(2.5), json!(90.0))
    );
    let id = f.wish(&Owner::bot(&pip.id), Want::Decor, None);
    let why = f
        .call(
            &giver,
            "grant",
            json!({ "wishId": id, "assetId": bed_of_flowers, "x": 5.5, "z": 2 }),
        )
        .unwrap_err();
    assert!(
        why.contains("would stick out of the plot's hexagonal tile"),
        "{why}"
    );
    let why = f
        .call(
            &giver,
            "grant",
            json!({ "wishId": id, "assetId": bed_of_flowers, "x": 1 }),
        )
        .unwrap_err();
    assert!(why.contains("both x and z, or neither"), "{why}");
}

#[test]
fn with_no_room_left_the_refusal_names_the_robot_and_asks_for_x_and_z() {
    let f = Fixture::new();
    let pip = f.bot(0);
    // A grove of posts under a metre apart, as far out as a building
    // reaches: what is left of the tile past it is too narrow for a chair.
    let mut posts = Vec::new();
    for i in -5..=5 {
        for j in -5..=5 {
            posts.push(part(
                [0.3, 1.0, 0.3],
                [f64::from(i) * 0.97, 0.5, f64::from(j) * 0.97],
            ));
        }
    }
    let grove = json!({ "name": "Grove", "kind": "building", "parts": posts });
    let (draft, _) = rules::check_asset(grove).unwrap();
    f.edit(|island| {
        let plot = plot_of(island, &Owner::bot(&pip.id)).id;
        let mut rng = layout::Rng::new(5);
        let asset = super::add_asset(island, draft, Maker::island(), NOW, &mut rng);
        island.placed.retain(|p| p.plot != plot);
        super::new_placement(island, &plot, &asset, (0.0, 0.0), 0.0, 0.0, &mut rng);
    });
    let giver = chat("chat:giver");
    let chair = built(&f.call(&giver, "build", armchair()).unwrap());
    let id = f.wish(&Owner::bot(&pip.id), Want::Furniture, None);
    let why = f
        .call(&giver, "grant", json!({ "wishId": id, "assetId": chair }))
        .unwrap_err();
    assert!(
        why.contains(&format!(
            "There is no room left on {}'s plot for Armchair",
            pip.name
        )),
        "{why}"
    );
    assert!(why.contains("pass x and z"), "{why}");
    // Said where, it goes there: a placement may stand anywhere on the tile.
    f.call(
        &giver,
        "grant",
        json!({ "wishId": id, "assetId": chair, "x": 0.5, "z": 0.5 }),
    )
    .unwrap();
}

#[test]
fn a_granted_building_replaces_the_homes_house_and_the_beds_and_touches_stay() {
    let f = Fixture::new();
    let pip = f.bot(0);
    let before = f.island();
    let plot = plot_of(&before, &Owner::bot(&pip.id));
    let house = placements_on(&before, &plot.id)
        .into_iter()
        .find(|p| asset_of(&before, p).kind == Kind::Building)
        .unwrap();
    let others: Vec<Placement> = placements_on(&before, &plot.id)
        .into_iter()
        .filter(|p| p.id != house.id)
        .collect();
    let giver = chat("chat:giver");
    let studio = json!({ "name": "Studio", "kind": "building", "parts": [
        part([4.0, 0.06, 3.0], [0.0, 0.03, 0.0]),
        part([4.0, 1.8, 0.15], [0.0, 0.9, -1.425]),
        part([0.15, 1.8, 2.7], [-1.925, 0.9, 0.0]),
        part([0.15, 1.8, 2.7], [1.925, 0.9, 0.0]),
    ] });
    let studio = built(&f.call(&giver, "build", studio).unwrap());
    let id = f.wish(&Owner::bot(&pip.id), Want::Building, None);
    let answer = f
        .call(&giver, "grant", json!({ "wishId": id, "assetId": studio }))
        .unwrap();
    assert_eq!(
        (
            answer["placed"]["x"].as_f64(),
            answer["placed"]["z"].as_f64()
        ),
        (Some(house.x), Some(house.z))
    );
    let after = f.island();
    let on_plot = placements_on(&after, &plot.id);
    assert!(on_plot.iter().all(|p| p.id != house.id));
    assert!(on_plot.iter().any(|p| p.asset == studio));
    for other in &others {
        assert!(on_plot.contains(other), "{} stays", other.id);
    }
    assert!(
        after.assets.iter().all(|a| a.id != house.asset),
        "the members' house is gone"
    );

    // A present is never built again when someone moves in or out; the
    // newcomer's bed finds room in it.
    let kept = after
        .assets
        .iter()
        .find(|a| a.id == studio)
        .unwrap()
        .clone();
    super::farewell_bot(&f.path, Some(&f.roster), &plot.members[1], NOW + 1).unwrap();
    let answer = super::invite_bot(&f.path, Some(&f.roster), NOW + 2).unwrap();
    assert_eq!(answer["home"], json!(plot.id));
    let after = f.island();
    assert_eq!(after.assets.iter().find(|a| a.id == studio), Some(&kept));
    let newcomer = bot_named(&after, answer["id"].as_str().unwrap());
    assert!(placements_on(&after, &plot.id).iter().any(|p| {
        let asset = asset_of(&after, p);
        asset.by == Maker::bot(&newcomer.name) && asset.r#use == Some(Use::Bed)
    }));
}

#[test]
fn a_look_wish_takes_a_fresh_coat_of_paint_and_nothing_else() {
    let f = Fixture::new();
    let pip = f.bot(0);
    let giver = chat("chat:giver");
    let id = f.wish(&Owner::bot(&pip.id), Want::Look, None);
    for (args, said) in [
        (
            json!({ "wishId": id, "assetId": "a_x" }),
            "pass look, and no assetId",
        ),
        (json!({ "wishId": id }), "pass look with the new frame"),
        (json!({ "wishId": id, "look": {} }), "changes nothing"),
        (
            json!({ "wishId": id, "look": { "worn": { "head": null } } }),
            "leave worn out",
        ),
        (
            json!({ "wishId": id, "look": { "antenna": "bolt" } }),
            "antenna \"bolt\"",
        ),
    ] {
        let why = f.call(&giver, "grant", args.clone()).unwrap_err();
        assert!(why.contains(said), "{args}: {why}");
    }
    let answer = f
        .call(&giver, "grant", json!({ "wishId": id, "look": { "shell": "#B8F2E6", "trim": "#ff7f50", "antenna": "crown" } }))
        .unwrap();
    assert_eq!(answer["look"], true);
    let island = f.island();
    let bot = island.bots.iter().find(|b| b.id == pip.id).unwrap();
    assert_eq!(
        (bot.look.shell.as_str(), bot.look.trim.as_str()),
        ("#b8f2e6", "#ff7f50")
    );
    assert_eq!(bot.look.antenna, Antenna::Crown);
    assert_eq!(
        (bot.look.frame, bot.look.eyes),
        (pip.look.frame, pip.look.eyes)
    );
    let wish = island.wishes.iter().find(|w| w.id == id).unwrap();
    let grant = wish.grant.as_ref().unwrap();
    assert!(grant.look && grant.asset.is_none());
    // An agent's look wish is laid over its own patch.
    let id = f.wish(&Owner::agent("ag_ada"), Want::Look, None);
    f.call(
        &giver,
        "grant",
        json!({ "wishId": id, "look": { "eyes": "heart" } }),
    )
    .unwrap();
    assert_eq!(f.island().looks["ag_ada"].eyes, Some(Eyes::Heart));
}

#[test]
fn only_a_registered_agent_styles_its_robot_and_arranges_its_plot() {
    let f = Fixture::new();
    let plain = chat("chat:plain");
    for (action, said) in [
        ("style", "island_style changes"),
        ("place", "island_place arranges"),
    ] {
        let why = f.call(&plain, action, json!({})).unwrap_err();
        assert!(why.contains(said), "{action}: {why}");
        assert!(why.contains("no registered agent"), "{action}: {why}");
    }
    // Its own look, and an accessory it made.
    let me = nova();
    let hat = built(
        &f.call(&me, "build", json!({ "name": "Beanie", "kind": "accessory", "slot": "head", "parts": [part([0.6, 0.25, 0.5], [0.0, 0.1, 0.0])] }))
            .unwrap(),
    );
    let answer = f
        .call(
            &me,
            "style",
            json!({ "frame": "slim", "glow": "#9FE8FF", "worn": { "head": hat } }),
        )
        .unwrap();
    assert_eq!(answer["look"]["frame"], "slim");
    assert_eq!(answer["look"]["glow"], "#9fe8ff");
    assert_eq!(answer["look"]["worn"]["head"], json!(hat));
    // Fields it leaves out stay; null takes an accessory off.
    let answer = f
        .call(
            &me,
            "style",
            json!({ "eyes": "star", "worn": { "head": null } }),
        )
        .unwrap();
    assert_eq!(answer["look"]["frame"], "slim");
    assert_eq!(answer["look"]["eyes"], "star");
    assert!(answer["look"].get("worn").is_none());
    // Not an accessory someone else made.
    let theirs = built(
        &f.call(&plain, "build", json!({ "name": "Cap", "kind": "accessory", "slot": "head", "parts": [part([0.6, 0.2, 0.5], [0.0, 0.1, 0.0])] }))
            .unwrap(),
    );
    assert!(f
        .call(&me, "style", json!({ "worn": { "head": theirs } }))
        .unwrap_err()
        .contains("not yours to wear"));
    assert!(f
        .call(&me, "style", json!({}))
        .unwrap_err()
        .contains("changes nothing"));
}

#[test]
fn a_registered_agent_places_moves_and_removes_on_its_own_plot() {
    let f = Fixture::new();
    let me = nova();
    let island = f.island();
    let plot = plot_of(&island, &Owner::agent("ag_nova"));
    let chair = built(&f.call(&me, "build", armchair()).unwrap());
    // Where it says, with a turn; then moved; then taken away.
    let answer = f
        .call(
            &me,
            "place",
            json!({ "assetId": chair, "x": -2, "z": 2.5, "turn": 45, "y": 0 }),
        )
        .unwrap();
    let placement = answer["placementId"].as_str().unwrap().to_string();
    assert_eq!(
        (answer["x"].clone(), answer["turn"].clone()),
        (json!(-2.0), json!(45.0))
    );
    let answer = f
        .call(&me, "place", json!({ "placementId": placement, "z": 3 }))
        .unwrap();
    assert_eq!(
        (answer["x"].clone(), answer["z"].clone()),
        (json!(-2.0), json!(3.0))
    );
    // Lifted onto a table, and no higher than 1.2.
    f.call(&me, "place", json!({ "placementId": placement, "y": 0.6 }))
        .unwrap();
    assert!(f
        .call(&me, "place", json!({ "placementId": placement, "y": 1.3 }))
        .unwrap_err()
        .contains("y is 0 to 1.2"));
    // Off the tile is refused, and nothing moves.
    assert!(f
        .call(
            &me,
            "place",
            json!({ "placementId": placement, "x": 6.1, "z": 0 })
        )
        .unwrap_err()
        .contains("hexagonal tile"));
    let answer = f
        .call(
            &me,
            "place",
            json!({ "placementId": placement, "remove": true }),
        )
        .unwrap();
    assert_eq!(answer["removed"], json!(placement));
    assert!(f.island().placed.iter().all(|p| p.id != placement));
    // No room given: the island finds some.
    let answer = f.call(&me, "place", json!({ "assetId": chair })).unwrap();
    assert!(answer["placementId"].is_string());

    // A starter already on its plot may be placed again; another's asset,
    // an accessory, or a placement on another plot may not.
    let desk = placements_on(&island, &plot.id)
        .into_iter()
        .find(|p| {
            island
                .assets
                .iter()
                .any(|a| a.id == p.asset && a.kind == Kind::Furniture)
        })
        .unwrap();
    f.call(
        &me,
        "place",
        json!({ "assetId": desk.asset, "x": 2.5, "z": 2.5 }),
    )
    .unwrap();
    let theirs = built(&f.call(&chat("chat:plain"), "build", armchair()).unwrap());
    assert!(f
        .call(&me, "place", json!({ "assetId": theirs, "x": 0, "z": 3 }))
        .unwrap_err()
        .contains("not yours to place"));
    let hat = built(&f.call(&me, "build", scarf()).unwrap());
    assert!(f
        .call(&me, "place", json!({ "assetId": hat, "x": 0, "z": 3 }))
        .unwrap_err()
        .contains("accessories are worn"));
    let ada_plot = plot_of(&island, &Owner::agent("ag_ada"));
    let ada_desk = placements_on(&island, &ada_plot.id)[1].clone();
    assert!(f
        .call(
            &me,
            "place",
            json!({ "placementId": ada_desk.id, "remove": true })
        )
        .unwrap_err()
        .contains("no placement"));
    // A starter taken away is gone for good, as nobody may place it again.
    let workshop = placements_on(&f.island(), &plot.id)[0].clone();
    f.call(
        &me,
        "place",
        json!({ "placementId": workshop.id, "remove": true }),
    )
    .unwrap();
    assert!(f.island().assets.iter().all(|a| a.id != workshop.asset));
}

#[test]
fn a_plot_holds_forty_placements_and_fifteen_hundred_parts() {
    let f = Fixture::new();
    let me = nova();
    let pebble = built(
        &f.call(&me, "build", json!({ "name": "Pebble", "kind": "decor", "parts": [part([0.1, 0.05, 0.1], [0.0, 0.025, 0.0])] }))
            .unwrap(),
    );
    // Two starters, then 38 pebbles.
    for at in 0..38 {
        let x = -4.0 + f64::from(at % 9);
        let z = 1.5 + f64::from(at / 9) * 0.5;
        f.call(&me, "place", json!({ "assetId": pebble, "x": x, "z": z }))
            .unwrap();
    }
    let why = f
        .call(&me, "place", json!({ "assetId": pebble, "x": 0, "z": 0 }))
        .unwrap_err();
    assert!(why.contains("at most 40 placements"), "{why}");
    // Parts: a rebuild that would bring the plot past 1,500 is refused.
    let many: Vec<Value> = (0..80)
        .map(|_| part([0.1, 0.05, 0.1], [0.0, 0.025, 0.0]))
        .collect();
    let why = f
        .call(
            &me,
            "build",
            json!({ "assetId": pebble, "name": "Pebbles", "kind": "decor", "parts": many }),
        )
        .unwrap_err();
    assert!(why.contains("parts"), "{why}");
}

#[test]
fn an_asset_is_rebuilt_only_by_its_maker_and_keeps_its_kind() {
    let f = Fixture::new();
    let me = nova();
    let chair = built(&f.call(&me, "build", armchair()).unwrap());
    let mut again = armchair();
    again["assetId"] = json!(chair);
    again["name"] = json!("Big armchair");
    let answer = f.call(&me, "build", again.clone()).unwrap();
    assert_eq!(
        (answer["assetId"].clone(), answer["rev"].clone()),
        (json!(chair), json!(2))
    );
    assert_eq!(answer["name"], "Big armchair");
    // Another maker may not; nor may a rebuild change the kind.
    assert!(f
        .call(&chat("chat:plain"), "build", again)
        .unwrap_err()
        .contains("only its maker rebuilds it"));
    let mut lamp = flower_bed();
    lamp["assetId"] = json!(chair);
    assert!(f
        .call(&me, "build", lamp)
        .unwrap_err()
        .contains("keeps the asset's kind"));
    // The island's starter on its own plot is the agent's to rebuild, and
    // then its own; one on another plot is not.
    let island = f.island();
    let mine = placements_on(&island, &plot_of(&island, &Owner::agent("ag_nova")).id)[1]
        .asset
        .clone();
    let ada = placements_on(&island, &plot_of(&island, &Owner::agent("ag_ada")).id)[1]
        .asset
        .clone();
    let mut desk = starter::desk("#123456");
    desk["assetId"] = json!(mine);
    f.call(&me, "build", desk.clone()).unwrap();
    assert_eq!(
        f.island()
            .assets
            .iter()
            .find(|a| a.id == mine)
            .unwrap()
            .by
            .agent_id
            .as_deref(),
        Some("ag_nova")
    );
    desk["assetId"] = json!(ada);
    assert!(f
        .call(&me, "build", desk)
        .unwrap_err()
        .contains("only its maker rebuilds it"));
}

#[test]
fn a_maker_keeps_three_hundred_assets_and_the_island_two_thousand() {
    let f = Fixture::new();
    let plain = chat("chat:prolific");
    let (draft, _) = rules::check_asset(flower_bed()).unwrap();
    f.edit(|island| {
        let mut rng = layout::Rng::new(3);
        for _ in 0..super::MAKER_ASSETS_MAX {
            super::add_asset(island, draft.clone(), plain.maker(), NOW, &mut rng);
        }
    });
    let why = f.call(&plain, "build", flower_bed()).unwrap_err();
    assert!(
        why.contains("300 assets, the most one maker keeps"),
        "{why}"
    );
    f.call(&chat("chat:other"), "build", flower_bed()).unwrap();
    f.edit(|island| {
        let mut rng = layout::Rng::new(4);
        while island.assets.len() < super::ASSETS_MAX {
            super::add_asset(island, draft.clone(), Maker::island(), NOW, &mut rng);
        }
    });
    let why = f
        .call(&chat("chat:other"), "build", flower_bed())
        .unwrap_err();
    assert!(why.contains("2000 assets"), "{why}");
}

#[test]
fn a_worker_and_a_room_seat_may_only_look_and_an_unlisted_chat_builds_nothing() {
    let f = Fixture::new();
    for caller in [
        Caller {
            worker: true,
            ..chat("chat:orch-w")
        },
        Caller {
            seat: true,
            ..nova()
        },
    ] {
        f.call(&caller, "look", json!({})).unwrap();
        for action in ["build", "grant", "style", "place"] {
            let why = f.call(&caller, action, scarf()).unwrap_err();
            assert!(
                why.contains("worker can look at the island")
                    || why.contains("Only the chat's own agent"),
                "{action}: {why}"
            );
        }
    }
    let why = super::agent_call(
        &f.path,
        &f.roster,
        &chat("chat:gone"),
        "build",
        scarf(),
        NOW,
        &|| Ok(false),
    )
    .unwrap_err();
    assert!(why.contains("not in the active chat index"), "{why}");
    let why = f.call(&nova(), "demolish", json!({})).unwrap_err();
    assert!(why.contains("Unknown island action"), "{why}");
}

#[test]
fn a_hook_answer_and_the_page_answer_keep_to_their_shapes() {
    let f = Fixture::new();
    let answer = super::get(&f.path, Some(&f.roster), NOW).unwrap();
    let island = &answer["island"];
    for key in [
        "version",
        "rev",
        "seed",
        "createdAt",
        "updatedAt",
        "radius",
        "settings",
        "plots",
        "bots",
        "looks",
        "assets",
        "placed",
        "wishes",
        "lastRollAt",
    ] {
        assert!(island.get(key).is_some(), "{key}");
    }
    let plot = &island["plots"][0];
    for key in [
        "id",
        "owner",
        "ring",
        "slot",
        "q",
        "r",
        "x",
        "z",
        "facing",
        "radius",
        "claimedAt",
    ] {
        assert!(plot.get(key).is_some(), "plot {key}");
    }
    assert!(plot.get("size").is_none());
    assert!(island["bots"].as_array().unwrap().is_empty());
    let asset = &island["assets"][0];
    for key in [
        "id",
        "rev",
        "name",
        "kind",
        "parts",
        "by",
        "madeAt",
        "updatedAt",
    ] {
        assert!(asset.get(key).is_some(), "asset {key}");
    }
    assert_eq!(asset["by"], json!({ "name": "Island" }));
    let placement = &island["placed"][0];
    for key in ["id", "plot", "asset", "x", "z", "y", "turn"] {
        assert!(placement.get(key).is_some(), "placement {key}");
    }
    let path: &Path = &f.path;
    assert!(path.exists());
}

#[test]
fn new_islands_contain_only_registered_agents_and_old_npcs_stay_hidden_without_deleting_data() {
    let dir = TestDir::new("registered-island");
    let path = dir.join("island.json");
    let agents = roster();
    let shown = super::get(&path, Some(&agents), NOW).unwrap();
    assert!(shown["island"]["bots"].as_array().unwrap().is_empty());
    assert_eq!(
        shown["island"]["plots"].as_array().unwrap().len(),
        agents.len()
    );
    assert!(super::read(&path).unwrap().unwrap().bots.is_empty());
    let legacy = Fixture::new();
    let before = std::fs::read(&legacy.path).unwrap();
    let shown = super::get(&legacy.path, Some(&legacy.roster), NOW).unwrap();
    assert!(shown["island"]["bots"].as_array().unwrap().is_empty());
    assert!(shown["island"]["plots"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p["owner"]["kind"] == "agent"));
    assert_eq!(std::fs::read(&legacy.path).unwrap(), before);
}

#[test]
fn autonomous_improvements_stay_on_a_registered_agents_plot_and_leave_gifts_and_other_assets_alone()
{
    let f = Fixture::new();
    let before = f.island();
    assert_eq!(
        super::autonomy::develop(&f.path, &f.roster, NOW + 1000, &[]).unwrap(),
        None
    );
    let later = NOW + 9 * 3_600_000;
    let changed = super::autonomy::develop(&f.path, &f.roster, later, &["ag_ada".into()]).unwrap();
    assert!(changed.is_some());
    let built = f.island();
    assert_eq!(built.developments.len(), 1);
    assert!(built.developments.contains_key("ag_nova"));
    for old in &before.assets {
        assert_eq!(built.assets.iter().find(|a| a.id == old.id), Some(old));
    }
    assert_eq!(built.bots, before.bots);
    assert_eq!(
        super::autonomy::develop(&f.path, &f.roster, later + 1000, &[]).unwrap(),
        None
    );
    let ours = built.developments["ag_nova"].clone();
    super::autonomy::develop(
        &f.path,
        &f.roster,
        later + 9 * 3_600_000,
        &["ag_ada".into()],
    )
    .unwrap();
    let after = f.island();
    assert_eq!(after.developments["ag_nova"], ours);
    assert_eq!(after.assets.len(), built.assets.len());
    assert_eq!(after.assets.iter().find(|a| a.id == ours).unwrap().rev, 2);
    super::set_build_pace(&f.path, Some(&f.roster), "never", later).unwrap();
    assert_eq!(
        super::autonomy::develop(&f.path, &f.roster, later + 99 * 3_600_000, &[]).unwrap(),
        None
    );
}
