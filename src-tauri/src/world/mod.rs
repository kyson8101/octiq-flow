//! Org-based OctiqOS. The legacy mission portal remains available separately.
mod agent_settings;
mod avatar;
mod cli;
mod command;
mod model;
mod process;
mod provider;
mod recruitment;
mod role_chat;
mod runtime;
mod secretary;
#[cfg(test)]
mod tests;
mod workspace_access;
#[cfg(test)]
mod workspace_access_tests;

use model::*;
use postgres::{Client, NoTls};
use serde_json::{json, Value};

pub fn start() {
    if std::env::var("DATABASE_URL").is_ok() {
        runtime::start();
    }
}

fn connect() -> Result<Client> {
    let url = std::env::var("DATABASE_URL")
        .map_err(|_| "Configure DATABASE_URL for OctiqOS.".to_string())?;
    Client::connect(&url, NoTls).map_err(|_| "OctiqOS could not connect to its database.".into())
}

pub(super) fn update<T>(f: impl FnOnce(&mut World) -> Result<T>) -> Result<T> {
    let mut client = connect()?;
    let mut tx = client
        .transaction()
        .map_err(|_| "Could not begin world update.")?;
    let row = tx
        .query_one(
            "SELECT payload::text FROM octiqos.world_state WHERE singleton = TRUE FOR UPDATE",
            &[],
        )
        .map_err(|_| "OctiqOS world migration is not available.")?;
    let previous: String = row.get(0);
    let mut world: World =
        serde_json::from_str(&previous).map_err(|_| "Could not decode the saved world.")?;
    let before = serde_json::to_string(&world).map_err(|_| "Could not encode world.")?;
    let org_ids: Vec<_> = world.orgs.iter().map(|org| org.id.clone()).collect();
    for org_id in org_ids {
        secretary::ensure_org(&mut world, &org_id)?;
    }
    let result = f(&mut world)?;
    if serde_json::to_string(&world).map_err(|_| "Could not encode world.")? != before {
        world.revision += 1;
        let payload = serde_json::to_string(&world).map_err(|_| "Could not encode world.")?;
        tx.execute("UPDATE octiqos.world_state SET payload=$1::text::jsonb, updated_at=now() WHERE singleton = TRUE",&[&payload]).map_err(|_|"Could not save world.")?;
    }
    tx.commit().map_err(|_| "Could not finish world update.")?;
    Ok(result)
}
pub(super) fn read() -> Result<World> {
    let mut client = connect()?;
    let row = client
        .query_one(
            "SELECT payload::text FROM octiqos.world_state WHERE singleton = TRUE",
            &[],
        )
        .map_err(|_| "OctiqOS world migration is not available.")?;
    serde_json::from_str(&row.get::<_, String>(0))
        .map_err(|_| "Could not decode saved world.".into())
}

fn agent_stats(world: &World, agent: &Agent) -> Value {
    let usage: Vec<_> = world
        .usage
        .iter()
        .filter(|u| u.agent_id == agent.id)
        .collect();
    let points = world
        .xp
        .iter()
        .filter(|x| x.agent_id == agent.id)
        .map(|x| x.points)
        .sum();
    let (level, progress, next) = level(points);
    json!({"agentId":agent.id,"active":world.runs.iter().filter(|r|r.agent_id==agent.id && r.status=="running" && matches!(r.kind.as_str(), "task" | "plan")).count(),
            "recruiting":world.runs.iter().filter(|r|r.agent_id==agent.id && r.status=="running" && r.kind=="recruitment").count(),
            "roleSetup":world.runs.iter().filter(|r|r.agent_id==agent.id && r.status=="running" && r.kind=="role_setup").count(),
            "secretaryConfig":world.runs.iter().filter(|r|r.agent_id==agent.id && r.status=="running" && r.kind=="secretary").count(),
            "discussing":world.runs.iter().filter(|r|r.agent_id==agent.id && r.status=="running" && r.kind=="meeting").count(),
            "stopping":world.runs.iter().filter(|r|r.agent_id==agent.id && r.status=="interrupted" && r.in_flight()).count(),
            "queued":world.tasks.iter().filter(|t|t.agent_id.as_deref()==Some(&agent.id) && t.status=="queued" && t.route=="direct").count(),
            "inputTokens":usage.iter().filter_map(|u|u.input).sum::<u64>(),"outputTokens":usage.iter().filter_map(|u|u.output).sum::<u64>(),
            "unavailableUsage":usage.iter().filter(|u|u.input.is_none() || u.output.is_none()).count(),
            "usageSamples":usage.len(),"xp":points,"level":level,"progress":progress,"next":next})
}

fn snapshot() -> Result<Value> {
    // Persistently upgrade worlds created before every org owned a Secretary.
    update(|_| Ok(()))?;
    let world = read()?;
    let stats: Vec<_> = world
        .agents
        .iter()
        .map(|agent| agent_stats(&world, agent))
        .collect();
    // Receipts are mutation bookkeeping, not product data.
    let mut payload = serde_json::to_value(&world).map_err(|_| "Could not encode world.")?;
    payload.as_object_mut().unwrap().remove("receipts");
    // Images are fetched once by version, never retransmitted in every poll.
    if let Some(agents) = payload["agents"].as_array_mut() {
        use std::hash::{Hash, Hasher};
        for agent in agents {
            if let Some(image) = agent["avatar"].as_str() {
                let mut hash = std::collections::hash_map::DefaultHasher::new();
                image.hash(&mut hash);
                agent["avatar"] = json!(format!("avatar:{:x}", hash.finish()));
            }
        }
    }

    Ok(json!({"world":payload,"stats":stats,"providers":provider::availability()}))
}

pub fn dispatch(action: &str, args: Value) -> Result<Value> {
    runtime::start();
    if action == "snapshot" {
        return snapshot();
    }
    if action == "avatar" {
        let world = read()?;
        let agent = world.agent(args["agentId"].as_str().ok_or("Agent is required.")?)?;
        return Ok(json!({"image":agent.avatar}));
    }
    if action == "context" {
        return read()?.context(
            args["agentId"].as_str().ok_or("Agent is required.")?,
            args["projectId"].as_str().ok_or("Project is required.")?,
        );
    }
    if action == "generate_avatar" {
        return avatar::dispatch(args);
    }
    let request = args["requestId"]
        .as_str()
        .ok_or("A request ID is required.")?
        .to_owned();
    uuid::Uuid::parse_str(&request).map_err(|_| "Invalid request ID.")?;
    let result = update(|world| {
        if let Some(receipt) = world.receipts.iter().find(|r| r.id == request) {
            return Ok(receipt.result.clone());
        }
        let result = world.apply(action, &args)?;
        world.receipts.push(Receipt {
            id: request,
            result: result.clone(),
        });
        // Requests are kept for the lifetime of this small local world. Evicting
        // them would let an offline retry duplicate an already accepted task.
        Ok(result)
    })?;
    Ok(json!({"result":result,"snapshot":snapshot()?}))
}
