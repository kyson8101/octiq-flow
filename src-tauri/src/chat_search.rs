//! Full-text search over active OctiqFlow conversations.
//!
//! The small chat index knows titles and the latest response; the actual words
//! live in one append-only JSONL transcript per chat. Search keeps a compact,
//! incremental cache beside those transcripts. Each chat has its own on-disk
//! segment, read and dropped in turn. No corpus, token index or lowercase copy
//! stays resident between queries. A changed transcript rebuilds only its segment.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::chat_index::ChatMeta;
use crate::workspaces::WorkspaceState;

const SEGMENT_VERSION: u32 = 1;
const SEGMENT_FOLDER: &str = "search-chats-v1";
const SEARCH_CHUNK_CHARS: usize = 1_200;
const SEARCH_CHUNK_OVERLAP: usize = 120;
const EXCERPT_CHARS: usize = 220;

/// A disposable derivative of one transcript. The legacy search-index.json is
/// deliberately left alone: older servers and the MCP search still read it.
/// Missing/corrupt/new-version segments rebuild from the canonical transcript;
/// an interrupted rebuild cannot replace either that transcript or the legacy
/// cache. A failed cache write only means the next query tries again.
#[derive(Debug, Serialize, Deserialize)]
struct CachedChat {
    #[serde(default = "segment_version")]
    version: u32,
    stamp: String,
    #[serde(default)]
    documents: Vec<SearchDocument>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SearchDocument {
    speaker: String,
    role: String,
    text: String,
}

// Only a bounded candidate filter stays resident. A negative answer skips the
// segment, while a positive answer always runs the original substring search.
const FILTER_WORDS: usize = 256;
const FILTER_LIMIT: usize = 4096;
const FILTER_FILE_LIMIT: u64 = 32 * 1024 * 1024;

fn segment_version() -> u32 {
    SEGMENT_VERSION
}

#[derive(Default, Serialize, Deserialize)]
struct Filters {
    #[serde(default)]
    chats: HashMap<String, CandidateFilter>,
}

#[derive(Serialize, Deserialize)]
struct CandidateFilter {
    stamp: String,
    bits: Vec<u64>,
}

impl CandidateFilter {
    fn positions(chars: &[char]) -> [usize; 2] {
        let mut hash = chars.len() as u64;
        for ch in chars {
            hash = (hash ^ *ch as u64).wrapping_mul(1099511628211);
        }
        // Separate non-ASCII grams from the common ASCII startup vocabulary.
        let offset = usize::from(chars.iter().any(|ch| !ch.is_ascii())) * FILTER_WORDS * 32;
        let mask = FILTER_WORDS * 32 - 1;
        [
            offset + (hash as usize & mask),
            offset + ((hash >> 23) as usize & mask),
        ]
    }

    fn new(chat: &CachedChat) -> Self {
        let mut filter = Self {
            stamp: chat.stamp.clone(),
            bits: vec![0; FILTER_WORDS],
        };
        for document in &chat.documents {
            let chars: Vec<_> = document.text.to_lowercase().chars().collect();
            for size in [2, 3] {
                for gram in chars.windows(size) {
                    for bit in Self::positions(gram) {
                        filter.bits[bit / 64] |= 1 << (bit % 64);
                    }
                }
            }
        }
        filter
    }

    fn may_match(&self, words: &[String]) -> bool {
        if self.bits.len() != FILTER_WORDS {
            return true;
        }
        words.iter().all(|word| {
            let chars: Vec<_> = word.chars().collect();
            let size = chars.len().min(3);
            size < 2
                || chars.windows(size).all(|gram| {
                    Self::positions(gram)
                        .iter()
                        .all(|bit| self.bits[bit / 64] & (1 << (bit % 64)) != 0)
                })
        })
    }
}

struct SearchState {
    root: PathBuf,
    filters: Filters,
    legacy_checked: bool,
}
static SEARCH_STATE: Mutex<Option<SearchState>> = Mutex::new(None);

fn load_filters(root: &Path) -> Result<Filters, String> {
    let path = root.join("search-filters-v1.json");
    // Bound the serialized input as well as the resident map.
    let oversized = fs::metadata(&path).is_ok_and(|m| m.len() > FILTER_FILE_LIMIT);
    crate::profile::available()?;
    if oversized {
        return Ok(Filters::default());
    }
    let raw = match crate::profile::read(&path, |e| e.to_string()) {
        Ok(raw) => raw,
        Err(_) => {
            crate::profile::available()?;
            None
        }
    };
    Ok(raw
        .filter(|bytes| bytes.len() as u64 <= FILTER_FILE_LIMIT)
        .and_then(|bytes| serde_json::from_slice::<Filters>(&bytes).ok())
        .filter(|f| {
            f.chats.len() <= FILTER_LIMIT
                && f.chats.keys().all(|id| id.len() <= 512)
                && f.chats
                    .values()
                    .all(|f| f.bits.len() == FILTER_WORDS && f.stamp.len() <= 128)
        })
        .unwrap_or_default())
}

fn remember_filter(filters: &mut Filters, id: &str, chat: &CachedChat) -> bool {
    if id.len() <= 512
        && chat.stamp.len() <= 128
        && (filters.chats.len() < FILTER_LIMIT || filters.chats.contains_key(id))
    {
        filters
            .chats
            .insert(id.to_owned(), CandidateFilter::new(chat));
        true
    } else {
        false
    }
}

/// Preserve the valid legacy cache's exact text/speaker/role before switching
/// storage. Unknown token fields are skipped, not allocated. The old file is
/// never edited, and an incomplete publication leaves no completion marker.
fn migrate_legacy(root: &Path, filters: &mut Filters) -> Result<bool, String> {
    let marker = root.join(SEGMENT_FOLDER).join("legacy-v2-imported");
    if crate::profile::read(&marker, |e| e.to_string())?.is_some() {
        return Ok(false);
    }
    #[derive(Deserialize)]
    struct Legacy {
        version: u32,
        #[serde(default)]
        chats: HashMap<String, CachedChat>,
    }
    let Some(raw) = crate::profile::read(&root.join("search-index.json"), |e| e.to_string())?
    else {
        return Ok(false);
    };
    let Ok(legacy) = serde_json::from_slice::<Legacy>(&raw) else {
        return Ok(false);
    };
    drop(raw);
    if legacy.version != 2 {
        return Ok(false);
    }
    for (id, mut chat) in legacy.chats {
        chat.version = SEGMENT_VERSION;
        for document in &mut chat.documents {
            document.text = one_line(&document.text);
        }
        save_segment(&segment_path(root, &id), &chat)?;
        remember_filter(filters, &id, &chat);
    }
    save_json(&root.join("search-filters-v1.json"), filters)?;
    crate::profile::make_dir(marker.parent().unwrap())?;
    fs::write(marker, b"2").map_err(|e| e.to_string())?;
    Ok(true)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSearchHit {
    pub id: String,
    pub excerpt: String,
    pub speaker: String,
    pub role: String,
}

#[derive(Debug)]
struct Entry {
    speaker: String,
    role: String,
    text: String,
}

#[derive(Debug)]
struct BestMatch {
    score: usize,
    excerpt: String,
    speaker: String,
    role: String,
}

/// Search every active chat, newest as the tie-breaker. Deleted chats are
/// deliberately absent: they belong to Trash, not ordinary navigation.
pub fn search(
    workspaces: &WorkspaceState,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<ChatSearchHit>, String> {
    let query = one_line(&query);
    if query.chars().count() < 2 {
        return Err("Type at least two characters to search chats.".into());
    }
    let query_lower = query.to_lowercase();
    let words = search_words(&query_lower);
    if words.is_empty() {
        return Err("Search needs letters or numbers.".into());
    }

    // Front-desk chats are in no listing, this one included.
    let chats = crate::agent_chat::visible_chats(crate::chat_index::list());
    let workspace_names: HashMap<String, String> =
        crate::workspaces::list_workspaces_impl(workspaces)?
            .into_iter()
            .map(|workspace| (workspace.id, workspace.name))
            .collect();
    let root = crate::transcript::chats_folder()?;
    let mut guard = SEARCH_STATE.lock().map_err(|e| e.to_string())?;
    if guard.as_ref().is_none_or(|state| state.root != root) {
        *guard = Some(SearchState {
            root: root.clone(),
            filters: load_filters(&root)?,
            legacy_checked: false,
        });
    }
    let state = guard.as_mut().expect("search state");
    // Cache failures do not refuse a source read, but a missing/replaced
    // profile always does. A migration is retried until its marker is saved.
    if !state.legacy_checked {
        match migrate_legacy(&root, &mut state.filters) {
            Ok(_) => state.legacy_checked = true,
            Err(_) => {
                crate::profile::available()?;
            }
        }
    }
    let active: HashSet<_> = chats.iter().map(|meta| meta.id.as_str()).collect();
    let before = state.filters.chats.len();
    state
        .filters
        .chats
        .retain(|id, _| active.contains(id.as_str()));
    let mut changed = before != state.filters.chats.len();

    let limit = limit.unwrap_or(50).clamp(1, 50);
    let mut matches = Vec::new();
    // Metadata is cheap and can outrank every document. Establish that floor
    // before loading segments; then a chat whose best possible document cannot
    // enter the result page needs no archive read at all.
    for (order, meta) in chats.iter().enumerate() {
        let project = workspace_names
            .get(&meta.project_id)
            .map(String::as_str)
            .unwrap_or("Unknown project");
        if let Some(best) = best_match(meta, project, &[], &query_lower, &words) {
            keep_hit(&mut matches, meta, order, best, limit);
        }
    }
    let document_max = 20 + words.len() * 4 + 80;
    for (order, meta) in chats.iter().enumerate() {
        if matches
            .iter()
            .any(|hit| hit.2 == order && hit.0 > document_max)
        {
            continue;
        }
        if matches.len() == limit
            && matches.last().is_some_and(|last| {
                last.0 > document_max
                    || (last.0 == document_max
                        && (last.1 > meta.updated_at
                            || (last.1 == meta.updated_at && last.2 < order)))
            })
        {
            continue;
        }
        let project = workspace_names
            .get(&meta.project_id)
            .map(String::as_str)
            .unwrap_or("Unknown project");
        let documents = match crate::transcript::path_for(&format!("chat:{}", meta.id)) {
            Some(path) => {
                let stamp = transcript_stamp(&path);
                let filter = state
                    .filters
                    .chats
                    .get(&meta.id)
                    .filter(|filter| stamp.as_deref() == Some(filter.stamp.as_str()));
                if filter.is_some_and(|filter| !filter.may_match(&words)) {
                    Vec::new()
                } else {
                    let chat = cached_chat(&root, &meta.id, &path)?;
                    if stamp.as_deref() == Some(chat.stamp.as_str()) && filter.is_none() {
                        changed |= remember_filter(&mut state.filters, &meta.id, &chat);
                    }
                    chat.documents
                }
            }
            None => Vec::new(),
        };
        if let Some(best) = best_match(meta, project, &documents, &query_lower, &words) {
            keep_hit(&mut matches, meta, order, best, limit);
        }
    }
    if changed {
        let _ = save_json(&root.join("search-filters-v1.json"), &state.filters);
    }
    crate::profile::available()?;
    Ok(matches.into_iter().map(|(_, _, _, hit)| hit).collect())
}

type RankedHit = (usize, i64, usize, ChatSearchHit);

fn keep_hit(
    matches: &mut Vec<RankedHit>,
    meta: &ChatMeta,
    order: usize,
    best: BestMatch,
    limit: usize,
) {
    matches.retain(|entry| entry.2 != order);
    matches.push((
        best.score,
        meta.updated_at,
        order,
        ChatSearchHit {
            id: meta.id.clone(),
            excerpt: best.excerpt,
            speaker: best.speaker,
            role: best.role,
        },
    ));
    matches.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)).then(a.2.cmp(&b.2)));
    matches.truncate(limit);
}

fn best_match(
    meta: &ChatMeta,
    project: &str,
    documents: &[SearchDocument],
    query: &str,
    words: &[String],
) -> Option<BestMatch> {
    let mut best = None;
    for document in documents {
        // Segment text is already whitespace-normalized by entry_chunks.
        let score = search_score(&document.text.to_lowercase(), query, words, 1);
        if score == 0
            || best
                .as_ref()
                .is_some_and(|found: &BestMatch| found.score >= score)
        {
            continue;
        }
        best = Some(BestMatch {
            score,
            excerpt: search_excerpt(&document.text, words, EXCERPT_CHARS),
            speaker: document.speaker.clone(),
            role: document.role.clone(),
        });
        // No later document can beat an exact phrase. Metadata below can
        // still win by weight; equal document scores keep the first excerpt.
        if score == 20 + words.len() * 4 + 80 {
            break;
        }
    }

    let metadata = [
        (meta.title.as_str(), 4, "Title", "metadata"),
        (
            meta.latest_response.as_deref().unwrap_or_default(),
            2,
            "Latest response",
            "assistant",
        ),
        (project, 1, "Project", "metadata"),
    ];
    for (value, weight, speaker, role) in metadata {
        let normalized = one_line(value);
        let lower = normalized.to_lowercase();
        let score = search_score(&lower, query, words, weight);
        if score == 0 || best.as_ref().is_some_and(|found| found.score >= score) {
            continue;
        }
        best = Some(BestMatch {
            score,
            excerpt: search_excerpt(&normalized, words, EXCERPT_CHARS),
            speaker: speaker.into(),
            role: role.into(),
        });
    }
    best
}

fn segment_path(root: &Path, id: &str) -> PathBuf {
    // IDs are untrusted strings, never paths; hashing also bounds filename size.
    root.join(SEGMENT_FOLDER)
        .join(format!("{:x}.json", Sha256::digest(id.as_bytes())))
}

#[cfg(test)]
fn documents_for_chat(
    root: &Path,
    id: &str,
    transcript: &Path,
) -> Result<Vec<SearchDocument>, String> {
    cached_chat(root, id, transcript).map(|chat| chat.documents)
}

fn cached_chat(root: &Path, id: &str, transcript: &Path) -> Result<CachedChat, String> {
    let target = segment_path(root, id);
    let raw = match crate::profile::read(&target, |error| error.to_string()) {
        Ok(raw) => raw,
        Err(_) => {
            crate::profile::available()?;
            None
        }
    };
    let mut cached = raw
        .and_then(|bytes| serde_json::from_slice::<CachedChat>(&bytes).ok())
        .filter(|cached| cached.version == SEGMENT_VERSION);
    let Some(stamp) = transcript_stamp(transcript) else {
        return Ok(CachedChat {
            version: SEGMENT_VERSION,
            stamp: String::new(),
            documents: Vec::new(),
        });
    };
    if cached.as_ref().is_some_and(|cached| cached.stamp == stamp) {
        return Ok(cached.take().expect("matching segment"));
    }
    let documents = match index_transcript(transcript) {
        Ok(documents) => documents,
        // A temporary transcript read failure keeps the last good derivative.
        Err(_) => {
            return Ok(cached.unwrap_or(CachedChat {
                version: SEGMENT_VERSION,
                stamp: String::new(),
                documents: Vec::new(),
            }))
        }
    };
    let rebuilt = CachedChat {
        version: SEGMENT_VERSION,
        stamp,
        documents,
    };
    // A growing or cleared record is searched as read, but never certified with
    // the pre-read stamp. The next query rebuilds it from the new record.
    if transcript_stamp(transcript).as_ref() == Some(&rebuilt.stamp) {
        let _ = save_segment(&target, &rebuilt);
    }
    Ok(rebuilt)
}

fn save_segment(target: &Path, cached: &CachedChat) -> Result<(), String> {
    save_json(target, cached)
}

fn save_json(target: &Path, cached: &impl Serialize) -> Result<(), String> {
    let root = target.parent().ok_or("Search segment needs a folder")?;
    crate::profile::make_dir(root)?;
    let temp = root.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let file = File::create(&temp).map_err(|e| e.to_string())?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer(&mut writer, cached).map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;
        drop(writer);
        crate::profile::available()?;
        fs::rename(&temp, target).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn transcript_stamp(path: &Path) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return None;
    }
    let modified = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some(format!("{}:{modified}", meta.len()))
}

fn index_transcript(path: &Path) -> Result<Vec<SearchDocument>, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut documents = Vec::new();
    // A line that cannot be decoded is passed over, never the end of the
    // read (`transcript::for_each_line`).
    crate::transcript::for_each_line(file, |_, line| {
        let Ok(event) = serde_json::from_slice::<Value>(line) else {
            return;
        };
        for entry in conversation_entries(&event) {
            for text in entry_chunks(&entry.text) {
                if !text.chars().any(char::is_alphanumeric) {
                    continue;
                }
                let document = SearchDocument {
                    speaker: entry.speaker.clone(),
                    role: entry.role.clone(),
                    text,
                };
                documents.push(document);
            }
        }
    });
    Ok(documents)
}

fn conversation_entries(event: &Value) -> Vec<Entry> {
    let speaker = |fallback: &str| {
        event["octiq_speaker"]["name"]
            .as_str()
            .map(one_line)
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| fallback.to_string())
    };
    // Antigravity's closing words are its `result`'s response; its other
    // events carry only pieces of them.
    if event["event"] == "result" {
        return event["result"]["response"]
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(|text| Entry {
                speaker: speaker("Assistant"),
                role: "assistant".into(),
                text: text.to_string(),
            })
            .into_iter()
            .collect();
    }
    match event["type"].as_str().unwrap_or_default() {
        "user" => content_text(&event["message"]["content"])
            .filter(|text| !text.is_empty())
            .map(|text| Entry {
                speaker: speaker("You"),
                role: "user".into(),
                text: compact_skill_prompt(text),
            })
            .into_iter()
            .collect(),
        "assistant" => content_text(&event["message"]["content"])
            .filter(|text| !text.is_empty())
            .map(|text| Entry {
                speaker: speaker("Assistant"),
                role: "assistant".into(),
                text,
            })
            .into_iter()
            .collect(),
        "message_end" if event["message"]["role"] == "assistant" => {
            content_text(&event["message"]["content"])
                .filter(|text| !text.is_empty())
                .map(|text| Entry {
                    speaker: speaker("Assistant"),
                    role: "assistant".into(),
                    text,
                })
                .into_iter()
                .collect()
        }
        "item.completed" if event["item"]["type"] == "agent_message" => event["item"]["text"]
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(|text| Entry {
                speaker: speaker("Assistant"),
                role: "assistant".into(),
                text: text.to_string(),
            })
            .into_iter()
            .collect(),
        _ => Vec::new(),
    }
}

fn content_text(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.trim().to_string());
    }
    let blocks = content.as_array()?;
    let text = blocks
        .iter()
        .filter(|block| block["type"] == "text")
        .filter_map(|block| block["text"].as_str())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    Some(text)
}

fn compact_skill_prompt(text: String) -> String {
    if !text.starts_with("Base directory for this skill:") {
        return text;
    }
    let first = text.lines().next().unwrap_or_default();
    let base = first
        .trim_start_matches("Base directory for this skill:")
        .trim();
    let name = Path::new(base)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("skill");
    match text.rsplit_once("\nARGUMENTS:") {
        Some((_, args)) if !args.trim().is_empty() => format!("Ran /{name}: {}", args.trim()),
        _ => format!("Ran /{name}"),
    }
}

fn entry_chunks(value: &str) -> Vec<String> {
    let text = one_line(value);
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let end = (start + SEARCH_CHUNK_CHARS).min(chars.len());
        chunks.push(chars[start..end].iter().collect());
        if end == chars.len() {
            break;
        }
        start += SEARCH_CHUNK_CHARS - SEARCH_CHUNK_OVERLAP;
    }
    chunks
}

fn search_words(value: &str) -> Vec<String> {
    alphanumeric_runs(value)
}

fn alphanumeric_runs(value: &str) -> Vec<String> {
    let mut runs = Vec::new();
    let mut current = String::new();
    for ch in value.to_lowercase().chars() {
        if ch.is_alphanumeric() {
            current.push(ch);
        } else if !current.is_empty() {
            runs.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        runs.push(current);
    }
    runs
}

fn search_score(value: &str, query: &str, words: &[String], weight: usize) -> usize {
    if value.is_empty() || !words.iter().all(|word| value.contains(word)) {
        return 0;
    }
    weight * (20 + words.len() * 4 + usize::from(value.contains(query)) * 80)
}

fn search_excerpt(value: &str, words: &[String], max: usize) -> String {
    let text = one_line(value);
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        return text;
    }
    let lower = text.to_lowercase();
    let hit = words
        .iter()
        .filter_map(|word| lower.find(word))
        .map(|byte| lower[..byte].chars().count())
        .min()
        .unwrap_or(0);
    let start = hit.saturating_sub(max / 3).min(chars.len() - max);
    let body: String = chars[start..start + max].iter().collect();
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        body.trim(),
        if start + max < chars.len() { "…" } else { "" }
    )
}

fn one_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(path: &Path, text: &str) {
        fs::write(
            path,
            format!("{}\n", json!({"type":"user","message":{"content":text}})),
        )
        .unwrap();
    }

    #[test]
    fn bounded_result_pruning_and_filters_equal_an_unpruned_corpus_scan() {
        let home = crate::profile::tests::Home::with_a_configured_base();
        let _process = crate::profile::started_in(&home.dir);
        let root = crate::profile::profile_dir().join("chats");
        crate::profile::make_dir(&root).unwrap();
        for n in 0..64 {
            let id = format!("pruning-{n}");
            let title = ["memory", "内存", "profile", "other"][n % 4];
            let latest = if n % 3 == 0 {
                "memory profile"
            } else {
                "other words"
            };
            let meta: ChatMeta = serde_json::from_value(json!({
                "id":id,"projectId":"p","title":title,
                "latestResponse":latest,
                "createdAt":n,"updatedAt":n % 7
            }))
            .unwrap();
            crate::chat_index::upsert(meta).unwrap();
            let path = crate::transcript::path_for(&format!("chat:{id}")).unwrap();
            record(
                &path,
                [
                    "memory profile 内存",
                    "memory x y",
                    "other words",
                    "人物内存",
                    "profile details",
                ][n % 5],
            );
        }
        let workspaces = crate::workspaces::WorkspaceState::with_projects(Vec::new());
        for query in [
            "memory",
            "profile",
            "内存",
            "x y",
            "other",
            "absent-zz",
            "me",
        ] {
            for limit in [1, 3, 50] {
                let words = search_words(query);
                let mut full = Vec::new();
                for meta in crate::chat_index::list() {
                    let path = crate::transcript::path_for(&format!("chat:{}", meta.id)).unwrap();
                    let documents = index_transcript(&path).unwrap();
                    if let Some(best) =
                        best_match(&meta, "Unknown project", &documents, query, &words)
                    {
                        full.push((
                            best.score,
                            meta.updated_at,
                            ChatSearchHit {
                                id: meta.id,
                                excerpt: best.excerpt,
                                speaker: best.speaker,
                                role: best.role,
                            },
                        ));
                    }
                }
                full.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
                let expected: Vec<_> = full
                    .into_iter()
                    .take(limit)
                    .map(|(_, _, hit)| hit)
                    .collect();
                let actual = search(&workspaces, query.into(), Some(limit)).unwrap();
                assert_eq!(
                    serde_json::to_value(actual).unwrap(),
                    serde_json::to_value(expected).unwrap(),
                    "query={query}, limit={limit}"
                );
            }
        }
    }

    #[test]
    fn candidate_filters_never_drop_ascii_or_unicode_substring_matches() {
        let text = "Mixed Memory PROFILE 内存和人物 𠮷野家 Straße İSTANBUL Key";
        let chat = CachedChat {
            version: SEGMENT_VERSION,
            stamp: "s".into(),
            documents: vec![SearchDocument {
                speaker: "You".into(),
                role: "user".into(),
                text: text.into(),
            }],
        };
        let filter = CandidateFilter::new(&chat);
        let lower = text.to_lowercase();
        let chars: Vec<_> = lower.chars().collect();
        for size in 1..=8 {
            for substring in chars.windows(size) {
                let query: String = substring.iter().collect();
                let words = search_words(&query);
                assert!(filter.may_match(&words), "false negative for {query:?}");
            }
        }
        let empty = CandidateFilter {
            stamp: "s".into(),
            bits: vec![0; FILTER_WORDS],
        };
        assert!(!empty.may_match(&["missing".into()]));
        assert!(empty.may_match(&["x".into()]));
        assert!(CandidateFilter {
            stamp: "s".into(),
            bits: Vec::new()
        }
        .may_match(&["memory".into()]));
    }

    #[test]
    fn importing_legacy_cache_preserves_speakers_and_leaves_the_original_bytes() {
        let root = crate::test_dir::TestDir::new("search-legacy-import");
        let transcript = root.join("record.jsonl");
        record(&transcript, "memory 内存");
        let legacy = root.join("search-index.json");
        let raw = serde_json::to_vec(&json!({"version":2,"chats":{"record":{
            "stamp":transcript_stamp(&transcript).unwrap(),"documents":[{
                "speaker":"User","role":"user","text":"memory   内存","tokens":["memory","内存"]
            }]
        }}}))
        .unwrap();
        fs::write(&legacy, &raw).unwrap();
        let mut filters = Filters::default();
        assert!(migrate_legacy(&root, &mut filters).unwrap());
        let documents = documents_for_chat(&root, "record", &transcript).unwrap();
        assert_eq!(documents[0].speaker, "User");
        assert_eq!(documents[0].text, "memory 内存");
        assert_eq!(fs::read(&legacy).unwrap(), raw);
        assert!(filters.chats["record"].may_match(&["内存".into()]));
        assert!(!migrate_legacy(&root, &mut filters).unwrap());
        // A corrupt filter index is only a cache miss, never negative evidence.
        fs::write(root.join("search-filters-v1.json"), b"{partial").unwrap();
        assert!(load_filters(&root).unwrap().chats.is_empty());
    }

    #[test]
    fn candidate_filter_admission_has_a_hard_resident_bound() {
        let chat = CachedChat {
            version: SEGMENT_VERSION,
            stamp: "s".into(),
            documents: Vec::new(),
        };
        let mut filters = Filters::default();
        for n in 0..FILTER_LIMIT {
            assert!(remember_filter(&mut filters, &n.to_string(), &chat));
        }
        assert!(!remember_filter(&mut filters, "overflow", &chat));
        assert_eq!(filters.chats.len(), FILTER_LIMIT);
        assert!(remember_filter(&mut filters, "0", &chat));
        assert_eq!(filters.chats.len(), FILTER_LIMIT);
    }

    #[test]
    fn segments_refresh_independently_and_leave_the_legacy_cache_intact() {
        let root = crate::test_dir::TestDir::new("search-segments");
        let a = root.join("a.jsonl");
        let b = root.join("b.jsonl");
        let legacy = root.join("search-index.json");
        fs::write(&legacy, b"legacy cache kept for older readers").unwrap();
        record(&a, "first zebra");
        record(&b, "second heron");
        assert_eq!(
            documents_for_chat(&root, "a", &a).unwrap()[0].text,
            "first zebra"
        );
        documents_for_chat(&root, "b", &b).unwrap();
        let untouched = fs::read(segment_path(&root, "b")).unwrap();
        record(&a, "a newer and longer zebra");
        assert_eq!(
            documents_for_chat(&root, "a", &a).unwrap()[0].text,
            "a newer and longer zebra"
        );
        assert_eq!(fs::read(segment_path(&root, "b")).unwrap(), untouched);
        assert_eq!(
            fs::read(legacy).unwrap(),
            b"legacy cache kept for older readers"
        );
        // A hot read reuses a valid derivative without rebuilding its record.
        let target = segment_path(&root, "a");
        let mut segment: CachedChat = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
        segment.documents[0].text = "cached zebra".into();
        save_segment(&target, &segment).unwrap();
        assert_eq!(
            documents_for_chat(&root, "a", &a).unwrap()[0].text,
            "cached zebra"
        );
    }

    #[test]
    fn corrupt_segments_and_failed_cache_writes_do_not_lose_searchable_text() {
        let root = crate::test_dir::TestDir::new("search-segment-recovery");
        let transcript = root.join("record.jsonl");
        record(&transcript, "the heron returned");
        let target = segment_path(&root, "../arbitrary/id");
        assert_eq!(target.parent().unwrap(), root.join(SEGMENT_FOLDER));
        // A folder cannot be created here. Search still answers from its source.
        fs::write(root.join(SEGMENT_FOLDER), b"cache not writable").unwrap();
        assert_eq!(
            documents_for_chat(&root, "../arbitrary/id", &transcript).unwrap()[0].text,
            "the heron returned"
        );
        fs::remove_file(root.join(SEGMENT_FOLDER)).unwrap();
        crate::profile::make_dir(target.parent().unwrap()).unwrap();
        fs::write(&target, b"{part of an interrupted cache").unwrap();
        assert_eq!(
            documents_for_chat(&root, "../arbitrary/id", &transcript).unwrap()[0].text,
            "the heron returned"
        );
        let segment: CachedChat = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
        assert_eq!(segment.version, SEGMENT_VERSION);
        assert_eq!(fs::read_dir(target.parent().unwrap()).unwrap().count(), 1);
        fs::remove_file(&transcript).unwrap();
        assert!(documents_for_chat(&root, "../arbitrary/id", &transcript)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn search_segments_never_default_or_write_into_a_missing_or_replaced_profile() {
        let home = crate::profile::tests::Home::with_a_configured_base();
        let _process = crate::profile::started_in(&home.dir);
        let root = crate::profile::profile_dir().join("chats");
        crate::profile::make_dir(&root).unwrap();
        let transcript = root.join("record.jsonl");
        record(&transcript, "kept words");
        documents_for_chat(&root, "record", &transcript).unwrap();
        home.move_away();
        let missing = documents_for_chat(&root, "record", &transcript).unwrap_err();
        assert!(missing.contains("not available right now"), "{missing}");
        assert!(!home.profile().exists());
        home.move_back();
        assert_eq!(
            documents_for_chat(&root, "record", &transcript).unwrap()[0].text,
            "kept words"
        );
        home.replace();
        let replaced = documents_for_chat(&root, "record", &transcript).unwrap_err();
        assert!(replaced.contains("not the folder"), "{replaced}");
        assert!(!root.join(SEGMENT_FOLDER).exists());
        home.move_back();
    }

    #[test]
    fn extracts_user_and_provider_assistant_messages_without_tool_noise() {
        let user = json!({"type":"user","message":{"content":[{"type":"text","text":"find the routing bug"},{"type":"tool_result","content":"ignore me"}]}});
        let assistant = json!({"type":"item.completed","item":{"type":"agent_message","text":"The route is fixed."}});
        let pi_assistant = json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Pi fixed the route too."}]}});
        assert_eq!(conversation_entries(&user)[0].text, "find the routing bug");
        assert_eq!(
            conversation_entries(&assistant)[0].text,
            "The route is fixed."
        );
        assert_eq!(
            conversation_entries(&pi_assistant)[0].text,
            "Pi fixed the route too."
        );
        assert!(conversation_entries(&json!({"type":"item.completed","item":{"type":"command_execution","aggregated_output":"secret"}})).is_empty());
    }

    #[test]
    fn unicode_queries_and_excerpts_match_full_message_text() {
        let words = search_words("人物 动机");
        let text = format!("{}人物的核心动机决定下一章。", "前情".repeat(150));
        let lower = text.to_lowercase();
        assert!(search_score(&lower, "人物 动机", &words, 1) > 0);
        let excerpt = search_excerpt(&text, &words, 80);
        assert!(excerpt.contains("人物"));
        assert!(excerpt.chars().count() <= 82);
    }

    #[test]
    fn chunks_overlap_so_a_phrase_at_the_boundary_is_searchable() {
        let text = format!("{}boundary phrase{}", "x".repeat(1_195), "y".repeat(200));
        let chunks = entry_chunks(&text);
        assert_eq!(chunks.len(), 2);
        assert!(chunks.iter().any(|chunk| chunk.contains("boundary phrase")));
    }

    #[test]
    fn a_front_desk_chat_is_in_no_list_no_search_and_no_resume_list() {
        let team = crate::test_dir::TestPath::new("desk", "team.json");
        let _team = crate::team::use_test_path(team.to_path_buf());
        let desk = crate::team::create_front_desk(&team, Default::default()).unwrap();
        let desk_id = uuid::Uuid::new_v4().to_string();
        let plain_id = uuid::Uuid::new_v4().to_string();
        let desk_key = format!("chat:{desk_id}");
        crate::team::brief(
            &team,
            &desk_key,
            "p1",
            &desk.id,
            "find the zebra",
            false,
            &[],
        )
        .unwrap();
        crate::team::note_front_desk_session(
            &team,
            &desk_key,
            crate::agent_chat::ChatAgent::Claude,
            "desk-session",
        );
        let meta = |id: &str| -> crate::chat_index::ChatMeta {
            serde_json::from_value(json!({
                "id": id, "projectId": "p1", "title": "zebra hunt", "createdAt": 1, "updatedAt": 1,
            }))
            .unwrap()
        };

        // A page saving it is a no-op...
        crate::agent_chat::chat_index_save(meta(&desk_id)).unwrap();
        assert!(!crate::chat_index::list().iter().any(|m| m.id == desk_id));
        crate::agent_chat::chat_index_save(meta(&plain_id)).unwrap();
        // ...and a row an older page wrote anyway is still never listed.
        crate::chat_index::upsert(meta(&desk_id)).unwrap();
        let listed = crate::agent_chat::chat_index_list();
        assert!(listed.iter().any(|m| m.id == plain_id));
        assert!(
            !listed.iter().any(|m| m.id == desk_id),
            "hidden by identity"
        );

        for id in [&desk_id, &plain_id] {
            crate::transcript::append(
                &format!("chat:{id}"),
                &json!({"type":"user","message":{"content":"where is the zebra"}}),
            );
        }
        let hits = search(
            &crate::workspaces::WorkspaceState::with_projects(Vec::new()),
            "zebra".into(),
            Some(50),
        )
        .unwrap();
        assert!(hits.iter().any(|hit| hit.id == plain_id));
        assert!(!hits.iter().any(|hit| hit.id == desk_id));

        // "Resume an earlier session" and its count.
        let session = |agent: &str, id: &str| crate::agent_history::HistorySession {
            agent: agent.into(),
            session_id: id.into(),
            title: "where is the zebra".into(),
            cwd: "/tmp".into(),
            started_at: 1,
            updated_at: 1,
            model: None,
            effort: None,
            origin: None,
        };
        let kept = crate::agent_history::without_front_desks(
            vec![
                session("claude", "desk-session"),
                session("codex", "desk-session"),
                session("claude", "other-session"),
            ],
            &crate::team::front_desk_chats(&team),
        );
        assert_eq!(
            kept.iter()
                .map(|s| format!("{}:{}", s.agent, s.session_id))
                .collect::<Vec<_>>(),
            vec!["codex:desk-session", "claude:other-session"],
            "another provider's session sharing the id is not the desk's"
        );

        crate::chat_index::remove(&desk_id).unwrap();
        crate::chat_index::remove(&plain_id).unwrap();
    }

    #[test]
    fn antigravity_answers_are_searchable_by_their_result() {
        let events =
            crate::agent_provider::tests::agy_events(crate::agent_provider::tests::AGY_THREE_TURNS);
        let said: Vec<String> = events
            .iter()
            .flat_map(conversation_entries)
            .map(|entry| entry.text)
            .collect();
        // Two answers; the refused turn said nothing, and no piece is
        // indexed twice.
        assert_eq!(said.len(), 2, "{said:?}");
        assert!(said[0].contains("4471"));
        assert_eq!(said[1], "HERON");
    }

    /// Review of bf9d8cd, the carried Medium: the index's reader ended at
    /// the first line that is not UTF-8, so nothing said after one could
    /// be searched for.
    #[test]
    fn a_line_that_is_not_utf8_hides_nothing_said_after_it_from_search() {
        let file = crate::test_dir::TestPath::new("search-damaged", "chat_damaged.jsonl");
        let mut bytes = b"{\"type\":\"user\",\"message\":{\"content\":\"first words\"}}\n".to_vec();
        bytes.extend_from_slice(b"{\"type\":\"assistant\",\"text\":\"\xE4\xBD\n");
        bytes.extend_from_slice(
            b"{\"type\":\"user\",\"message\":{\"content\":\"the heron came back\"}}\n",
        );
        fs::write(&file, bytes).unwrap();

        let said: Vec<String> = index_transcript(&file)
            .unwrap()
            .into_iter()
            .map(|document| document.text)
            .collect();
        assert_eq!(said, ["first words", "the heron came back"]);
    }
}
