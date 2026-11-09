//! Browser-owned worker scheduling policy. An unavailable profile is never a
//! default policy: starts must wait until the policy can be read again.
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, sync::Mutex};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    #[default]
    Tasks,
    Agents,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub orientation: Orientation,
    pub host_cap: Option<u16>,
}

static LOCK: Mutex<()> = Mutex::new(());

fn read(path: &Path) -> Result<Settings, String> {
    let settings =
        match crate::profile::read(path, |e| format!("Scheduling could not be read: {e}"))? {
            Some(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string())?,
            None => Settings::default(),
        };
    validate(&settings)?;
    Ok(settings)
}

fn validate(settings: &Settings) -> Result<(), String> {
    if settings.host_cap.is_some_and(|n| !(1..=32).contains(&n)) {
        return Err("hostCap must be null or a number from 1 to 32.".into());
    }
    Ok(())
}

pub fn load() -> Result<Settings, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    read(&crate::profile::profile_dir().join("scheduling.json"))
}

pub fn save(settings: Settings) -> Result<(), String> {
    validate(&settings)?;
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let dir = crate::profile::profile_dir();
    let path = dir.join("scheduling.json");
    // Preserve the profile's own words before touching any file.
    read(&path)?;
    crate::profile::make_dir(&dir)?;
    let tmp = dir.join(format!(".scheduling-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        fs::write(
            &tmp,
            serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(&tmp, &path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TestDir;

    #[test]
    fn defaults_validation_and_away_profile() {
        let dir = TestDir::new("scheduling");
        let _profile = crate::profile::started_in(&dir);
        assert_eq!(load().unwrap(), Settings::default());
        for cap in [Some(0), Some(33)] {
            assert!(save(Settings {
                orientation: Orientation::Tasks,
                host_cap: cap
            })
            .is_err());
        }
        let saved = Settings {
            orientation: Orientation::Agents,
            host_cap: Some(3),
        };
        save(saved.clone()).unwrap();
        assert_eq!(load().unwrap(), saved);
        let pinned = crate::profile::profile_dir();
        let moved = pinned.with_extension("away");
        fs::rename(&pinned, &moved).unwrap();
        assert!(load().unwrap_err().contains("not available"));
        assert!(save(Settings::default())
            .unwrap_err()
            .contains("not available"));
        assert!(!pinned.exists());
        fs::rename(moved, &pinned).unwrap();
    }
}
