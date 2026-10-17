//! What a long-running job says of its own progress, read from its output
//! (`docs/jobs.md`).
//!
//! Pure: no clock, no process, no file. `octiq-job` (`job_wrapper.rs`) feeds
//! it the bytes its child writes, and the host (`chat_jobs.rs`) the lines of
//! a registered job's log and the text of its progress file.
//!
//! **Nothing here estimates.** A `Progress` carries `done` and `total` only
//! when the job printed both: ffmpeg's `time=` against the `Duration:` of its
//! own header (no duration, no figure), cargo's `Building [..] N/M`,
//! Remotion's `Rendered N/M` and `Encoded N/M`, a bare `N/M`, an `NN%`, or a
//! progress file that names both. Never from a rate, an elapsed time or a
//! guess at what is left.
//!
//! The parsers are tested on output recorded from the real programs
//! (`job_progress/fixtures`, see its README). Re-record them; never hand-edit.

use serde::{Deserialize, Serialize};

/// What `done` and `total` count. The page's words for them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    Frames,
    Seconds,
    Items,
    Percent,
    Crates,
}

/// One reading of a job's progress. Every field is the job's own word.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<Unit>,
}

impl Progress {
    fn counted(phase: Option<&str>, done: f64, total: f64, unit: Unit) -> Option<Self> {
        (done.is_finite() && total.is_finite() && total > 0.0 && done >= 0.0 && done <= total).then(
            || Self {
                phase: phase.map(str::to_string),
                done: Some(done),
                total: Some(total),
                unit: Some(unit),
            },
        )
    }
}

/// How to read a job's output. `Auto` tries the known formats and keeps to
/// the first that recognises a line.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Format {
    #[default]
    Auto,
    Ffmpeg,
    Cargo,
    Remotion,
    Nm,
    Percent,
}

impl Format {
    pub const NAMES: &'static str = "auto, ffmpeg, cargo, remotion, nm, percent";

    pub fn parse(name: &str) -> Result<Self, String> {
        Ok(match name.trim().to_ascii_lowercase().as_str() {
            "" | "auto" => Self::Auto,
            "ffmpeg" => Self::Ffmpeg,
            "cargo" => Self::Cargo,
            "remotion" => Self::Remotion,
            "nm" | "n/m" => Self::Nm,
            "percent" | "%" => Self::Percent,
            other => {
                return Err(format!(
                    "unknown progress format '{other}': use one of {}",
                    Self::NAMES
                ))
            }
        })
    }
}

/// Reads a job's output one segment at a time (a line, or a piece of one a
/// `\r` rewrote), remembering what a format needs across lines: ffmpeg's
/// duration, and which format `Auto` settled on.
#[derive(Debug, Default)]
pub struct Parser {
    format: Format,
    /// The format `Auto` recognised first. It keeps to it, so the
    /// percentages in ffmpeg's closing statistics are never read as progress.
    settled: Option<Format>,
    /// The first input's `Duration:` from ffmpeg's own header.
    duration: Option<f64>,
}

impl Parser {
    pub fn new(format: Format) -> Self {
        Self {
            format,
            ..Self::default()
        }
    }

    /// The progress this segment states, if it states one. ANSI escapes are
    /// ignored.
    pub fn line(&mut self, raw: &str) -> Option<Progress> {
        let text = strip_ansi(raw);
        let line = text.trim();
        if line.is_empty() {
            return None;
        }
        let format = self.settled.unwrap_or(self.format);
        match format {
            Format::Ffmpeg => self.ffmpeg(line),
            Format::Cargo => cargo(line),
            Format::Remotion => remotion(line),
            Format::Nm => nm(line),
            Format::Percent => percent(line),
            Format::Auto => {
                // ffmpeg is known by its header before it says anything of
                // progress; from then on its lines are read as ffmpeg's.
                if line.starts_with("ffmpeg version ") || ffmpeg_duration(line).is_some() {
                    self.settled = Some(Format::Ffmpeg);
                    return self.ffmpeg(line);
                }
                for (format, read) in [
                    (Format::Cargo, cargo as fn(&str) -> Option<Progress>),
                    (Format::Remotion, remotion),
                    (Format::Nm, nm),
                    (Format::Percent, percent),
                ] {
                    if let Some(progress) = read(line) {
                        self.settled = Some(format);
                        return Some(progress);
                    }
                }
                None
            }
        }
    }

    fn ffmpeg(&mut self, line: &str) -> Option<Progress> {
        if let Some(duration) = ffmpeg_duration(line) {
            // The first input's: a second input's header comes later.
            if self.duration.is_none() {
                self.duration = duration;
            }
            return None;
        }
        let total = self.duration?;
        let time = ffmpeg_time(line)?;
        Progress::counted(None, time.min(total), total, Unit::Seconds)
    }
}

/// `Duration: 00:00:08.00, …` → `Some(Some(8.0))`; `Duration: N/A` →
/// `Some(None)`; any other line → `None`.
fn ffmpeg_duration(line: &str) -> Option<Option<f64>> {
    let rest = line.strip_prefix("Duration:")?.trim_start();
    let value = rest.split([',', ' ']).next().unwrap_or_default();
    Some(clock(value).filter(|seconds| *seconds > 0.0))
}

/// The `time=` of a stats line, or `out_time=` of `-progress` output.
fn ffmpeg_time(line: &str) -> Option<f64> {
    let at = line.find("time=")?;
    // `out_time=` is the same reading; `out_time_us=` and `out_time_ms=` do
    // not contain `time=`.
    let value = line[at + "time=".len()..].split_whitespace().next()?;
    clock(value)
}

/// `HH:MM:SS(.frac)` → seconds. `N/A` and a negative time are not a time.
fn clock(value: &str) -> Option<f64> {
    let mut parts = value.split(':');
    let (h, m, s) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || h.starts_with('-') {
        return None;
    }
    let h: f64 = h.parse().ok()?;
    let m: f64 = m.parse().ok()?;
    let s: f64 = s.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

/// cargo's bar: `Building [=====>   ] 120/290: serde, tokio`. Cargo draws it
/// only on a terminal, or with `CARGO_TERM_PROGRESS_WHEN=always`, which
/// `octiq-job` sets for a cargo child that has not set it.
fn cargo(line: &str) -> Option<Progress> {
    let rest = line.strip_prefix("Building [")?;
    let (_, after) = rest.split_once(']')?;
    let count = after.trim_start().split(':').next()?.trim();
    let (done, total) = fraction(count)?;
    Progress::counted(Some("Building"), done, total, Unit::Crates)
}

/// Remotion's CLI with its output piped: `Bundling 65%`, `Rendered 66/90,
/// time remaining: 4s`, `Encoded 28/90`.
fn remotion(line: &str) -> Option<Progress> {
    for (word, phase) in [
        ("Rendered ", "Rendering"),
        ("Encoded ", "Encoding"),
        ("Stitched ", "Encoding"),
    ] {
        if let Some(rest) = line.strip_prefix(word) {
            let count = rest.split([',', ' ']).next()?;
            let (done, total) = fraction(count)?;
            return Progress::counted(Some(phase), done, total, Unit::Frames);
        }
    }
    let rest = line.strip_prefix("Bundling ")?;
    let value = rest.trim().strip_suffix('%')?.parse::<f64>().ok()?;
    Progress::counted(Some("Bundling"), value, 100.0, Unit::Percent)
}

/// `N/M` written whole, as a count: `3/8`, `[2/5]`, `item 4 / 10`. Not a
/// date (`10/17/2026`), a path or a rate (`kbits/s`).
fn nm(line: &str) -> Option<Progress> {
    let chars: Vec<char> = line.chars().collect();
    let digit = |i: usize| chars.get(i).is_some_and(|c| c.is_ascii_digit());
    for slash in (0..chars.len()).filter(|&i| chars[i] == '/') {
        // The digits before the slash, with spaces between allowed.
        let mut b = slash;
        while b > 0 && chars[b - 1] == ' ' {
            b -= 1;
        }
        let mut a = b;
        while a > 0 && digit(a - 1) {
            a -= 1;
        }
        // And after it.
        let mut c = slash + 1;
        while chars.get(c) == Some(&' ') {
            c += 1;
        }
        let mut d = c;
        while digit(d) {
            d += 1;
        }
        if a == b || c == d {
            continue;
        }
        let before = a.checked_sub(1).map(|i| chars[i]);
        if before.is_some_and(|c| c.is_alphanumeric() || "/.,-".contains(c)) {
            continue;
        }
        let after = chars.get(d).copied();
        let number_goes_on = matches!(after, Some('.' | ',')) && digit(d + 1);
        if after.is_some_and(|c| c.is_alphanumeric() || c == '/') || number_goes_on {
            continue;
        }
        let done: String = chars[a..b].iter().collect();
        let total: String = chars[c..d].iter().collect();
        let (Ok(done), Ok(total)) = (done.parse::<f64>(), total.parse::<f64>()) else {
            continue;
        };
        if let Some(progress) = Progress::counted(None, done, total, Unit::Items) {
            return Some(progress);
        }
    }
    None
}

/// The last `NN%` or `NN.N%` of a line, 0 to 100.
fn percent(line: &str) -> Option<Progress> {
    let mut found = None;
    for (at, _) in line.match_indices('%') {
        let head = line[..at].trim_end();
        let start = head
            .rfind(|c: char| !(c.is_ascii_digit() || c == '.'))
            .map_or(0, |i| i + 1);
        let number = &head[start..];
        if number.is_empty() || number.starts_with('.') {
            continue;
        }
        if head[..start]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_alphanumeric())
        {
            continue;
        }
        if let Ok(value) = number.parse::<f64>() {
            if let Some(progress) = Progress::counted(None, value, 100.0, Unit::Percent) {
                found = Some(progress);
            }
        }
    }
    found
}

/// `12/34` → `(12, 34)`.
fn fraction(text: &str) -> Option<(f64, f64)> {
    let (done, total) = text.trim().split_once('/')?;
    let whole = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !whole(done) || !whole(total) {
        return None;
    }
    Some((done.parse().ok()?, total.parse().ok()?))
}

/// A progress file, `{"done":3,"total":8,"phase":"Generating"}`, rewritten
/// whole by the job. `unit` may name one of the page's units; the default is
/// items. A file caught half-written, or that does not give both counts, says
/// nothing.
pub fn progress_file(text: &str) -> Option<Progress> {
    #[derive(Deserialize)]
    struct File {
        done: f64,
        total: f64,
        #[serde(default)]
        phase: Option<String>,
        #[serde(default)]
        unit: Option<Unit>,
    }
    let file: File = serde_json::from_str(text.trim()).ok()?;
    let phase = file
        .phase
        .map(|phase| {
            phase
                .chars()
                .filter(|c| !c.is_control())
                .take(80)
                .collect::<String>()
        })
        .filter(|phase| !phase.trim().is_empty());
    Progress::counted(
        phase.as_deref(),
        file.done,
        file.total,
        file.unit.unwrap_or(Unit::Items),
    )
}

/// The text with its ANSI escape sequences (CSI and OSC) taken out.
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            Some('[') => {
                chars.next();
                // Parameters and intermediates, then one final byte.
                for c in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next();
                while let Some(c) = chars.next() {
                    if c == '\x07' {
                        break;
                    }
                    if c == '\x1b' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            Some(_) => {
                chars.next();
            }
            None => {}
        }
    }
    out
}

/// One piece of output: a line ended by `\n` (`ends_line`), or a piece a
/// `\r` will rewrite.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub text: String,
    pub ends_line: bool,
}

/// The longest a segment is held for its end before it is handed on whole,
/// so a stream with no line ends costs bounded memory.
const SEGMENT_MAX: usize = 64 * 1024;

/// Cuts a byte stream into segments at `\n` and `\r` (`\r\n` is one line
/// end). Bytes are kept until their segment ends, so a character split
/// across two reads is decoded whole.
#[derive(Debug, Default)]
pub struct Splitter {
    pending: Vec<u8>,
    after_cr: bool,
}

impl Splitter {
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Segment> {
        let mut out = Vec::new();
        for &b in bytes {
            match b {
                b'\n' => {
                    if self.after_cr && self.pending.is_empty() {
                        // `\r\n`: the `\r` already ended the segment; this
                        // ends the line it was on.
                        out.push(Segment {
                            text: String::new(),
                            ends_line: true,
                        });
                    } else {
                        out.push(self.take(true));
                    }
                    self.after_cr = false;
                }
                b'\r' => {
                    out.push(self.take(false));
                    self.after_cr = true;
                }
                _ => {
                    self.after_cr = false;
                    self.pending.push(b);
                    if self.pending.len() >= SEGMENT_MAX {
                        out.push(self.take(false));
                    }
                }
            }
        }
        out
    }

    /// What is left when the stream ends.
    pub fn finish(&mut self) -> Option<Segment> {
        (!self.pending.is_empty()).then(|| self.take(true))
    }

    fn take(&mut self, ends_line: bool) -> Segment {
        let text = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        Segment { text, ends_line }
    }
}

/// The last lines of a job's output, as a terminal would have left them: a
/// line a `\r` rewrote is kept as its last rewrite.
#[derive(Debug)]
pub struct Tail {
    keep: usize,
    lines: std::collections::VecDeque<String>,
    current: String,
}

/// The longest line kept in a tail.
const TAIL_LINE_MAX: usize = 400;

impl Tail {
    pub fn new(keep: usize) -> Self {
        Self {
            keep,
            lines: Default::default(),
            current: String::new(),
        }
    }

    pub fn push(&mut self, segment: &Segment) {
        let text = strip_ansi(&segment.text);
        if !text.trim().is_empty() {
            self.current = text;
        }
        if segment.ends_line {
            let line = std::mem::take(&mut self.current);
            if !line.trim().is_empty() {
                self.lines.push_back(cut(line.trim_end()));
                while self.lines.len() > self.keep {
                    self.lines.pop_front();
                }
            }
        }
    }

    pub fn lines(&self) -> Vec<String> {
        let mut lines: Vec<String> = self.lines.iter().cloned().collect();
        if !self.current.trim().is_empty() {
            lines.push(cut(self.current.trim_end()));
            if lines.len() > self.keep {
                lines.remove(0);
            }
        }
        lines
    }
}

fn cut(line: &str) -> String {
    if line.chars().count() <= TAIL_LINE_MAX {
        return line.to_string();
    }
    let mut cut: String = line.chars().take(TAIL_LINE_MAX).collect();
    cut.push('…');
    cut
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every reading a recorded output gives, in order, with `format`.
    fn readings(bytes: &[u8], format: Format) -> Vec<Progress> {
        let mut splitter = Splitter::default();
        let mut parser = Parser::new(format);
        let mut segments = splitter.feed(bytes);
        segments.extend(splitter.finish());
        segments
            .iter()
            .filter_map(|segment| parser.line(&segment.text))
            .collect()
    }

    fn counts(readings: &[Progress]) -> Vec<(Option<&str>, f64, f64)> {
        readings
            .iter()
            .map(|p| (p.phase.as_deref(), p.done.unwrap(), p.total.unwrap()))
            .collect()
    }

    const FFMPEG: &[u8] = include_bytes!("job_progress/fixtures/ffmpeg-transcode.txt");
    const FFMPEG_NO_DURATION: &[u8] =
        include_bytes!("job_progress/fixtures/ffmpeg-no-duration.txt");
    const FFMPEG_PIPE: &[u8] = include_bytes!("job_progress/fixtures/ffmpeg-progress-pipe.txt");
    const CARGO: &[u8] = include_bytes!("job_progress/fixtures/cargo-build.txt");
    const REMOTION: &[u8] = include_bytes!("job_progress/fixtures/remotion-render.txt");
    const REMOTION_FIRST: &[u8] = include_bytes!("job_progress/fixtures/remotion-first-run.txt");
    const CURL: &[u8] = include_bytes!("job_progress/fixtures/curl-progress.txt");
    const NM_LOOP: &[u8] = include_bytes!("job_progress/fixtures/nm-loop.txt");

    #[test]
    fn ffmpeg_reads_time_against_the_duration_of_its_own_header() {
        for format in [Format::Ffmpeg, Format::Auto] {
            let read = readings(FFMPEG, format);
            assert!(read.len() > 5, "{format:?}: {read:?}");
            assert!(read.iter().all(|p| p.total == Some(8.0)
                && p.unit == Some(Unit::Seconds)
                && p.phase.is_none()));
            let done: Vec<f64> = read.iter().map(|p| p.done.unwrap()).collect();
            assert!(done.windows(2).all(|w| w[0] <= w[1]), "{done:?}");
            assert_eq!(done.first(), Some(&0.2));
            // The last stats line says time=00:00:07.93: the time of the
            // last frame, not the end of the input. No figure is rounded up.
            assert_eq!(done.last(), Some(&7.93));
        }
    }

    #[test]
    fn ffmpeg_with_no_duration_gives_no_figure_and_auto_reads_none_of_its_percentages() {
        assert!(readings(FFMPEG_NO_DURATION, Format::Ffmpeg).is_empty());
        // Its closing x264 statistics are full of `NN.N%`.
        assert!(String::from_utf8_lossy(FFMPEG_NO_DURATION).contains('%'));
        assert!(readings(FFMPEG_NO_DURATION, Format::Auto).is_empty());
    }

    #[test]
    fn ffmpeg_progress_pipe_reads_out_time() {
        let read = readings(FFMPEG_PIPE, Format::Auto);
        assert!(!read.is_empty());
        assert!(read.iter().all(|p| p.total == Some(8.0)));
        assert_eq!(read[0].done, Some(0.7));
    }

    #[test]
    fn cargo_reads_its_building_bar() {
        for format in [Format::Cargo, Format::Auto] {
            let read = readings(CARGO, format);
            let counts = counts(&read);
            assert_eq!(counts.first(), Some(&(Some("Building"), 0.0, 24.0)));
            assert_eq!(counts.last(), Some(&(Some("Building"), 23.0, 24.0)));
            assert!(read.iter().all(|p| p.unit == Some(Unit::Crates)));
        }
    }

    #[test]
    fn remotion_reads_bundling_rendering_and_encoding() {
        for format in [Format::Remotion, Format::Auto] {
            let read = readings(REMOTION, format);
            let phases: Vec<&str> = read.iter().filter_map(|p| p.phase.as_deref()).collect();
            let order: Vec<&str> = phases.iter().fold(Vec::new(), |mut order, phase| {
                if order.last() != Some(phase) {
                    order.push(phase);
                }
                order
            });
            assert_eq!(order, ["Bundling", "Rendering", "Encoding"], "{format:?}");
            let rendering: Vec<_> = read
                .iter()
                .filter(|p| p.phase.as_deref() == Some("Rendering"))
                .collect();
            assert!(rendering
                .iter()
                .all(|p| p.total == Some(90.0) && p.unit == Some(Unit::Frames)));
            let last = read.last().unwrap();
            assert_eq!((last.done, last.total), (Some(90.0), Some(90.0)));
            let bundling = read
                .iter()
                .find(|p| p.phase.as_deref() == Some("Bundling"))
                .unwrap();
            assert_eq!(bundling.unit, Some(Unit::Percent));
        }
    }

    #[test]
    fn remotion_first_run_downloads_its_browser_without_a_figure() {
        // `Getting Headless Shell - 9.5 Mb/170.9 Mb` is neither N/M nor %.
        let read = readings(REMOTION_FIRST, Format::Auto);
        assert!(read.iter().all(|p| matches!(
            p.phase.as_deref(),
            Some("Rendering" | "Encoding" | "Bundling")
        )));
        assert!(read.iter().any(|p| p.phase.as_deref() == Some("Rendering")));
    }

    #[test]
    fn a_percentage_is_read_from_curl() {
        for format in [Format::Percent, Format::Auto] {
            let read = readings(CURL, format);
            assert!(read.len() > 3);
            assert_eq!(read[0].done, Some(3.4));
            assert_eq!(read.last().unwrap().done, Some(100.0));
            assert!(read
                .iter()
                .all(|p| p.total == Some(100.0) && p.unit == Some(Unit::Percent)));
        }
    }

    #[test]
    fn a_bare_count_is_read() {
        let read = readings(NM_LOOP, Format::Auto);
        assert_eq!(
            counts(&read),
            [(None, 1.0, 3.0), (None, 2.0, 3.0), (None, 3.0, 3.0)]
        );
        assert!(read.iter().all(|p| p.unit == Some(Unit::Items)));
    }

    #[test]
    fn a_count_is_not_a_date_a_path_or_a_rate() {
        for line in [
            "2026/10/17 started",
            "10/17/2026",
            "bitrate=   1.9kbits/s",
            "src/bin/a.rs",
            "9.5 Mb/170.9 Mb",
            "v1/2",
            "4/0",
            "9/3 done",
            "1/2b",
            "",
        ] {
            assert_eq!(nm(line), None, "{line:?}");
        }
        assert_eq!(nm("[2/5] step").and_then(|p| p.done), Some(2.0));
        assert_eq!(nm("image 4 / 10").and_then(|p| p.total), Some(10.0));
        assert_eq!(percent("v2% 50%").and_then(|p| p.done), Some(50.0));
        assert_eq!(percent("120%"), None);
    }

    #[test]
    fn a_progress_file_is_read_whole_or_not_at_all() {
        let p = progress_file(r#"{"done":3,"total":8,"phase":"Generating"}"#).unwrap();
        assert_eq!(
            p,
            Progress {
                phase: Some("Generating".into()),
                done: Some(3.0),
                total: Some(8.0),
                unit: Some(Unit::Items),
            }
        );
        assert_eq!(
            progress_file(r#"{"done":2,"total":4,"unit":"frames"}"#).and_then(|p| p.unit),
            Some(Unit::Frames)
        );
        for text in [
            r#"{"done":3,"to"#,
            r#"{"done":3}"#,
            r#"{"done":9,"total":8}"#,
            "",
        ] {
            assert_eq!(progress_file(text), None, "{text}");
        }
    }

    #[test]
    fn segments_split_at_line_feeds_and_carriage_returns() {
        let mut splitter = Splitter::default();
        let mut got = splitter.feed(b"a\r\nb\rc\nd");
        got.extend(splitter.finish());
        let seg = |text: &str, ends_line| Segment {
            text: text.into(),
            ends_line,
        };
        assert_eq!(
            got,
            [
                seg("a", false),
                seg("", true),
                seg("b", false),
                seg("c", true),
                seg("d", true)
            ]
        );
        // A character split across two reads is decoded whole.
        let mut splitter = Splitter::default();
        let mut got = splitter.feed(&"é".as_bytes()[..1]);
        got.extend(splitter.feed(&"é\n".as_bytes()[1..]));
        assert_eq!(got, [seg("é", true)]);
    }

    #[test]
    fn a_tail_keeps_the_last_rewrite_of_each_line() {
        let mut splitter = Splitter::default();
        let mut tail = Tail::new(2);
        let mut segments = splitter.feed(b"one\n10%\r50%\r100%\nthree\nfour");
        segments.extend(splitter.finish());
        for segment in &segments {
            tail.push(segment);
        }
        assert_eq!(tail.lines(), ["three", "four"]);
        let mut tail = Tail::new(5);
        let mut splitter = Splitter::default();
        for segment in splitter.feed(b"one\n10%\r50%\r100%\n\x1b[1mbold\x1b[0m\npartial") {
            tail.push(&segment);
        }
        // A line the stream has not ended yet is held back.
        assert_eq!(tail.lines(), ["one", "100%", "bold"]);
        tail.push(&splitter.finish().unwrap());
        assert_eq!(tail.lines(), ["one", "100%", "bold", "partial"]);
    }

    #[test]
    fn formats_are_named() {
        assert_eq!(Format::parse("FFMPEG"), Ok(Format::Ffmpeg));
        assert_eq!(Format::parse(""), Ok(Format::Auto));
        assert!(Format::parse("x264").is_err());
    }
}
