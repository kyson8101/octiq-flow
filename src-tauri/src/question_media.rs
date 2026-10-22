//! The pictures, recordings and sounds an `ask_user` call shows the person:
//! up to four under a question, and an image on each option.
//!
//! The agent's MCP server reads each file (so with the agent's own rights,
//! never this server's) and streams its bytes here (`/hook/question-media`,
//! `Upload`). The host decides what the bytes are by their first bytes, never
//! by the name, and keeps them as an immutable snapshot under the profile:
//! `<chats dir>/question-media/<chat id>/<id>.<ext>`, a new name every time,
//! never written over. The question then names each snapshot by its id, and
//! `resolve` rebuilds every field the page reads from the file the host
//! wrote: an agent can name a snapshot of its own chat and nothing else.
//!
//! Kept through the trash window and `/clear`; removed
//! with the chat when it is purged (`forget`). Contract:
//! `docs/question-delivery.md`, Media.
use crate::paths::Canonical;
use crate::question::Question;
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::{
    collections::BTreeMap,
    sync::{Mutex, MutexGuard},
};

// Only uploads never adopted by a question can be rolled back. Keeping this
// claim on the host prevents an agent from deleting media already in a record.
static UNCLAIMED: Mutex<BTreeMap<(String, String), PathBuf>> = Mutex::new(BTreeMap::new());

pub fn discard(chat_key: &str, ids: &[String]) -> Result<(), String> {
    let profile = crate::profile::available()?;
    let dir = folder_in(&profile, chat_key)?;
    if !ancestry_is_real(&profile, &dir)? {
        return Ok(());
    }
    if !dir.exists() {
        return Ok(());
    }
    not_redirected(&profile, &dir)?;
    let mut pending = UNCLAIMED.lock().unwrap_or_else(|e| e.into_inner());
    for id in ids {
        let key = (chat_key.to_owned(), id.clone());
        if let Some(path) = pending.get(&key) {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(crate::profile::write_error(path, e)),
            }
            pending.remove(&key);
        }
    }
    Ok(())
}

/// At most this many media files under one question.
pub const MAX_PER_QUESTION: usize = 4;
/// A local image validated before attaching it to a question.
pub const IMAGE_MAX: u64 = 20 * 1024 * 1024;
/// A video or a sound.
pub const PLAYED_MAX: u64 = 200 * 1024 * 1024;
/// Everything one call shows, together.
pub const CALL_MAX: u64 = 300 * 1024 * 1024;
/// A caption, in characters.
pub const CAPTION_MAX: usize = 160;
/// How many bytes are read to tell what a file is.
const SNIFF_LEN: usize = 64;
/// The folder under the chats folder.
const FOLDER: &str = "question-media";
const KINDS: &str =
    "a PNG, JPEG, GIF or WebP image, an MP4, MOV or WebM video, or an MP3, WAV, M4A or OGG sound";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    #[default]
    Image,
    Video,
    Audio,
}

impl Kind {
    /// The word the contract sends.
    pub fn label(self) -> &'static str {
        match self {
            Kind::Image => "image",
            Kind::Video => "video",
            Kind::Audio => "audio",
        }
    }

    fn cap(self) -> u64 {
        match self {
            Kind::Image => IMAGE_MAX,
            Kind::Video | Kind::Audio => PLAYED_MAX,
        }
    }

    fn word(self) -> &'static str {
        match self {
            Kind::Image => "an image",
            Kind::Video => "a video",
            Kind::Audio => "a sound",
        }
    }
}

/// One snapshot, as it is stored on a question or an option and sent to the
/// page. Every field but `name` and `caption` is the host's, read from the
/// file it wrote (`resolve`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", from = "Given")]
pub struct Media {
    pub id: String,
    pub kind: Kind,
    pub mime: String,
    /// The snapshot's absolute path, which `/file` serves.
    pub path: String,
    /// The source file's name, as the agent's MCP server read it.
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    pub bytes: u64,
}

/// A media entry as it arrives. A bare string is a path the agent sent
/// without uploading it: kept, so `resolve` refuses it in words rather than
/// dropping it.
#[derive(Deserialize)]
#[serde(untagged)]
enum Given {
    Path(String),
    Entry(Entry),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    #[serde(default)]
    id: String,
    #[serde(default)]
    kind: Kind,
    #[serde(default)]
    mime: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    caption: Option<String>,
    #[serde(default)]
    bytes: u64,
}

impl From<Given> for Media {
    fn from(given: Given) -> Self {
        let entry = match given {
            Given::Path(path) => Entry {
                id: String::new(),
                kind: Kind::Image,
                mime: String::new(),
                path,
                name: String::new(),
                caption: None,
                bytes: 0,
            },
            Given::Entry(entry) => entry,
        };
        Media {
            id: entry.id,
            kind: entry.kind,
            mime: entry.mime,
            path: entry.path,
            name: entry.name,
            caption: entry.caption,
            bytes: entry.bytes,
        }
    }
}

/// Where a snapshot is shown, which decides what it may be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    /// Under a question: an image, a video or a sound.
    Question,
    /// On an option: an image only, for choosing by look.
    Option,
}

impl Purpose {
    fn cap(self) -> u64 {
        match self {
            Purpose::Question => PLAYED_MAX,
            Purpose::Option => IMAGE_MAX,
        }
    }
}

/// What a file's first bytes say it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Format {
    kind: Kind,
    mime: &'static str,
    /// The extension the snapshot is written with, which `/file` serves by.
    ext: &'static str,
    /// The container, for comparing with a name's extension.
    family: Family,
    said: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Family {
    Png,
    Jpeg,
    Gif,
    Webp,
    /// ISO base media: MP4, MOV and M4A are one container.
    Iso,
    Webm,
    Mp3,
    Wav,
    Ogg,
}

const PNG: Format = Format {
    kind: Kind::Image,
    mime: "image/png",
    ext: "png",
    family: Family::Png,
    said: "a PNG image",
};
const JPEG: Format = Format {
    kind: Kind::Image,
    mime: "image/jpeg",
    ext: "jpg",
    family: Family::Jpeg,
    said: "a JPEG image",
};
const GIF: Format = Format {
    kind: Kind::Image,
    mime: "image/gif",
    ext: "gif",
    family: Family::Gif,
    said: "a GIF image",
};
const WEBP: Format = Format {
    kind: Kind::Image,
    mime: "image/webp",
    ext: "webp",
    family: Family::Webp,
    said: "a WebP image",
};
const MP4: Format = Format {
    kind: Kind::Video,
    mime: "video/mp4",
    ext: "mp4",
    family: Family::Iso,
    said: "an MP4 video",
};
const MOV: Format = Format {
    kind: Kind::Video,
    mime: "video/quicktime",
    ext: "mov",
    family: Family::Iso,
    said: "a QuickTime video",
};
const M4A: Format = Format {
    kind: Kind::Audio,
    mime: "audio/mp4",
    ext: "m4a",
    family: Family::Iso,
    said: "an M4A sound",
};
const WEBM: Format = Format {
    kind: Kind::Video,
    mime: "video/webm",
    ext: "webm",
    family: Family::Webm,
    said: "a WebM video",
};
const MP3: Format = Format {
    kind: Kind::Audio,
    mime: "audio/mpeg",
    ext: "mp3",
    family: Family::Mp3,
    said: "an MP3 sound",
};
const WAV: Format = Format {
    kind: Kind::Audio,
    mime: "audio/wav",
    ext: "wav",
    family: Family::Wav,
    said: "a WAV sound",
};
const OGG: Format = Format {
    kind: Kind::Audio,
    mime: "audio/ogg",
    ext: "ogg",
    family: Family::Ogg,
    said: "an OGG sound",
};

/// Every format a snapshot can be, by the extension it is written with.
const FORMATS: [Format; 11] = [PNG, JPEG, GIF, WEBP, MP4, MOV, M4A, WEBM, MP3, WAV, OGG];

/// What `head` is, by its bytes alone. `named` is the source's extension,
/// which only picks among the three readings of one ISO container.
fn sniff(head: &[u8], named: Option<&str>) -> Option<Format> {
    let at = |range: std::ops::Range<usize>| head.get(range).unwrap_or_default();
    if at(0..8) == b"\x89PNG\r\n\x1a\n" {
        return Some(PNG);
    }
    if at(0..3) == b"\xff\xd8\xff" {
        return Some(JPEG);
    }
    if at(0..6) == b"GIF87a" || at(0..6) == b"GIF89a" {
        return Some(GIF);
    }
    if at(0..4) == b"RIFF" && at(8..12) == b"WEBP" {
        return Some(WEBP);
    }
    if at(0..4) == b"RIFF" && at(8..12) == b"WAVE" {
        return Some(WAV);
    }
    if at(0..4) == b"OggS" {
        return Some(OGG);
    }
    if at(4..8) == b"ftyp" {
        // The brand says which, where it says anything; a general brand
        // (`isom`, `mp42`) is read by the name it was given.
        return Some(match at(8..12) {
            b"qt  " => MOV,
            b"M4A " | b"M4B " | b"M4P " => M4A,
            _ => match named {
                Some("m4a") => M4A,
                Some("mov" | "qt") => MOV,
                _ => MP4,
            },
        });
    }
    if at(0..4) == b"\x1a\x45\xdf\xa3" {
        // Matroska too begins so; only its WebM profile is played here.
        return head.windows(4).any(|w| w == b"webm").then_some(WEBM);
    }
    if at(0..3) == b"ID3" {
        return Some(MP3);
    }
    // An MPEG audio frame: eleven set bits, and a layer (00 is AAC's ADTS).
    if head.len() >= 2 && head[0] == 0xff && head[1] & 0xe0 == 0xe0 && head[1] & 0x06 != 0 {
        return Some(MP3);
    }
    None
}

/// The container a name's extension promises, when it names one of ours.
fn promised(ext: &str) -> Option<Family> {
    Some(match ext {
        "png" => Family::Png,
        "jpg" | "jpeg" => Family::Jpeg,
        "gif" => Family::Gif,
        "webp" => Family::Webp,
        "mp4" | "m4v" | "mov" | "qt" | "m4a" => Family::Iso,
        "webm" => Family::Webm,
        "mp3" => Family::Mp3,
        "wav" => Family::Wav,
        "ogg" | "oga" | "opus" => Family::Ogg,
        _ => return None,
    })
}

fn extension(name: &str) -> Option<String> {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
}

/// What `head` is, or why it cannot be shown where it is asked to be.
fn decide(name: &str, head: &[u8], purpose: Purpose) -> Result<Format, String> {
    let ext = extension(name);
    let format = sniff(head, ext.as_deref())
        .ok_or_else(|| format!("{name} is not a file ask_user can show: use {KINDS}."))?;
    if let Some(ext) = ext.as_deref() {
        if promised(ext).is_some_and(|family| family != format.family) {
            return Err(format!(
                "{name} is named .{ext} but holds {}. Name it for what it is.",
                format.said
            ));
        }
    }
    if purpose == Purpose::Option && format.kind != Kind::Image {
        return Err(format!(
            "{name} is {}: an option shows an image only. Put it under the question instead.",
            format.kind.word()
        ));
    }
    Ok(format)
}

fn megabytes(bytes: u64) -> String {
    let mb = bytes as f64 / (1024.0 * 1024.0);
    if mb >= 10.0 {
        format!("{mb:.0} MB")
    } else {
        format!("{mb:.1} MB")
    }
}

fn too_big(name: &str, bytes: u64, kind: Kind) -> String {
    format!(
        "{name} is {}, over the {} {} may be.",
        megabytes(bytes),
        megabytes(kind.cap()),
        kind.word()
    )
}

/// A source file's name as the person is shown it: one plain name.
fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 255
        || name.contains(['/', '\\'])
        || name.chars().any(char::is_control)
        || name == "."
        || name == ".."
    {
        return Err(format!(
            "{name:?} is not a file name: send the source file's own name."
        ));
    }
    Ok(name.to_string())
}

fn clean_caption(name: &str, caption: Option<&str>) -> Result<Option<String>, String> {
    let Some(caption) = caption.map(str::trim).filter(|c| !c.is_empty()) else {
        return Ok(None);
    };
    let count = caption.chars().count();
    if count > CAPTION_MAX {
        return Err(format!(
            "The caption of {name} is {count} characters; at most {CAPTION_MAX}."
        ));
    }
    if caption.chars().any(|c| c.is_control()) {
        return Err(format!("The caption of {name} must be one line of text."));
    }
    Ok(Some(caption.to_string()))
}

/// The chat id in `chat:<id>`, when it can name a folder.
fn chat_id(chat_key: &str) -> Result<&str, String> {
    chat_key
        .strip_prefix("chat:")
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 160
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
        .ok_or_else(|| "Media can be shown only in an OctiqFlow conversation.".to_string())
}

/// Where a chat's snapshots are, from the profile folder fixed at startup.
/// Nothing is made.
fn folder_in(profile: &Path, chat_key: &str) -> Result<PathBuf, String> {
    Ok(profile.join("chats").join(FOLDER).join(chat_id(chat_key)?))
}

/// The chat's folder is its own, not a link to somewhere else.
fn not_redirected(profile: &Path, dir: &Path) -> Result<(), String> {
    let expected = profile
        .canonical()
        .map_err(|e| e.to_string())?
        .join(dir.strip_prefix(profile).map_err(|e| e.to_string())?);
    if dir.canonical().map_err(|e| e.to_string())? != expected {
        return Err("The question media folder must not be a link.".into());
    }
    Ok(())
}

/// One file's bytes on their way to a snapshot.
///
/// Nothing is made until the first bytes say what the file is; the snapshot
/// is then created under a new name (`create_new`) and filled. One that does
/// not finish whole is removed.
pub struct Upload {
    chat_key: String,
    name: String,
    declared: u64,
    purpose: Purpose,
    head: Vec<u8>,
    open: Option<Open>,
    written: u64,
}

struct Open {
    file: File,
    path: PathBuf,
    id: String,
    format: Format,
    done: bool,
}

impl Drop for Open {
    fn drop(&mut self) {
        if !self.done {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

impl Upload {
    /// Ready to take `declared` bytes of the file called `name`.
    pub fn begin(
        chat_key: &str,
        name: &str,
        declared: u64,
        purpose: Purpose,
    ) -> Result<Self, String> {
        chat_id(chat_key)?;
        let name = clean_name(name)?;
        if declared == 0 {
            return Err(format!("{name} is empty."));
        }
        if declared > purpose.cap() {
            let kind = match purpose {
                Purpose::Option => Kind::Image,
                Purpose::Question => Kind::Video,
            };
            return Err(too_big(&name, declared, kind));
        }
        Ok(Self {
            chat_key: chat_key.to_string(),
            name,
            declared,
            purpose,
            head: Vec::with_capacity(SNIFF_LEN),
            open: None,
            written: 0,
        })
    }

    /// The next bytes of the file.
    pub fn write(&mut self, mut chunk: &[u8]) -> Result<(), String> {
        if self.open.is_none() {
            let take = (SNIFF_LEN - self.head.len()).min(chunk.len());
            self.head.extend_from_slice(&chunk[..take]);
            chunk = &chunk[take..];
            if self.head.len() < SNIFF_LEN {
                return Ok(());
            }
            self.start()?;
        }
        if chunk.is_empty() {
            return Ok(());
        }
        self.put(chunk)
    }

    /// The whole file is here: the snapshot, as the page is sent it.
    pub fn finish(mut self) -> Result<Media, String> {
        if self.open.is_none() {
            if self.head.is_empty() {
                return Err(format!("{} is empty.", self.name));
            }
            self.start()?;
        }
        if self.written != self.declared {
            return Err(format!(
                "{} changed while it was read: {} bytes were expected and {} arrived. Ask again once it is written.",
                self.name, self.declared, self.written
            ));
        }
        let open = self.open.as_mut().expect("started above");
        open.file
            .sync_all()
            .map_err(|e| crate::profile::write_error(&open.path, e))?;
        crate::profile::available()?;
        UNCLAIMED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert((self.chat_key.clone(), open.id.clone()), open.path.clone());
        open.done = true;
        Ok(Media {
            id: open.id.clone(),
            kind: open.format.kind,
            mime: open.format.mime.to_string(),
            path: open.path.to_string_lossy().into_owned(),
            name: self.name.clone(),
            caption: None,
            bytes: self.written,
        })
    }

    /// The first bytes have said what the file is: make its snapshot.
    fn start(&mut self) -> Result<(), String> {
        let format = decide(&self.name, &self.head, self.purpose)?;
        if self.declared > format.kind.cap() {
            return Err(too_big(&self.name, self.declared, format.kind));
        }
        let profile = crate::profile::available()?;
        let dir = folder_in(&profile, &self.chat_key)?;
        crate::profile::make_dir(&dir)?;
        not_redirected(&profile, &dir)?;
        let id = uuid::Uuid::new_v4().simple().to_string();
        let path = dir.join(format!("{id}.{}", format.ext));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let file = options
            .open(&path)
            .map_err(|e| crate::profile::write_error(&path, e))?;
        self.open = Some(Open {
            file,
            path,
            id,
            format,
            done: false,
        });
        let head = std::mem::take(&mut self.head);
        self.put(&head)
    }

    fn put(&mut self, chunk: &[u8]) -> Result<(), String> {
        let open = self.open.as_mut().expect("started");
        let after = self.written + chunk.len() as u64;
        if after > self.declared {
            return Err(format!(
                "{} grew while it was read: more than its {} bytes arrived.",
                self.name, self.declared
            ));
        }
        if after > open.format.kind.cap() {
            return Err(too_big(&self.name, after, open.format.kind));
        }
        open.file
            .write_all(chunk)
            .map_err(|e| crate::profile::write_error(&open.path, e))?;
        self.written = after;
        Ok(())
    }
}

/// Take one upload's body, a chunk at a time, into its snapshot.
pub async fn receive(upload: Upload, body: axum::body::Body) -> Result<Media, String> {
    use futures_util::StreamExt;
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<axum::body::Bytes, ()>>(8);
    let writer = tokio::task::spawn_blocking(move || {
        let mut upload = upload;
        while let Some(chunk) = rx.blocking_recv() {
            match chunk {
                Ok(bytes) => upload.write(&bytes)?,
                Err(()) => return Err(format!("{} was cut off on its way.", upload.name)),
            }
        }
        upload.finish()
    });
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ());
        let broken = chunk.is_err();
        // A writer that refused has dropped its end, and says why below.
        if tx.send(chunk).await.is_err() || broken {
            break;
        }
    }
    drop(tx);
    writer.await.map_err(|e| e.to_string())?
}

/// Keep rollback out until the question (or worker gate) is stored. Merely
/// validating a call does not adopt its uploads; a failed delivery can discard
/// them. Drop without `adopt` leaves them unclaimed.
#[derive(Debug)]
pub struct Resolved {
    pending: MutexGuard<'static, BTreeMap<(String, String), PathBuf>>,
    keys: Vec<(String, String)>,
}

impl Resolved {
    pub fn adopt(mut self) {
        for key in &self.keys {
            self.pending.remove(key);
        }
    }
}

/// Rebuild every media entry from the chat's own snapshots. Hold the returned
/// guard through storage, then adopt; drop it after a validation-only pass.
pub fn resolve(chat_key: &str, questions: &mut [Question]) -> Result<Resolved, String> {
    let pending = UNCLAIMED.lock().unwrap_or_else(|e| e.into_inner());
    let mut resolved = Resolved {
        pending,
        keys: Vec::new(),
    };
    let shows = |q: &Question| !q.media.is_empty() || q.options.iter().any(|c| c.image.is_some());
    if !questions.iter().any(shows) {
        return Ok(resolved);
    }
    let profile = crate::profile::available()?;
    let dir = folder_in(&profile, chat_key)?;
    let mut total = 0u64;
    for question in questions.iter_mut() {
        if question.media.len() > MAX_PER_QUESTION {
            return Err(format!(
                "The question {:?} has {} media files; at most {MAX_PER_QUESTION} can be shown under one question.",
                question.question,
                question.media.len()
            ));
        }
        for media in &mut question.media {
            *media = settle(&profile, &dir, media, Purpose::Question)?;
            total += media.bytes;
        }
        for choice in &mut question.options {
            if let Some(image) = &choice.image {
                let image = settle(&profile, &dir, image, Purpose::Option)?;
                total += image.bytes;
                choice.image = Some(image);
            }
        }
    }
    if total > CALL_MAX {
        return Err(format!(
            "The files of this call come to {}, over the {} one ask_user call can show.",
            megabytes(total),
            megabytes(CALL_MAX)
        ));
    }
    // Asked after the reads too: a folder that went, or was swapped, while
    // they ran is caught.
    crate::profile::available()?;
    for question in questions {
        for media in question
            .media
            .iter()
            .chain(question.options.iter().filter_map(|o| o.image.as_ref()))
        {
            resolved.keys.push((chat_key.to_owned(), media.id.clone()));
        }
    }
    Ok(resolved)
}

/// One entry, as the host's own snapshot says it is.
fn settle(profile: &Path, dir: &Path, given: &Media, purpose: Purpose) -> Result<Media, String> {
    let shown = if given.name.trim().is_empty() {
        given.path.clone()
    } else {
        given.name.clone()
    };
    let id = given.id.as_str();
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!(
            "{shown} was not attached through ask_user, so it cannot be shown. Pass its absolute path as media or as an option's image."
        ));
    }
    let missing =
        || format!("{shown} is not among this conversation's question media: attach it again.");
    if !dir.is_dir() {
        return Err(missing());
    }
    not_redirected(profile, dir)?;
    let (path, meta) = FORMATS
        .iter()
        .map(|f| dir.join(format!("{id}.{}", f.ext)))
        .find_map(|path| std::fs::symlink_metadata(&path).ok().map(|m| (path, m)))
        .ok_or_else(missing)?;
    if !meta.is_file() || meta.len() == 0 {
        return Err(missing());
    }
    let mut head = Vec::with_capacity(SNIFF_LEN);
    File::open(&path)
        .and_then(|f| f.take(SNIFF_LEN as u64).read_to_end(&mut head))
        .map_err(|e| format!("{shown} could not be read back: {e}"))?;
    let ext = extension(&path.to_string_lossy()).unwrap_or_default();
    let name = clean_name(if given.name.trim().is_empty() {
        path.file_name().and_then(|n| n.to_str()).unwrap_or(id)
    } else {
        &given.name
    })?;
    let format = sniff(&head, Some(&ext))
        .filter(|f| f.ext == ext)
        .ok_or_else(missing)?;
    if purpose == Purpose::Option && format.kind != Kind::Image {
        return Err(format!(
            "{name} is {}: an option shows an image only. Put it under the question instead.",
            format.kind.word()
        ));
    }
    if meta.len() > format.kind.cap() {
        return Err(too_big(&name, meta.len(), format.kind));
    }
    Ok(Media {
        id: id.to_string(),
        kind: format.kind,
        mime: format.mime.to_string(),
        path: path.to_string_lossy().into_owned(),
        caption: clean_caption(&name, given.caption.as_deref())?,
        name,
        bytes: meta.len(),
    })
}

/// Remove a chat's snapshots, when the chat itself is purged. Never on
/// `/clear` and never on the move to the trash.
pub fn forget(chat_id: &str) {
    UNCLAIMED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|(key, _), _| key != &format!("chat:{chat_id}"));
    let Ok(profile) = crate::profile::available() else {
        return;
    };
    let Ok(dir) = folder_in(&profile, &format!("chat:{chat_id}")) else {
        return;
    };
    match ancestry_is_real(&profile, &dir) {
        Ok(true) => {}
        Ok(false) => return,
        Err(why) => {
            eprintln!(
                "[question-media] kept {} for chat {chat_id}: {why}",
                dir.display()
            );
            return;
        }
    }
    // The folder itself, never what a link in its place leads to.
    match std::fs::symlink_metadata(&dir) {
        Ok(meta) if meta.is_dir() => {
            let _ = std::fs::remove_dir_all(&dir);
        }
        // A link or a junction: the link goes, never what it leads to.
        Ok(_) => {
            let _ = std::fs::remove_file(&dir).or_else(|_| std::fs::remove_dir(&dir));
        }
        Err(_) => {}
    }
}

/// Every folder from the profile's `chats` down to the chat's own parent is
/// a folder in the profile, not a link or a junction to somewhere else.
/// `false` when a part is not there: nothing to remove.
fn ancestry_is_real(profile: &Path, dir: &Path) -> Result<bool, String> {
    let parent = dir.parent().ok_or("no parent folder")?;
    let below = parent.strip_prefix(profile).map_err(|e| e.to_string())?;
    let mut at = profile.to_path_buf();
    for part in below.components() {
        at.push(part);
        let meta = match std::fs::symlink_metadata(&at) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(format!("{}: {e}", at.display())),
        };
        // `is_symlink` is true of a Windows junction too.
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(format!(
                "{} is not a folder of the profile's own (a link, a junction or a file), so nothing under it was removed",
                at.display()
            ));
        }
    }
    not_redirected(profile, parent).map(|()| true)
}

#[cfg(test)]
#[path = "question_media_tests.rs"]
mod tests;
