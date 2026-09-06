//! The OctiqOS control plane owns small, ordered PostgreSQL migrations.
//!
//! Requiring an operator to remember a `psql -f` sequence makes a release
//! fragile: the server can start successfully while its new commands fail on a
//! half-upgraded schema. Migrations therefore run before the socket opens when
//! `DATABASE_URL` is configured. They are additive, recorded durably, and never
//! run seed data or environment-specific configuration.

use std::collections::HashSet;
use std::env;

use postgres::{Client, NoTls};
use serde::Serialize;

struct Migration {
    version: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: "0001_octiqos_control_plane",
        sql: include_str!("../../db/migrations/0001_octiqos_control_plane.sql"),
    },
    Migration {
        version: "0002_octiqos_pm_loop",
        sql: include_str!("../../db/migrations/0002_octiqos_pm_loop.sql"),
    },
    Migration {
        version: "0003_octiqos_kanban_lifecycle",
        sql: include_str!("../../db/migrations/0003_octiqos_kanban_lifecycle.sql"),
    },
    Migration {
        version: "0004_octiqos_workflow_profile_policy",
        sql: include_str!("../../db/migrations/0004_octiqos_workflow_profile_policy.sql"),
    },
    Migration {
        version: "0005_octiqos_connector_intake",
        sql: include_str!("../../db/migrations/0005_octiqos_connector_intake.sql"),
    },
    Migration {
        version: "0006_octiqos_default_workflow_profiles",
        sql: include_str!("../../db/migrations/0006_octiqos_default_workflow_profiles.sql"),
    },
    Migration {
        version: "0007_octiqos_profile_workspaces",
        sql: include_str!("../../db/migrations/0007_octiqos_profile_workspaces.sql"),
    },
    Migration {
        version: "0008_octiqos_founder_direction",
        sql: include_str!("../../db/migrations/0008_octiqos_founder_direction.sql"),
    },
    Migration {
        version: "0009_octiqos_world",
        sql: include_str!("../../db/migrations/0009_octiqos_world.sql"),
    },
];

#[derive(Debug)]
pub enum StartupMigration {
    Skipped,
    Applied { count: usize },
}

#[derive(Serialize)]
pub struct StoreReadiness {
    pub status: &'static str,
    pub migrations: usize,
}

pub fn database_required() -> bool {
    env::var("OCTIQOS_REQUIRE_DATABASE")
        .ok()
        .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"))
}

fn database_url() -> Result<Option<String>, String> {
    match env::var("DATABASE_URL") {
        Ok(url) if !url.trim().is_empty() => Ok(Some(url)),
        Ok(_) | Err(env::VarError::NotPresent) => Ok(None),
        Err(_) => Err("OctiqOS could not read DATABASE_URL.".into()),
    }
}

fn connect(url: &str) -> Result<Client, String> {
    Client::connect(url, NoTls).map_err(|_| {
        "OctiqOS could not reach PostgreSQL. Check DATABASE_URL and the database service.".into()
    })
}

fn database_error_summary(error: &postgres::Error) -> String {
    error
        .as_db_error()
        .map(|database| format!("{} ({:?})", database.message(), database.code()))
        .unwrap_or_else(|| "database communication failed".into())
}

fn ensure_migration_ledger(client: &mut Client) -> Result<(), String> {
    client
        .batch_execute(
            "DO $$ BEGIN \
               IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'octiqos') THEN \
                 EXECUTE 'CREATE SCHEMA octiqos'; \
               END IF; \
             END $$; \
             CREATE TABLE IF NOT EXISTS octiqos.schema_migrations ( \
               version TEXT PRIMARY KEY, \
               applied_at TIMESTAMPTZ NOT NULL DEFAULT now() \
             )",
        )
        // PostgreSQL errors name the failed object/permission but never echo a
        // connection string. Keep that useful operator detail while avoiding
        // the credential-bearing DATABASE_URL entirely.
        .map_err(|error| {
            format!(
                "OctiqOS could not create its migration ledger: {}",
                database_error_summary(&error)
            )
        })
}

/// Apply each embedded schema migration exactly once. An error is intentionally
/// fatal to an OctiqOS-required service: serving a new binary on an old schema
/// would make the dashboard appear available while later work fails.
pub fn migrate_from_env() -> Result<StartupMigration, String> {
    let Some(url) = database_url()? else {
        return Ok(StartupMigration::Skipped);
    };
    let mut client = connect(&url)?;
    ensure_migration_ledger(&mut client)?;
    let mut transaction = client
        .transaction()
        .map_err(|_| "OctiqOS could not begin database migration.".to_string())?;
    let applied: HashSet<String> = transaction
        .query("SELECT version FROM octiqos.schema_migrations", &[])
        .map_err(|_| "OctiqOS could not read its migration ledger.".to_string())?
        .iter()
        .map(|row| row.get("version"))
        .collect();
    let mut count = 0;
    for migration in MIGRATIONS {
        if applied.contains(migration.version) {
            continue;
        }
        transaction
            .batch_execute(migration.sql)
            .map_err(|_| format!("OctiqOS could not apply migration {}.", migration.version))?;
        transaction
            .execute(
                "INSERT INTO octiqos.schema_migrations (version) VALUES ($1)",
                &[&migration.version],
            )
            .map_err(|_| format!("OctiqOS could not record migration {}.", migration.version))?;
        count += 1;
    }
    transaction
        .commit()
        .map_err(|_| "OctiqOS could not finish database migration.".to_string())?;
    Ok(StartupMigration::Applied { count })
}

/// Used by the unauthenticated readiness probe. It gives no connection string,
/// database error, or business data back to the caller.
pub fn readiness() -> Result<StoreReadiness, String> {
    let Some(url) = database_url()? else {
        return Err("OctiqOS database is not configured.".into());
    };
    let mut client = connect(&url)?;
    let completed: i64 = client
        .query_one("SELECT COUNT(*) FROM octiqos.schema_migrations", &[])
        .map_err(|_| "OctiqOS migration ledger is unavailable.".to_string())?
        .get(0);
    if completed as usize != MIGRATIONS.len() {
        return Err("OctiqOS schema is not current.".into());
    }
    Ok(StoreReadiness {
        status: "ready",
        migrations: MIGRATIONS.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_ordered_and_nonempty() {
        let mut previous = "";
        for migration in MIGRATIONS {
            assert!(migration.version > previous);
            assert!(!migration.sql.trim().is_empty());
            previous = migration.version;
        }
    }
}
