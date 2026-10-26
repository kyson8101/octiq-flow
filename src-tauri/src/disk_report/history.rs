//! The inventory's only writes: these two files, outside the scanned tree.
use super::*;
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
};
fn safe_file(home: &Path, name: &str, writing: bool) -> Result<PathBuf, String> {
    let dir = home.join("disk-report");
    match fs::symlink_metadata(&dir) {
        Ok(m) if scan::redirect(&m) || !m.is_dir() => {
            return Err("disk-report must be a real directory".into())
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if writing {
                crate::profile::make_dir(&dir).map_err(|e| e.to_string())?;
            }
        }
        Err(e) => return Err(e.to_string()),
    }
    let path = dir.join(name);
    match fs::symlink_metadata(&path) {
        Ok(m) if scan::redirect(&m) || !m.is_file() => {
            return Err(format!("{} must be a regular file", display(&path)))
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    #[cfg(unix)]
    if let Ok(meta) = fs::symlink_metadata(&path) {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 {
            return Err("Disk report destinations cannot be hard links".into());
        }
    }
    Ok(path)
}
fn read(home: &Path, name: &str) -> Result<Option<String>, String> {
    let path = safe_file(home, name, false)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut f = match options.open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if f.metadata().map_err(|e| e.to_string())?.len() > 128 * 1024 * 1024 {
        return Err(format!("Disk history {name} exceeds 128 MB"));
    }
    let mut text = String::new();
    f.read_to_string(&mut text).map_err(|e| e.to_string())?;
    Ok(Some(text))
}
pub(super) fn load(home: &Path) -> Result<Option<Report>, String> {
    read(home, "latest.json")?
        .map(|s| serde_json::from_str(&s).map_err(|e| format!("Invalid disk report: {e}")))
        .transpose()
}
#[derive(Default)]
pub(super) struct History {
    pub at: Option<u64>,
    pub rows: HashMap<String, (u64, u64)>,
}
pub(super) fn previous(home: &Path, before: u64) -> Result<History, String> {
    let Some(text) = read(home, "sizes.csv")? else {
        return Ok(History::default());
    };
    let rows = parse_csv(&text)?;
    if rows.first()
        != Some(&vec![
            "scanned_at".to_string(),
            "key".into(),
            "path".into(),
            "bytes".into(),
        ])
    {
        return Err("Invalid disk sizes.csv header".into());
    }
    let mut history = History::default();
    if let Some(report) = load(home)? {
        if report.scanned_at < before {
            history.at = Some(report.scanned_at);
        }
    }
    for row in rows.into_iter().skip(1) {
        if row.len() != 4 {
            return Err("Invalid disk sizes.csv row".into());
        }
        let at = row[0]
            .parse::<u64>()
            .map_err(|_| "Invalid disk history timestamp")?;
        let bytes = row[3]
            .parse::<u64>()
            .map_err(|_| "Invalid disk history size")?;
        if at >= before {
            continue;
        }
        history.at = Some(history.at.unwrap_or(0).max(at));
        let entry = history.rows.entry(row[1].clone()).or_insert((at, bytes));
        if at >= entry.0 {
            *entry = (at, bytes);
        }
    }
    Ok(history)
}
pub(super) fn compare(report: &mut Report, history: &History) {
    report.previous_scan_at = history.at;
    for item in &mut report.items {
        item.previous_bytes = history.rows.get(&item.key).map(|(_, bytes)| *bytes);
        item.grew = item.previous_bytes.is_some_and(|previous| {
            item.bytes.saturating_sub(previous)
                >= ((previous.saturating_add(19)) / 20).max(10 * 1024 * 1024)
        });
    }
}
fn csv(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
pub(super) fn save(home: &Path, report: &mut Report) -> Result<(), String> {
    // Validate both destinations before touching either one. No temp file, rename or deletion.
    let csv_path = safe_file(home, "sizes.csv", true)?;
    let json_path = safe_file(home, "latest.json", true)?;
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW).mode(0o600);
    }
    let mut f = options.open(csv_path).map_err(|e| e.to_string())?;
    let mut rows = String::new();
    if f.metadata().map_err(|e| e.to_string())?.len() == 0 {
        rows.push_str("scanned_at,key,path,bytes\n");
    }
    for item in &report.items {
        rows.push_str(&format!(
            "{},{},{},{}\n",
            report.scanned_at,
            csv(&item.key),
            csv(&item.path),
            item.bytes
        ));
    }
    f.write_all(rows.as_bytes())
        .and_then(|_| f.sync_all())
        .map_err(|e| e.to_string())?;
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW).mode(0o600);
    }
    let bytes = serde_json::to_vec(report).map_err(|e| e.to_string())?;
    let mut f = options.open(json_path).map_err(|e| e.to_string())?;
    f.write_all(&bytes)
        .and_then(|_| f.sync_all())
        .map_err(|e| e.to_string())
}
fn parse_csv(text: &str) -> Result<Vec<Vec<String>>, String> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                chars.next();
                field.push('"');
            }
            '"' => quoted = !quoted,
            ',' if !quoted => row.push(std::mem::take(&mut field)),
            '\n' if !quoted => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            '\r' if !quoted => {}
            _ => field.push(c),
        }
    }
    if quoted {
        return Err("Unterminated CSV field".into());
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    Ok(rows)
}
