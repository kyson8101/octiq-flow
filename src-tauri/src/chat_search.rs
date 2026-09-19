//! Full-text search over active OctiqFlow conversations.
//!
//! The small chat index knows titles and the latest response; the actual words
//! live in one append-only JSONL transcript per chat. Search keeps a compact,
//! incremental cache beside those transcripts. A transcript is parsed again
//! only when its size or modified time changes, so typing a longer query does
//! not repeatedly walk the archive.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::chat_index::ChatMeta;
use crate::workspaces::WorkspaceState;

const SEARCH_INDEX_VERSION: u32 = 2;
const SEARCH_CHUNK_CHARS: usize = 1_200;
const SEARCH_CHUNK_OVERLAP: usize = 120;
const EXCERPT_CHARS: usize = 220;

#[derive(Debug, Default, Serialize, Deserialize)]
struct SearchCache {
    version: u32,
    #[serde(default)]
    chats: HashMap<String, CachedChat>,
}

impl SearchCache {
    fn empty() -> Self {
        Self {
            version: SEARCH_INDEX_VERSION,
            chats: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedChat {
    stamp: String,
    #[serde(default)]
    documents: Vec<SearchDocument>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SearchDocument {
    speaker: String,
    role: String,
    text: String,
    /// Persisted for compatibility with the agent-facing conversation search,
    /// which uses the same cache file and builds an inverted index from these.
    #[serde(default)]
    tokens: Vec<String>,
    /// Runtime-only normalized text. Keeping it here avoids allocating one
    /// lowercase copy of every transcript chunk for every keystroke.
    #[serde(skip)]
    lower: String,
}

impl SearchDocument {
    fn hydrate(&mut self) {
        self.lower = one_line(&self.text).to_lowercase();
    }
}

struct SearchState {
    root: PathBuf,
    cache: SearchCache,
}

static SEARCH_STATE: Mutex<Option<SearchState>> = Mutex::new(None);

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

    let chats = crate::chat_index::list();
    let workspace_names: HashMap<String, String> =
        crate::workspaces::list_workspaces_impl(workspaces)?
            .into_iter()
            .map(|workspace| (workspace.id, workspace.name))
            .collect();
    let root = crate::transcript::chats_dir()
        .ok_or_else(|| "The chat archive is unavailable.".to_string())?;
    let mut guard = SEARCH_STATE.lock().map_err(|e| e.to_string())?;
    if guard.as_ref().is_none_or(|state| state.root != root) {
        *guard = Some(SearchState {
            cache: load_cache(&root),
            root: root.clone(),
        });
    }
    let state = guard.as_mut().expect("search state initialized");
    refresh_cache(state, &chats);

    let mut matches: Vec<(usize, i64, ChatSearchHit)> = Vec::new();
    for meta in chats {
        let project = workspace_names
            .get(&meta.project_id)
            .map(String::as_str)
            .unwrap_or("Unknown project");
        let documents = state
            .cache
            .chats
            .get(&meta.id)
            .map(|chat| chat.documents.as_slice())
            .unwrap_or_default();
        let Some(best) = best_match(&meta, project, documents, &query_lower, &words) else {
            continue;
        };
        matches.push((
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
    matches.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    Ok(matches
        .into_iter()
        .take(limit.unwrap_or(50).clamp(1, 50))
        .map(|(_, _, hit)| hit)
        .collect())
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
        let score = search_score(&document.lower, query, words, 1);
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

fn refresh_cache(state: &mut SearchState, chats: &[ChatMeta]) {
    let active: HashSet<&str> = chats.iter().map(|chat| chat.id.as_str()).collect();
    let before = state.cache.chats.len();
    state
        .cache
        .chats
        .retain(|id, _| active.contains(id.as_str()));
    let mut changed = state.cache.chats.len() != before;

    for chat in chats {
        let key = format!("chat:{}", chat.id);
        let Some(path) = crate::transcript::path_for(&key) else {
            changed |= state.cache.chats.remove(&chat.id).is_some();
            continue;
        };
        let Some(stamp) = transcript_stamp(&path) else {
            changed |= state.cache.chats.remove(&chat.id).is_some();
            continue;
        };
        if state
            .cache
            .chats
            .get(&chat.id)
            .is_some_and(|cached| cached.stamp == stamp)
        {
            continue;
        }
        if let Ok(documents) = index_transcript(&path) {
            state
                .cache
                .chats
                .insert(chat.id.clone(), CachedChat { stamp, documents });
            changed = true;
        }
    }
    if changed {
        save_cache(&state.root, &state.cache);
    }
}

fn cache_path(root: &Path) -> PathBuf {
    root.join("search-index.json")
}

fn load_cache(root: &Path) -> SearchCache {
    let path = cache_path(root);
    let mut cache = fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<SearchCache>(&raw).ok())
        .filter(|cache| cache.version == SEARCH_INDEX_VERSION)
        .unwrap_or_else(SearchCache::empty);
    for chat in cache.chats.values_mut() {
        for document in &mut chat.documents {
            document.hydrate();
        }
    }
    cache
}

fn save_cache(root: &Path, cache: &SearchCache) {
    let Ok(raw) = serde_json::to_vec(cache) else {
        return;
    };
    let target = cache_path(root);
    let temp = root.join(format!("search-index.{}.tmp", std::process::id()));
    if fs::write(&temp, raw).is_ok() {
        let _ = fs::rename(&temp, target);
    }
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
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        for entry in conversation_entries(&event) {
            for text in entry_chunks(&entry.text) {
                let tokens = lexical_tokens(&text);
                if tokens.is_empty() {
                    continue;
                }
                let mut document = SearchDocument {
                    speaker: entry.speaker.clone(),
                    role: entry.role.clone(),
                    text,
                    tokens,
                    lower: String::new(),
                };
                document.hydrate();
                documents.push(document);
            }
        }
    }
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

fn lexical_tokens(value: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut seen = HashSet::new();
    for run in alphanumeric_runs(value) {
        if run.chars().all(|ch| ch.is_ascii_alphanumeric()) {
            if seen.insert(run.clone()) {
                tokens.push(run);
            }
            continue;
        }
        let chars: Vec<char> = run.chars().collect();
        if chars.len() == 1 {
            if seen.insert(run.clone()) {
                tokens.push(run);
            }
            continue;
        }
        for pair in chars.windows(2) {
            let token: String = pair.iter().collect();
            if seen.insert(token.clone()) {
                tokens.push(token);
            }
        }
    }
    tokens
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
}
