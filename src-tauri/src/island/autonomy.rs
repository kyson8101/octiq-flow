//! Quiet procedural improvements to each registered robot's own plot. No
//! conversation, provider usage, extra resident or project filesystem write.
use super::*;

pub(super) fn develop(
    path: &Path,
    roster: &[TeamAgent],
    now: i64,
    busy: &[String],
) -> Result<Option<String>, String> {
    let _guard = locked();
    let Some(mut island) = read(path)? else {
        return Ok(None);
    };
    let Some(hours) = island.settings.build_pace.hours() else {
        return Ok(None);
    };
    let interval = (hours * 3_600_000.0) as i64;
    if now - island.last_build_at.max(island.created_at) < interval {
        return Ok(None);
    }
    let mut rng = Rng::for_change(island.seed, island.rev, now, 0x6275696c64);
    let mut agents: Vec<_> = roster
        .iter()
        .filter(|agent| {
            !busy.contains(&agent.id) && plot_of(&island, &Owner::agent(&agent.id)).is_some()
        })
        .collect();
    rng.shuffle(&mut agents);
    for agent in agents {
        let plot = plot_of(&island, &Owner::agent(&agent.id))
            .unwrap()
            .id
            .clone();
        let maker = Maker {
            name: agent.name.clone(),
            agent_id: Some(agent.id.clone()),
            chat_key: None,
        };
        let colors = ["#9ed5b2", "#a7c7ef", "#f2c898", "#cfb3e8", "#e6a6b5"];
        let color = *rng.pick(&colors);
        // A little roofless pavilion, with an open entrance. It occupies only
        // spare space and never replaces a person's gift or the main workshop.
        let raw = json!({"name": format!("{}'s garden pavilion", agent.name), "kind": "building", "parts": [
            {"shape":"box","size":[1.8,0.08,1.5],"at":[0,0.04,0],"color":"#d4c2a5"},
            {"shape":"box","size":[0.12,1.15,0.12],"at":[-0.8,0.62,-0.65],"color":color},
            {"shape":"box","size":[0.12,1.15,0.12],"at":[0.8,0.62,-0.65],"color":color},
            {"shape":"box","size":[1.7,0.45,0.12],"at":[0,0.3,-0.65],"color":color},
            {"shape":"box","size":[0.15,0.5,0.9],"at":[-0.8,0.3,0],"color":color}
        ]});
        let (draft, _) = rules::check_asset(raw)?;
        let bounds = rules::asset_bounds(&draft.parts);
        if let Some(id) = island.developments.get(&agent.id).cloned() {
            if let Some(asset) = island
                .assets
                .iter_mut()
                .find(|asset| asset.id == id && asset.by == maker)
            {
                asset.parts = draft.parts;
                asset.rev += 1;
                asset.updated_at = now;
                island.last_build_at = now;
                save(path, &mut island, now, "home", Some(&plot))?;
                return Ok(Some(plot));
            }
        }
        if island.assets.len() >= ASSETS_MAX {
            return Ok(None);
        }
        if island.placed.iter().filter(|p| p.plot == plot).count() >= PLOT_PLACEMENTS_MAX {
            continue;
        }
        let Some((x, z)) = room::find_room(&island, &plot, &bounds, 0., (0., 3.5), &[]) else {
            continue;
        };
        let parts: usize = island
            .placed
            .iter()
            .filter(|p| p.plot == plot)
            .filter_map(|p| island.assets.iter().find(|a| a.id == p.asset))
            .map(|a| a.parts.len())
            .sum();
        if parts + draft.parts.len() > PLOT_PARTS_MAX {
            continue;
        }
        let id = add_asset(&mut island, draft, maker, now, &mut rng);
        new_placement(&mut island, &plot, &id, (x, z), 0., 0., &mut rng);
        island.developments.insert(agent.id.clone(), id);
        island.last_build_at = now;
        save(path, &mut island, now, "home", Some(&plot))?;
        return Ok(Some(plot));
    }
    Ok(None)
}
