//! ask_user media, the host's half: what a file is by its bytes, the caps,
//! the immutable snapshot, and the call rebuilt from the chat's own
//! snapshots before anything is asked.
use super::*;
use crate::profile::tests::{everything_in, Home};
use crate::question::{Choice, Question};

const PNG_HEAD: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
const JPEG_HEAD: &[u8] = b"\xff\xd8\xff\xe0\0\x10JFIF\0";

fn png() -> Vec<u8> {
    [PNG_HEAD, &[7u8; 200][..]].concat()
}

fn iso(brand: &[u8; 4]) -> Vec<u8> {
    [&b"\0\0\0\x18ftyp"[..], brand, &[1u8; 100][..]].concat()
}

/// A chat of its own in the shared scratch profile, its snapshots removed
/// afterwards.
struct Chat {
    id: String,
    key: String,
}

impl Chat {
    fn new() -> Self {
        let id = format!("media-{}", uuid::Uuid::new_v4().simple());
        Self {
            key: format!("chat:{id}"),
            id,
        }
    }

    fn folder(&self) -> PathBuf {
        folder_in(&crate::profile::profile_dir(), &self.key).unwrap()
    }

    fn upload(&self, name: &str, bytes: &[u8], purpose: Purpose) -> Result<Media, String> {
        let mut upload = Upload::begin(&self.key, name, bytes.len() as u64, purpose)?;
        // In pieces smaller than the sniff, so the first bytes arrive split.
        for piece in bytes.chunks(5) {
            upload.write(piece)?;
        }
        upload.finish()
    }

    fn files(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(self.folder()) else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

impl Drop for Chat {
    fn drop(&mut self) {
        forget(&self.id);
    }
}

fn asking(media: Vec<Media>, options: Vec<Choice>) -> Question {
    Question {
        chat_key: None,
        question: "Which one?".into(),
        options,
        recommended: None,
        multiple: false,
        media,
    }
}

/// What the agent's MCP sends for a snapshot: its id, a name and a caption.
fn named(id: &str, name: &str, caption: Option<&str>) -> Media {
    serde_json::from_value(serde_json::json!({ "id": id, "name": name, "caption": caption }))
        .unwrap()
}

#[test]
fn a_file_is_what_its_first_bytes_say_and_never_what_its_name_says() {
    let said = |head: &[u8], name: Option<&str>| sniff(head, name).map(|f| f.mime);
    assert_eq!(said(PNG_HEAD, None), Some("image/png"));
    assert_eq!(said(JPEG_HEAD, None), Some("image/jpeg"));
    assert_eq!(said(b"GIF89a\x01\0", None), Some("image/gif"));
    assert_eq!(said(b"GIF87a\x01\0", None), Some("image/gif"));
    assert_eq!(said(b"RIFF\0\0\0\0WEBPVP8 ", None), Some("image/webp"));
    assert_eq!(said(b"RIFF\0\0\0\0WAVEfmt ", None), Some("audio/wav"));
    assert_eq!(said(b"OggS\0\x02", None), Some("audio/ogg"));
    assert_eq!(said(b"ID3\x04\0\0", None), Some("audio/mpeg"));
    assert_eq!(said(b"\xff\xfb\x90\x64", None), Some("audio/mpeg"));
    // AAC's ADTS frame begins the same way with layer 00: not an MP3.
    assert_eq!(said(b"\xff\xf1\x50\x80", None), None);
    // One ISO container, three readings: the brand where it says, the name
    // where the brand is a general one.
    assert_eq!(said(&iso(b"isom"), None), Some("video/mp4"));
    assert_eq!(said(&iso(b"qt  "), Some("mp4")), Some("video/quicktime"));
    assert_eq!(said(&iso(b"M4A "), None), Some("audio/mp4"));
    assert_eq!(said(&iso(b"mp42"), Some("m4a")), Some("audio/mp4"));
    assert_eq!(said(&iso(b"mp42"), Some("mov")), Some("video/quicktime"));
    // Matroska is played only as WebM.
    let mut ebml = b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\x82\x84".to_vec();
    assert_eq!(
        said(&[&ebml[..], b"webm"].concat(), None),
        Some("video/webm")
    );
    ebml.extend_from_slice(b"matroska");
    assert_eq!(said(&ebml, None), None);
    // Text, a PDF, an SVG, nothing at all.
    for other in [&b"<html>"[..], b"%PDF-1.7", b"<svg xmlns", b""] {
        assert_eq!(said(other, Some("png")), None, "{other:?}");
    }
}

#[test]
fn a_name_that_promises_another_kind_of_file_is_refused_in_words() {
    assert_eq!(
        decide("shot.png", JPEG_HEAD, Purpose::Question).unwrap_err(),
        "shot.png is named .png but holds a JPEG image. Name it for what it is."
    );
    assert_eq!(
        decide("clip.mp3", &iso(b"isom"), Purpose::Question).unwrap_err(),
        "clip.mp3 is named .mp3 but holds an MP4 video. Name it for what it is."
    );
    assert_eq!(
        decide("notes.txt", b"just words, really", Purpose::Question).unwrap_err(),
        format!("notes.txt is not a file ask_user can show: use {KINDS}.")
    );
    // A name of no kind of ours says nothing either way; .jpeg is .jpg.
    assert_eq!(decide("capture", PNG_HEAD, Purpose::Question).unwrap(), PNG);
    assert_eq!(
        decide("capture.bin", PNG_HEAD, Purpose::Question).unwrap(),
        PNG
    );
    assert_eq!(
        decide("face.JPEG", JPEG_HEAD, Purpose::Option).unwrap(),
        JPEG
    );
    // An option is chosen by look: an image, never a recording.
    assert_eq!(
        decide("take.mp4", &iso(b"isom"), Purpose::Option).unwrap_err(),
        "take.mp4 is a video: an option shows an image only. Put it under the question instead."
    );
}

#[test]
fn failed_calls_discard_only_their_own_unclaimed_snapshots() {
    let chat = Chat::new();
    let other = Chat::new();
    let pending = chat.upload("one.png", &png(), Purpose::Question).unwrap();
    let claimed = chat.upload("kept.png", &png(), Purpose::Question).unwrap();
    // Preflight is validation only. A delivery that later fails must still
    // be able to discard its snapshots; only a stored call adopts them.
    resolve(&chat.key, &mut [asking(vec![pending.clone()], vec![])]).unwrap();
    resolve(&chat.key, &mut [asking(vec![claimed.clone()], vec![])])
        .unwrap()
        .adopt();
    discard(&other.key, &[pending.id.clone()]).unwrap();
    assert!(Path::new(&pending.path).exists());
    discard(
        &chat.key,
        &[pending.id.clone(), claimed.id.clone(), "../outside".into()],
    )
    .unwrap();
    assert!(!Path::new(&pending.path).exists());
    assert!(Path::new(&claimed.path).exists());
    discard(&chat.key, &[pending.id]).unwrap(); // Idempotent.
}

#[test]
fn an_upload_is_kept_under_a_new_name_every_time_and_never_written_over() {
    let chat = Chat::new();
    let first = chat.upload("home.png", &png(), Purpose::Question).unwrap();
    assert_eq!(first.kind, Kind::Image);
    assert_eq!(first.mime, "image/png");
    assert_eq!(first.name, "home.png");
    assert_eq!(first.bytes, png().len() as u64);
    assert_eq!(first.caption, None);
    assert_eq!(first.id.len(), 32);
    assert_eq!(
        PathBuf::from(&first.path),
        chat.folder().join(format!("{}.png", first.id))
    );
    assert!(chat.folder().starts_with(
        crate::profile::profile_dir()
            .join("chats")
            .join("question-media")
    ));
    assert_eq!(std::fs::read(&first.path).unwrap(), png());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&first.path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    // The same name again, other bytes: a second snapshot beside the first,
    // which still holds what it held.
    let mut next = png();
    next.extend_from_slice(b"revision");
    let second = chat.upload("home.png", &next, Purpose::Question).unwrap();
    assert_ne!(second.id, first.id);
    assert_eq!(std::fs::read(&first.path).unwrap(), png());
    assert_eq!(std::fs::read(&second.path).unwrap(), next);
    assert_eq!(chat.files().len(), 2);
    // A sound and a video are kept with the extension `/file` serves them by.
    let clip = chat
        .upload("clip", &iso(b"isom"), Purpose::Question)
        .unwrap();
    assert!(clip.path.ends_with(".mp4"), "{}", clip.path);
    assert_eq!((clip.kind, clip.mime.as_str()), (Kind::Video, "video/mp4"));
    let voice = chat
        .upload("voice.m4a", &iso(b"M4A "), Purpose::Question)
        .unwrap();
    assert!(voice.path.ends_with(".m4a"));
    assert_eq!(voice.kind, Kind::Audio);
}

#[test]
fn an_upload_that_is_refused_or_cut_short_leaves_nothing_behind() {
    let chat = Chat::new();
    // Refused on its first bytes: nothing is made at all.
    assert!(chat
        .upload("shot.png", JPEG_HEAD, Purpose::Question)
        .is_err());
    assert!(chat
        .upload("face.mp4", &iso(b"isom"), Purpose::Option)
        .unwrap_err()
        .contains("an option shows an image only"));
    assert_eq!(chat.files(), Vec::<String>::new());

    // Fewer bytes than were said: the file changed while it was read.
    let mut short = Upload::begin(&chat.key, "a.png", 500, Purpose::Question).unwrap();
    short.write(&png()).unwrap();
    assert_eq!(
        short.finish().unwrap_err(),
        format!(
            "a.png changed while it was read: 500 bytes were expected and {} arrived. Ask again once it is written.",
            png().len()
        )
    );
    // More bytes than were said.
    let mut long = Upload::begin(&chat.key, "a.png", 70, Purpose::Question).unwrap();
    assert!(long
        .write(&png())
        .unwrap_err()
        .contains("grew while it was read"));
    drop(long);
    // Begun and dropped half way, as a broken connection drops it.
    let mut dropped = Upload::begin(&chat.key, "a.png", 1000, Purpose::Question).unwrap();
    dropped.write(&png()).unwrap();
    assert_eq!(chat.files().len(), 1, "the snapshot is being written");
    drop(dropped);
    assert_eq!(chat.files(), Vec::<String>::new());

    // Empty, a name that is a path, a key that names no conversation.
    assert_eq!(
        Upload::begin(&chat.key, "a.png", 0, Purpose::Question).err(),
        Some("a.png is empty.".into())
    );
    assert!(Upload::begin(&chat.key, "../a.png", 10, Purpose::Question).is_err());
    assert!(Upload::begin(&chat.key, "a\nb.png", 10, Purpose::Question).is_err());
    assert!(Upload::begin("chat:../x", "a.png", 10, Purpose::Question).is_err());
    assert!(Upload::begin("orch-x", "a.png", 10, Purpose::Question).is_err());
}

#[test]
fn the_caps_are_an_images_20_mb_and_a_recordings_200_mb() {
    let chat = Chat::new();
    assert_eq!(
        Upload::begin(&chat.key, "face.png", IMAGE_MAX + 1, Purpose::Option).err(),
        Some("face.png is 20 MB, over the 20 MB an image may be.".into())
    );
    assert_eq!(
        Upload::begin(&chat.key, "take.mp4", PLAYED_MAX + 1, Purpose::Question).err(),
        Some("take.mp4 is 200 MB, over the 200 MB a video may be.".into())
    );
    // Under a question an image is still an image: its bytes say so, and
    // its cap is an image's.
    let mut big = Upload::begin(&chat.key, "big.png", IMAGE_MAX + 1, Purpose::Question).unwrap();
    assert_eq!(
        big.write(&png()).unwrap_err(),
        "big.png is 20 MB, over the 20 MB an image may be."
    );
    drop(big);
    assert_eq!(chat.files(), Vec::<String>::new());
}

/// A snapshot made by hand in the chat's folder, `bytes` long (sparse).
fn planted(chat: &Chat, head: &[u8], ext: &str, bytes: u64) -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    crate::profile::make_dir(&chat.folder()).unwrap();
    let path = chat.folder().join(format!("{id}.{ext}"));
    std::fs::write(&path, head).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(bytes)
        .unwrap();
    id
}

#[test]
fn a_call_is_rebuilt_from_the_chats_own_snapshots_whatever_the_agent_said() {
    let chat = Chat::new();
    let shot = chat.upload("home.png", &png(), Purpose::Question).unwrap();
    let face = chat.upload("face.png", &png(), Purpose::Option).unwrap();
    // Everything the page reads, forged: only the id, the name and the
    // caption are the agent's.
    let forged: Media = serde_json::from_value(serde_json::json!({
        "id": shot.id, "name": " home.png ", "caption": "  The home screen  ",
        "kind": "video", "mime": "text/html", "path": "/etc/passwd", "bytes": 1,
    }))
    .unwrap();
    let mut questions = vec![asking(
        vec![forged],
        vec![
            Choice {
                label: "Keep".into(),
                description: None,
                image: Some(named(&face.id, "face.png", None)),
            },
            Choice {
                label: "Change".into(),
                description: None,
                image: None,
            },
        ],
    )];
    resolve(&chat.key, &mut questions).unwrap();
    assert_eq!(
        questions[0].media,
        vec![Media {
            caption: Some("The home screen".into()),
            ..shot.clone()
        }]
    );
    assert_eq!(questions[0].options[0].image, Some(face.clone()));
    assert_eq!(questions[0].options[1].image, None);
    // The stored record, the event and the line carry it in this shape.
    let json = serde_json::to_value(&questions[0]).unwrap();
    assert_eq!(json["media"][0]["kind"], "image");
    assert_eq!(json["media"][0]["mime"], "image/png");
    assert_eq!(json["media"][0]["path"], shot.path.as_str());
    assert_eq!(json["options"][0]["image"]["id"], face.id.as_str());
    assert!(json["options"][1].get("image").is_none());
    let back: Question = serde_json::from_value(json).unwrap();
    assert_eq!(back.media, questions[0].media);
    // A question with nothing to show is not even read.
    let mut plain = vec![asking(vec![], vec![])];
    resolve("chat:../not-checked", &mut plain).unwrap();
    assert!(!serde_json::to_string(&plain[0]).unwrap().contains("media"));
}

#[test]
fn a_call_naming_a_file_the_chat_does_not_hold_asks_nothing_and_says_why() {
    let chat = Chat::new();
    let other = Chat::new();
    let theirs = other
        .upload("theirs.png", &png(), Purpose::Question)
        .unwrap();
    let mine = chat.upload("mine.png", &png(), Purpose::Question).unwrap();
    let refused = |media: Vec<Media>, options: Vec<Choice>| {
        let mut questions = vec![asking(media, options)];
        resolve(&chat.key, &mut questions).unwrap_err()
    };
    // Another chat's snapshot is not this chat's to show.
    assert_eq!(
        refused(vec![named(&theirs.id, "theirs.png", None)], vec![]),
        "theirs.png is not among this conversation's question media: attach it again."
    );
    // A path sent as it was, never uploaded: refused, not dropped.
    let bare: Media = serde_json::from_value(serde_json::json!("/Users/x/shot.png")).unwrap();
    assert_eq!(
        refused(vec![bare], vec![]),
        "/Users/x/shot.png was not attached through ask_user, so it cannot be shown. Pass its absolute path as media or as an option's image."
    );
    assert!(refused(vec![named("../../etc/passwd", "x", None)], vec![])
        .contains("was not attached through ask_user"));
    // More than four under one question.
    let five = (0..5).map(|_| named(&mine.id, "mine.png", None)).collect();
    assert_eq!(
        refused(five, vec![]),
        "The question \"Which one?\" has 5 media files; at most 4 can be shown under one question."
    );
    // A caption past 160 characters.
    assert_eq!(
        refused(
            vec![named(&mine.id, "mine.png", Some("é".repeat(161).as_str()))],
            vec![]
        ),
        "The caption of mine.png is 161 characters; at most 160."
    );
    // A video kept for the question cannot be an option's image.
    let clip = chat
        .upload("clip.mp4", &iso(b"isom"), Purpose::Question)
        .unwrap();
    let option = Choice {
        label: "A".into(),
        description: None,
        image: Some(named(&clip.id, "clip.mp4", None)),
    };
    assert_eq!(
        refused(vec![], vec![option]),
        "clip.mp4 is a video: an option shows an image only. Put it under the question instead."
    );
    // 300 MB in all, however the files are spread over the questions.
    let a = planted(&chat, &iso(b"isom"), "mp4", 160 * 1024 * 1024);
    let b = planted(&chat, &iso(b"isom"), "mp4", 160 * 1024 * 1024);
    let mut two = vec![
        asking(vec![named(&a, "a.mp4", None)], vec![]),
        asking(vec![named(&b, "b.mp4", None)], vec![]),
    ];
    assert_eq!(
        resolve(&chat.key, &mut two).unwrap_err(),
        "The files of this call come to 320 MB, over the 300 MB one ask_user call can show."
    );
    // A file put in the folder whose bytes are not what its name says.
    let liar = planted(&chat, JPEG_HEAD, "png", 64);
    assert!(refused(vec![named(&liar, "liar.png", None)], vec![])
        .contains("is not among this conversation's question media"));
}

#[cfg(unix)]
#[test]
fn a_folder_that_is_a_link_is_neither_written_into_nor_read() {
    let chat = Chat::new();
    let elsewhere = crate::test_dir::TestDir::new("media-elsewhere");
    let parent = chat.folder().parent().unwrap().to_path_buf();
    crate::profile::make_dir(&parent).unwrap();
    std::os::unix::fs::symlink(&*elsewhere, chat.folder()).unwrap();
    assert_eq!(
        chat.upload("a.png", &png(), Purpose::Question).unwrap_err(),
        "The question media folder must not be a link."
    );
    std::fs::write(
        elsewhere.join("0123456789abcdef0123456789abcdef.png"),
        png(),
    )
    .unwrap();
    let mut questions = vec![asking(
        vec![named("0123456789abcdef0123456789abcdef", "a.png", None)],
        vec![],
    )];
    assert_eq!(
        resolve(&chat.key, &mut questions).unwrap_err(),
        "The question media folder must not be a link."
    );
    assert_eq!(
        everything_in(&elsewhere).len(),
        1,
        "nothing was written there"
    );
    // Purging removes the link and never what it leads to.
    forget(&chat.id);
    assert!(std::fs::symlink_metadata(chat.folder()).is_err());
    assert_eq!(everything_in(&elsewhere).len(), 1);
}

#[test]
fn purging_a_chat_removes_its_snapshots_and_nobody_elses() {
    let chat = Chat::new();
    let other = Chat::new();
    chat.upload("a.png", &png(), Purpose::Question).unwrap();
    let kept = other.upload("b.png", &png(), Purpose::Question).unwrap();
    forget(&chat.id);
    assert!(!chat.folder().exists());
    assert!(PathBuf::from(&kept.path).is_file());
    // Twice, and for a chat that never showed anything: nothing to do.
    forget(&chat.id);
    forget("never-asked");
    forget("../escape");
}

/// A profile of this thread's own, which the test then takes away.
struct World {
    _process: crate::profile::Started,
    home: Home,
}

impl World {
    fn new() -> Self {
        let home = Home::with_a_configured_base();
        let process = crate::profile::started_in(&home.dir);
        Self {
            _process: process,
            home,
        }
    }
}

/// Review of 0b767b3: with `<chats>/question-media` a link, purging a chat
/// removed `<where it led>/<chat id>`, outside the profile. A link anywhere
/// from `chats` down keeps everything, there and here.
#[cfg(unix)]
#[test]
fn purging_never_follows_a_folder_above_the_chats_that_is_a_link() {
    for linked in ["chats", "chats/question-media"] {
        let _world = World::new();
        let chat = Chat::new();
        let kept = chat.upload("a.png", &png(), Purpose::Question).unwrap();
        let profile = crate::profile::profile_dir();
        let elsewhere = crate::test_dir::TestDir::new("media-redirected");
        let moved = elsewhere.join("moved");
        std::fs::rename(profile.join(linked), &moved).unwrap();
        std::os::unix::fs::symlink(&moved, profile.join(linked)).unwrap();
        let outside = everything_in(&elsewhere);
        assert!(
            outside.iter().any(|(path, _)| path.ends_with(".png")),
            "{linked}: the snapshot is out there now"
        );

        forget(&chat.id);
        assert_eq!(
            everything_in(&elsewhere),
            outside,
            "{linked}: nothing removed"
        );
        assert!(
            chat.folder()
                .join(PathBuf::from(&kept.path).file_name().unwrap())
                .is_file(),
            "{linked}"
        );
        // Upload and resolve refuse the same ancestry.
        assert_eq!(
            chat.upload("b.png", &png(), Purpose::Question).unwrap_err(),
            "The question media folder must not be a link.",
            "{linked}"
        );
        let mut questions = vec![asking(vec![named(&kept.id, "a.png", None)], vec![])];
        assert_eq!(
            resolve(&chat.key, &mut questions).unwrap_err(),
            "The question media folder must not be a link.",
            "{linked}"
        );

        // Put back, the same purge removes the chat's folder.
        std::fs::remove_file(profile.join(linked)).unwrap();
        std::fs::rename(&moved, profile.join(linked)).unwrap();
        forget(&chat.id);
        assert!(
            std::fs::symlink_metadata(chat.folder()).is_err(),
            "{linked}"
        );
    }
}

#[test]
fn a_profile_folder_that_is_gone_or_replaced_gets_no_snapshot_and_shows_none() {
    for how in ["moved", "replaced", "unplugged"] {
        let world = World::new();
        let chat = Chat::new();
        let kept = chat.upload("a.png", &png(), Purpose::Question).unwrap();
        // Begun before the folder went: its first bytes find it gone.
        let mut begun =
            Upload::begin(&chat.key, "b.png", png().len() as u64, Purpose::Question).unwrap();
        match how {
            "moved" => world.home.move_away(),
            "replaced" => world.home.replace(),
            _ => world.home.unplug(),
        }
        let why = crate::profile::available().expect_err("the folder is away");
        let before = everything_in(&world.home.dir);
        assert_eq!(begun.write(&png()).unwrap_err(), why, "{how}");
        assert_eq!(
            chat.upload("c.png", &png(), Purpose::Question).unwrap_err(),
            why,
            "{how}"
        );
        let mut questions = vec![asking(vec![named(&kept.id, "a.png", None)], vec![])];
        assert_eq!(
            resolve(&chat.key, &mut questions).unwrap_err(),
            why,
            "{how}"
        );
        // Purging with the folder away removes nothing anywhere.
        forget(&chat.id);
        drop(begun);
        assert_eq!(
            everything_in(&world.home.dir),
            before,
            "{how}: nothing was made or removed"
        );
        match how {
            "unplugged" => world.home.plug_back(),
            _ => world.home.move_back(),
        }
        // Back: the snapshot made before is there and shown as it was.
        let mut questions = vec![asking(vec![named(&kept.id, "a.png", None)], vec![])];
        resolve(&chat.key, &mut questions).unwrap();
        assert_eq!(questions[0].media[0].path, kept.path, "{how}");
    }
}
