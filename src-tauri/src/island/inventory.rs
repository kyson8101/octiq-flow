//! Personal possessions are bounded; replacement unplaces an old gift, never
//! deletes an asset another resident might still use or a shared public plot.
use super::*;
pub const PERSONAL_MAX: usize = 8;
fn category(asset: &Asset) -> String {
    match asset.r#use {
        Some(Use::Desk) => return "table".into(),
        Some(Use::Seat) => return "chair".into(),
        Some(Use::Bed) => return "bed".into(),
        _ => {}
    }
    let name = asset.name.to_lowercase();
    for (category, words) in [
        (
            "table",
            &["table", "desk", "workbench", "桌", "工作台"] as &[&str],
        ),
        ("chair", &["chair", "bench", "stool", "椅", "凳"]),
        ("planter", &["planter", "花盆", "herb", "seedling", "盆栽"]),
        ("shelf", &["shelf", "bookcase", "书架", "書架"]),
        ("lamp", &["lamp", "light", "灯", "燈"]),
        ("easel", &["easel", "画架", "畫架"]),
    ] {
        if words.iter().any(|word| {
            if word.is_ascii() {
                name.split(|c: char| !c.is_alphanumeric())
                    .any(|token| token == *word)
            } else {
                name.contains(word)
            }
        }) {
            return category.into();
        }
    }
    match asset.r#use {
        Some(Use::Desk) => "table".into(),
        Some(Use::Seat) => "chair".into(),
        Some(Use::Bed) => "bed".into(),
        _ => format!("{}:{name}", asset.kind.word()),
    }
}
fn personal(island: &Island, placement: &Placement, plot: &str) -> bool {
    placement.plot == plot
        && island.assets.iter().any(|asset| {
            asset.id == placement.asset
                && asset.kind != Kind::Building
                && !(asset.by == Maker::island()
                    && matches!(asset.name.as_str(), "Desk" | "Workshop"))
        })
}
pub(super) fn replace(island: &mut Island, who: &Owner, incoming: &Asset) -> Vec<String> {
    let Some(plot) = super::plot_of(island, who).map(|p| p.id.clone()) else {
        return vec![];
    };
    let class = category(incoming);
    let remove: BTreeSet<String> = island
        .placed
        .iter()
        .filter(|p| personal(island, p, &plot))
        .filter(|p| {
            island
                .assets
                .iter()
                .any(|a| a.id == p.asset && category(a) == class)
        })
        .map(|p| p.id.clone())
        .collect();
    island.placed.retain(|p| !remove.contains(&p.id));
    remove.into_iter().collect()
}
pub(super) fn limit(island: &mut Island, who: &Owner, keep: Option<&str>) -> Vec<String> {
    let Some(plot) = super::plot_of(island, who).map(|p| p.id.clone()) else {
        return vec![];
    };
    // Legacy NPC homes are shared; registered agents alone own personal stores.
    if who.kind != OwnerKind::Agent {
        return vec![];
    }
    let worn = island
        .looks
        .get(&who.id)
        .map(|look| look.worn.len())
        .unwrap_or(0);
    let mut possessions: Vec<(i64, String, String)> = island
        .placed
        .iter()
        .filter(|p| personal(island, p, &plot))
        .filter_map(|p| {
            island
                .assets
                .iter()
                .find(|a| a.id == p.asset)
                .map(|a| (a.made_at, p.id.clone(), a.id.clone()))
        })
        .collect();
    possessions.sort();
    let over = (possessions.len() + worn).saturating_sub(PERSONAL_MAX);
    let protected = island
        .placed
        .iter()
        .rev()
        .find(|p| Some(p.asset.as_str()) == keep && personal(island, p, &plot))
        .map(|p| p.id.clone());
    let remove: BTreeSet<String> = possessions
        .into_iter()
        .filter(|(_, id, _)| Some(id) != protected.as_ref())
        .take(over)
        .map(|(_, id, _)| id)
        .collect();
    island.placed.retain(|p| !remove.contains(&p.id));
    remove.into_iter().collect()
}
pub(super) fn normalize(island: &mut Island, roster: &[TeamAgent]) -> bool {
    let mut changed = false;
    for agent in roster {
        changed |= !limit(island, &Owner::agent(&agent.id), None).is_empty();
    }
    changed
}
