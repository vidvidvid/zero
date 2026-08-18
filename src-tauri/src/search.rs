use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Search across a project, and replace across it.
///
/// The matching is done here rather than shelled out to ripgrep or `git grep`,
/// which is a change from how this worked before. Three reasons, in the order
/// they mattered:
///
/// - **It has to be there.** ripgrep isn't installed on most machines, and
///   `which rg` can report one that isn't (Claude Code defines a shell function
///   by that name, and nothing spawned from Rust goes through a shell).
/// - **Highlighting needs offsets.** grep hands back a line of text; drawing the
///   match inside that line means knowing where in it the match sat. Finding it
///   again in the frontend would be re-implementing the matcher anyway, and
///   getting a different answer from it is exactly the bug you'd never notice.
/// - **Replace has to hit what search showed.** Both go through the same
///   `Matcher`, so there is no second opinion about what matched.
///
/// The file list still comes from git — `git ls-files` skips ignored files
/// without anyone here parsing .gitignore — and searching is literal. A regex
/// toggle would need a regex engine; this has none.

/* ---------- what the frontend asks for ---------- */

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pub text: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    /// comma-separated globs. Empty means every file.
    pub include: String,
    /// comma-separated globs, subtracted from whatever `include` left.
    pub exclude: String,
}

/* ---------- what it gets back ---------- */

#[derive(Serialize)]
pub struct Span {
    /// UTF-16 offsets into `LineHit::text` — the units a JS string is indexed by
    pub start: u32,
    pub end: u32,
    /// which match this is within its line, counting from the start of the
    /// untrimmed line. Survives truncation, so it can name one match to replace.
    pub nth: u32,
}

#[derive(Serialize)]
pub struct LineHit {
    /// 1-based, the way an editor counts
    pub line: u32,
    /// the line as shown: leading indentation dropped, long lines cut
    pub text: String,
    pub spans: Vec<Span>,
}

#[derive(Serialize)]
pub struct FileHits {
    /// relative to the project root
    pub path: String,
    /// every match in the file, including any past the ones listed
    pub count: u32,
    pub lines: Vec<LineHit>,
}

#[derive(Serialize)]
pub struct SearchResult {
    pub files: Vec<FileHits>,
    pub matches: u32,
    /// the search stopped early — there are more matches than these
    pub truncated: bool,
}

/* ---------- limits ----------
   All four exist to keep one careless query — `e`, say, across a monorepo —
   from filling memory and freezing the list. Each is generous enough that
   reaching it means the query wants narrowing, not that the tool gave up. */

const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_LINES_PER_FILE: usize = 200;
const MAX_TOTAL_MATCHES: usize = 5_000;
/// past this a line is minified, generated, or both, and no longer readable
const MAX_LINE_CHARS: usize = 400;

/* ---------- matching ---------- */

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

struct Matcher {
    /// ASCII-folded when the search is case-insensitive, to match the haystack
    needle: String,
    case_sensitive: bool,
    whole_word: bool,
}

impl Matcher {
    fn new(q: &Query) -> Option<Matcher> {
        if q.text.is_empty() {
            return None;
        }
        Some(Matcher {
            // ASCII folding on purpose: it's the one case mapping that can't
            // change a string's length, so an offset found in the folded copy
            // still points at the right place in the original. Full Unicode
            // folding does change lengths (`İ` lowercases to two chars), and
            // the identifiers this searches are ASCII in practice.
            needle: if q.case_sensitive {
                q.text.clone()
            } else {
                q.text.to_ascii_lowercase()
            },
            case_sensitive: q.case_sensitive,
            whole_word: q.whole_word,
        })
    }

    /// The haystack this matcher searches in. Borrowed when the search is
    /// case-sensitive, which is the whole reason folding is a separate step:
    /// doing it per line meant an allocation per line of every file in the
    /// project, and most lines of most files never matter to a search.
    fn fold<'a>(&self, s: &'a str) -> Cow<'a, str> {
        if self.case_sensitive {
            Cow::Borrowed(s)
        } else {
            Cow::Owned(s.to_ascii_lowercase())
        }
    }

    /// the next match at or after `at`. `hay` must already be folded.
    fn next(&self, hay: &str, at: usize) -> Option<(usize, usize)> {
        let mut at = at;
        loop {
            let i = hay[at..].find(&self.needle)?;
            let start = at + i;
            let end = start + self.needle.len();
            // `end` is always a char boundary and always past `start`, so this
            // both terminates and stays sliceable
            at = end;
            if !self.whole_word || word_bounded(hay, start, end) {
                return Some((start, end));
            }
        }
    }

    /// every match in a folded haystack, non-overlapping and in order
    fn find(&self, hay: &str) -> Vec<(usize, usize)> {
        let mut out = Vec::new();
        let mut at = 0;
        while let Some((s, e)) = self.next(hay, at) {
            out.push((s, e));
            at = e;
        }
        out
    }
}

/// Word-ness doesn't care about case, so this is as true of the folded text as
/// of the original — which is why the whole scan can stay on the folded copy.
fn word_bounded(hay: &str, start: usize, end: usize) -> bool {
    !hay[..start].chars().next_back().is_some_and(is_word)
        && !hay[end..].chars().next().is_some_and(is_word)
}

/// one line without its terminator, whichever of the two it uses
fn line_body(raw: &str) -> &str {
    raw.strip_suffix('\n')
        .map_or(raw, |s| s.strip_suffix('\r').unwrap_or(s))
}

/* ---------- globs ----------
   The include/exclude fields take what VS Code's take: comma-separated
   patterns, `*` within a path segment, `**` across them, `?` for one character,
   `{a,b}` for alternatives.

   One deliberate difference. VS Code resolves a bare `src` by asking the disk
   whether it's a directory; typing a folder name is the common case and it
   would be unhelpful for it to match nothing. Rather than stat every pattern,
   anything with no glob character in it is treated as a path prefix — so `src`
   covers everything under src/, `src/lib` everything under that, and
   `README.md` just the one file. */

fn has_glob(pat: &str) -> bool {
    pat.contains(['*', '?', '{'])
}

/// `a.{ts,tsx}` becomes `a.ts` and `a.tsx`. Nested braces expand too, since
/// the recursion re-scans whatever it produced.
fn expand_braces(pat: &str, out: &mut Vec<String>) {
    const MAX_ALTERNATIVES: usize = 64;
    if out.len() >= MAX_ALTERNATIVES {
        return;
    }
    let Some(open) = pat.find('{') else {
        out.push(pat.to_string());
        return;
    };
    // the `}` that closes *this* `{`, not the first one along
    let mut depth = 0;
    let mut close = None;
    for (i, c) in pat[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(open + i);
                    break;
                }
            }
            _ => {}
        }
    }
    let Some(close) = close else {
        // an unbalanced brace is a literal one
        out.push(pat.to_string());
        return;
    };

    let (head, tail) = (&pat[..open], &pat[close + 1..]);
    let inner = &pat[open + 1..close];
    let mut depth = 0;
    let mut start = 0;
    let mut alts = Vec::new();
    for (i, c) in inner.char_indices() {
        match c {
            '{' => depth += 1,
            '}' => depth -= 1,
            ',' if depth == 0 => {
                alts.push(&inner[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    alts.push(&inner[start..]);
    for alt in alts {
        expand_braces(&format!("{head}{alt}{tail}"), out);
    }
}

/// `**` crosses path separators; `*` and `?` do not.
fn glob_match(p: &[u8], s: &[u8]) -> bool {
    if p.is_empty() {
        return s.is_empty();
    }
    if p.starts_with(b"**") {
        let after = &p[2..];
        // `**/foo` should match a bare `foo` too — zero directories is a
        // number of directories
        if after.first() == Some(&b'/') && glob_match(&after[1..], s) {
            return true;
        }
        for i in 0..=s.len() {
            if glob_match(after, &s[i..]) {
                return true;
            }
        }
        return false;
    }
    if p[0] == b'*' {
        let after = &p[1..];
        let mut i = 0;
        loop {
            if glob_match(after, &s[i..]) {
                return true;
            }
            if i >= s.len() || s[i] == b'/' {
                return false;
            }
            i += 1;
        }
    }
    if s.is_empty() {
        return false;
    }
    if p[0] == b'?' {
        return s[0] != b'/' && glob_match(&p[1..], &s[1..]);
    }
    p[0] == s[0] && glob_match(&p[1..], &s[1..])
}

fn one_pattern(pat: &str, rel: &str) -> bool {
    if !has_glob(pat) {
        let plain = pat.trim_end_matches('/');
        return rel == plain || rel.starts_with(&format!("{plain}/"));
    }
    // a pattern with no separator in it is about the filename, wherever it sits
    if !pat.contains('/') {
        let base = rel.rsplit('/').next().unwrap_or(rel);
        return glob_match(pat.as_bytes(), base.as_bytes());
    }
    glob_match(pat.as_bytes(), rel.as_bytes())
}

/// The commas that separate patterns, not the ones inside `{ts,tsx}` — which
/// is a comma-separated field whose patterns may contain commas, so the split
/// has to know about braces before brace expansion can happen.
fn split_patterns(field: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;
    for (i, c) in field.char_indices() {
        match c {
            '{' => depth += 1,
            '}' => depth = (depth - 1).max(0),
            ',' if depth == 0 => {
                out.push(&field[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(&field[start..]);
    out
}

/// one comma-separated field, brace-expanded. Empty when the field was.
struct Globs(Vec<String>);

impl Globs {
    fn parse(field: &str) -> Globs {
        let mut out = Vec::new();
        for part in split_patterns(field) {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }
            // a trailing `/` is someone naming a directory; `src/` is `src/**`
            let part = if part.ends_with('/') {
                format!("{part}**")
            } else {
                part.to_string()
            };
            expand_braces(&part, &mut out);
        }
        Globs(out)
    }

    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn matches(&self, rel: &str) -> bool {
        self.0.iter().any(|p| one_pattern(p, rel))
    }
}

fn wanted(rel: &str, include: &Globs, exclude: &Globs) -> bool {
    (include.is_empty() || include.matches(rel)) && !exclude.matches(rel)
}

/* ---------- the file list ----------
   `git ls-files` on a large repository costs about as much as reading a
   hundred files, and a search runs on every keystroke — so listing per
   keystroke was paying that over and over for an answer that hadn't changed.
   Briefly cached: long enough to cover typing a query, short enough that a
   file you just created turns up when you go looking for it. */

const LIST_TTL: Duration = Duration::from_secs(5);

type ListCache = Mutex<HashMap<String, (Instant, Arc<Vec<String>>)>>;

fn file_list(root: &str) -> Result<Arc<Vec<String>>, String> {
    static CACHE: OnceLock<ListCache> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);

    if let Some((at, files)) = cache.lock().unwrap().get(root) {
        if at.elapsed() < LIST_TTL {
            return Ok(files.clone());
        }
    }
    let files = Arc::new(crate::git::project_files(root)?);
    cache
        .lock()
        .unwrap()
        .insert(root.to_string(), (Instant::now(), files.clone()));
    Ok(files)
}

/* ---------- reading files ---------- */

/// Whether this looks like something with lines in it. A NUL in the first block
/// is how every grep decides this.
fn is_binary(head: &[u8]) -> bool {
    head.iter().take(8192).any(|b| *b == 0)
}

/// A match's line, as it will be shown, plus where in it the matches landed.
///
/// Indentation is dropped because the panel is a sidebar and a deeply nested
/// line would otherwise arrive as blank space. The offsets returned are UTF-16
/// units so the frontend can slice the string it was handed without counting.
fn present(body: &str, ranges: &[(usize, usize)]) -> LineHit {
    let indent = body.len() - body.trim_start().len();
    let trimmed = &body[indent..];

    let mut text = String::new();
    // byte offset in `trimmed` → UTF-16 offset in `text`, for the boundaries
    // we care about
    let mut utf16_at = HashMap::new();
    let mut utf16 = 0usize;
    let mut chars = 0usize;
    for (i, c) in trimmed.char_indices() {
        if chars >= MAX_LINE_CHARS {
            break;
        }
        utf16_at.insert(i, utf16);
        text.push(c);
        utf16 += c.len_utf16();
        chars += 1;
    }
    utf16_at.insert(text.len(), utf16);

    let spans = ranges
        .iter()
        .enumerate()
        .filter_map(|(nth, &(from, to))| {
            let start = *utf16_at.get(&from.checked_sub(indent)?)?;
            let end = *utf16_at.get(&to.checked_sub(indent)?)?;
            Some(Span {
                start: start as u32,
                end: end as u32,
                nth: nth as u32,
            })
        })
        .collect();

    LineHit {
        line: 0, // filled in by the caller, which is counting
        text,
        spans,
    }
}

/// Walk a whole file's matches at once and group them by line.
///
/// The line-by-line alternative — split, then search each line — was the slow
/// way round: it pays the substring search's setup cost per line and can't skip
/// anything, where this jumps from match to match and only ever looks at a line
/// that has one in it.
///
/// `hay` is folded, `display` is not. They're the same length by construction,
/// so an offset in one is an offset in the other.
fn collect(hay: &str, display: &str, m: &Matcher) -> Option<FileHits> {
    let mut lines: Vec<LineHit> = Vec::new();
    let mut count = 0u32;

    let mut at = 0usize;
    // where the line counter has got to. Both only ever move forward, which is
    // what keeps this linear in the size of the file.
    let mut line_no = 1u32;
    let mut seen_to = 0usize;
    let mut line_start = 0usize;

    // the line being accumulated, if any
    let mut pending: Option<(u32, usize, usize, Vec<(usize, usize)>)> = None;

    while let Some((start, end)) = m.next(hay, at) {
        at = end;
        count += 1;

        // catch the line counter up to this match
        let seg = &hay[seen_to..start];
        let breaks = seg.matches('\n').count();
        if breaks > 0 {
            line_no += breaks as u32;
            line_start = seen_to + seg.rfind('\n').unwrap() + 1;
        }
        seen_to = start;

        match &mut pending {
            Some((no, _, _, ranges)) if *no == line_no => ranges.push((start, end)),
            _ => {
                if let Some(done) = pending.take() {
                    push_line(&mut lines, display, done);
                }
                if lines.len() >= MAX_LINES_PER_FILE {
                    // still counting, just not keeping — the panel says how
                    // many it isn't showing
                    continue;
                }
                let rest = &hay[line_start..];
                let end_of_line = line_start + rest.find('\n').unwrap_or(rest.len());
                pending = Some((line_no, line_start, end_of_line, vec![(start, end)]));
            }
        }
    }
    if let Some(done) = pending.take() {
        push_line(&mut lines, display, done);
    }

    if count == 0 {
        return None;
    }
    Some(FileHits {
        path: String::new(), // the caller knows it; this only knows the file
        count,
        lines,
    })
}

fn push_line(
    lines: &mut Vec<LineHit>,
    display: &str,
    (line, from, to, ranges): (u32, usize, usize, Vec<(usize, usize)>),
) {
    // `get` rather than an index: display is a second read of the same file,
    // and a file rewritten between the two reads shouldn't panic anything
    let Some(raw) = display.get(from..to) else { return };
    // the slice already stops short of the `\n`, so the `\r` of a CRLF is the
    // only terminator left to drop — `line_body` wants both or neither
    let body = raw.strip_suffix('\r').unwrap_or(raw);
    let local: Vec<(usize, usize)> = ranges
        .iter()
        .map(|&(a, b)| (a.saturating_sub(from), b.saturating_sub(from)))
        .collect();
    let mut hit = present(body, &local);
    hit.line = line;
    lines.push(hit);
}

/// One file, start to finish.
///
/// The shape here is all about the common case, which is that the file doesn't
/// contain the query at all: read it, fold it in place, ask once whether the
/// needle is anywhere in it, and leave. Nothing is allocated per line and
/// nothing is split until a file has earned it.
fn scan(abs: &Path, m: &Matcher, buf: &mut Vec<u8>) -> Option<FileHits> {
    let mut file = std::fs::File::open(abs).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    // one buffer per thread, reused: a search reads thousands of files, and
    // handing each one its own allocation is a cost with nothing to show for it
    buf.clear();
    file.read_to_end(buf).ok()?;
    if is_binary(buf) {
        return None;
    }
    if !m.case_sensitive {
        // in place. Only ASCII A–Z move, and those bytes never appear inside a
        // multi-byte character, so this is still valid UTF-8 at the same offsets.
        buf.make_ascii_lowercase();
    }
    let hay = std::str::from_utf8(buf).ok()?;
    if !hay.contains(m.needle.as_str()) {
        return None;
    }

    // Earned it. When the search was case-sensitive nothing was folded and the
    // buffer is already the text to show; otherwise the original has to come
    // back off disk, and if it changed underneath us we show the folded one
    // rather than nothing.
    let original = if m.case_sensitive {
        None
    } else {
        std::fs::read_to_string(abs).ok().filter(|o| o.len() == hay.len())
    };
    collect(hay, original.as_deref().unwrap_or(hay), m)
}

/* ---------- the search itself ---------- */

/// Files are independent, so this is the one place in zero worth threading.
/// Work is claimed from a shared counter rather than sliced up front — file
/// sizes vary by orders of magnitude, and a static split leaves one thread
/// holding the one enormous lockfile while the rest sit idle.
fn scan_all(root: &Path, files: &[String], m: &Matcher) -> (Vec<(usize, FileHits)>, bool) {
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
    let next = AtomicUsize::new(0);
    let total = AtomicUsize::new(0);
    let out = Mutex::new(Vec::new());

    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| {
                let mut buf = Vec::new();
                loop {
                    if total.load(Ordering::Relaxed) >= MAX_TOTAL_MATCHES {
                        break;
                    }
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(rel) = files.get(i) else { break };
                    if let Some(mut hits) = scan(&root.join(rel), m, &mut buf) {
                        hits.path = rel.clone();
                        total.fetch_add(hits.count as usize, Ordering::Relaxed);
                        out.lock().unwrap().push((i, hits));
                    }
                }
            });
        }
    });

    let mut found = out.into_inner().unwrap();
    // threads finish in whatever order they finish; the list is git's order
    found.sort_by_key(|(i, _)| *i);
    (found, total.load(Ordering::Relaxed) >= MAX_TOTAL_MATCHES)
}

fn search(root: &str, query: &Query) -> Result<SearchResult, String> {
    let Some(m) = Matcher::new(query) else {
        return Ok(SearchResult {
            files: vec![],
            matches: 0,
            truncated: false,
        });
    };

    let include = Globs::parse(&query.include);
    let exclude = Globs::parse(&query.exclude);
    let all = file_list(root)?;
    let files: Vec<String> = all
        .iter()
        .filter(|rel| wanted(rel, &include, &exclude))
        .cloned()
        .collect();

    let (found, truncated) = scan_all(Path::new(root), &files, &m);
    let matches = found.iter().map(|(_, f)| f.count).sum();
    Ok(SearchResult {
        files: found.into_iter().map(|(_, f)| f).collect(),
        matches,
        truncated,
    })
}

#[tauri::command]
pub async fn search_project(root: String, query: Query) -> Result<SearchResult, String> {
    crate::git::blocking(move || search(&root, &query)).await
}

/* ---------- replace ---------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// relative to the project root
    pub path: String,
    /// 1-based. Absent means every match in the file.
    pub line: Option<u32>,
    /// which match on that line, as `Span::nth` numbered them
    pub nth: Option<u32>,
}

/// Replace, going through the same matcher search did.
///
/// Deliberately re-reading and re-matching rather than trusting the offsets the
/// frontend is holding: those were true when the search ran, and a file can
/// change underneath a result list that's been sitting there. Re-matching means
/// the worst case is replacing nothing, instead of writing at a stale offset.
///
/// Returns how many matches were replaced.
#[tauri::command]
pub async fn replace_matches(
    root: String,
    query: Query,
    replacement: String,
    targets: Vec<Target>,
) -> Result<u32, String> {
    crate::git::blocking(move || replace(&root, &query, &replacement, &targets)).await
}

fn replace(root: &str, query: &Query, replacement: &str, targets: &[Target]) -> Result<u32, String> {
    let Some(m) = Matcher::new(query) else {
        return Ok(0);
    };

    // one entry per file: None means the whole file, Some(set) means these
    let mut by_file: HashMap<&str, Option<std::collections::HashSet<(u32, u32)>>> = HashMap::new();
    for t in targets {
        let slot = by_file
            .entry(t.path.as_str())
            .or_insert_with(|| Some(Default::default()));
        match (t.line, t.nth) {
            (Some(line), Some(nth)) => {
                if let Some(set) = slot {
                    set.insert((line, nth));
                }
            }
            // no line, or a line with no match named: take the file
            _ => *slot = None,
        }
    }

    let root = Path::new(root);
    let mut replaced = 0u32;
    for (rel, picked) in by_file {
        let abs = root.join(rel);
        let Ok(text) = std::fs::read_to_string(&abs) else { continue };
        let folded = m.fold(&text);

        let mut out = String::with_capacity(text.len());
        let mut changed = 0u32;
        // walked in lockstep: folding can't change a byte's position, so the
        // two split into the same lines at the same offsets
        for (i, (raw, raw_folded)) in text
            .split_inclusive('\n')
            .zip(folded.split_inclusive('\n'))
            .enumerate()
        {
            let line = i as u32 + 1;
            let body = line_body(raw);
            let ranges = m.find(line_body(raw_folded));
            if ranges.is_empty() {
                out.push_str(raw);
                continue;
            }
            let mut at = 0;
            for (nth, &(from, to)) in ranges.iter().enumerate() {
                let take = match &picked {
                    None => true,
                    Some(set) => set.contains(&(line, nth as u32)),
                };
                if !take {
                    continue;
                }
                out.push_str(&body[at..from]);
                out.push_str(replacement);
                at = to;
                changed += 1;
            }
            out.push_str(&body[at..]);
            out.push_str(&raw[body.len()..]); // the terminator, as it was
        }

        if changed > 0 {
            std::fs::write(&abs, out).map_err(|e| format!("{rel}: {e}"))?;
            replaced += changed;
        }
    }
    Ok(replaced)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(text: &str, case_sensitive: bool, whole_word: bool) -> Query {
        Query {
            text: text.into(),
            case_sensitive,
            whole_word,
            include: String::new(),
            exclude: String::new(),
        }
    }

    /// what one line yields, folded the way the matcher expects
    fn hits(query: &Query, line: &str) -> Vec<(usize, usize)> {
        let m = Matcher::new(query).unwrap();
        m.find(&m.fold(line))
    }

    #[test]
    fn case_and_word_toggles_do_what_they_say() {
        let line = "const Foo = foo + foobar;";
        assert_eq!(
            hits(&q("foo", false, false), line).len(),
            3,
            "case-insensitive should see Foo, foo, foobar"
        );
        assert_eq!(
            hits(&q("foo", true, false), line).len(),
            2,
            "case-sensitive should skip Foo"
        );
        assert_eq!(
            hits(&q("foo", false, true), line).len(),
            2,
            "whole-word should skip foobar"
        );
        assert_eq!(
            hits(&q("foo", true, true), line),
            vec![(12, 15)],
            "only the bare lowercase one"
        );
    }

    /// The folded copy is searched but the original is sliced, so a multi-byte
    /// character anywhere earlier on the line would shift every offset after it
    /// if the two ever disagreed about length.
    #[test]
    fn offsets_survive_multibyte_lines() {
        let line = "// naïve — the needle is here";
        let hit = hits(&q("NEEDLE", false, false), line);
        assert_eq!(hit.len(), 1);
        let (from, to) = hit[0];
        assert_eq!(&line[from..to], "needle", "an offset into the folded copy is one into the original");
    }

    #[test]
    fn spans_are_utf16_offsets_into_the_trimmed_line() {
        //      indent            emoji is two UTF-16 units
        let body = "    let x = \"🎈 needle\";";
        let ranges = hits(&q("needle", false, false), body);
        let hit = present(body, &ranges);
        assert_eq!(hit.text, "let x = \"🎈 needle\";", "indentation dropped");
        let s = hit.spans[0].start as usize;
        let e = hit.spans[0].end as usize;
        let utf16: Vec<u16> = hit.text.encode_utf16().collect();
        assert_eq!(String::from_utf16(&utf16[s..e]).unwrap(), "needle");
    }

    /// The whole-file walk has to land on the same lines the old line-by-line
    /// version did, including the last line when it has no terminator.
    #[test]
    fn matches_are_grouped_onto_the_right_lines() {
        let text = "one needle\nnothing\nneedle needle\r\n\nlast needle";
        let m = Matcher::new(&q("needle", false, false)).unwrap();
        let hits = collect(&m.fold(text), text, &m).unwrap();
        assert_eq!(hits.count, 4);
        let lines: Vec<(u32, usize, String)> = hits
            .lines
            .iter()
            .map(|l| (l.line, l.spans.len(), l.text.clone()))
            .collect();
        assert_eq!(
            lines,
            vec![
                (1, 1, "one needle".into()),
                (3, 2, "needle needle".into()),
                (5, 1, "last needle".into()),
            ]
        );
    }

    #[test]
    fn globs_cover_the_shapes_people_type() {
        let yes = |pat: &str, rel: &str| {
            assert!(Globs::parse(pat).matches(rel), "{pat:?} should match {rel:?}")
        };
        let no = |pat: &str, rel: &str| {
            assert!(!Globs::parse(pat).matches(rel), "{pat:?} should not match {rel:?}")
        };

        // a bare name is a prefix, so typing a folder does the obvious thing
        yes("src", "src/lib/api.ts");
        no("src", "srcs/lib/api.ts");
        yes("src/", "src/lib/api.ts");
        yes("README.md", "README.md");

        // an extension pattern is about the filename, at any depth
        yes("*.ts", "src/lib/api.ts");
        no("*.ts", "src/lib/api.tsx");
        yes("*.{ts,tsx}", "src/lib/api.tsx");

        // `*` stops at a separator, `**` doesn't
        yes("src/*/api.ts", "src/lib/api.ts");
        no("src/*/api.ts", "src/lib/deep/api.ts");
        yes("src/**/api.ts", "src/lib/deep/api.ts");
        yes("**/api.ts", "api.ts");

        yes("a.ts, b.ts", "b.ts");
        // the separating commas are not the ones inside the braces
        yes("*.{ts,tsx}, *.rs", "main.rs");
        no("*.{ts,tsx}, *.rs", "main.css");
    }

    #[test]
    fn include_and_exclude_compose() {
        let inc = Globs::parse("src");
        let exc = Globs::parse("**/*.test.ts");
        assert!(wanted("src/api.ts", &inc, &exc));
        assert!(!wanted("src/api.test.ts", &inc, &exc));
        assert!(!wanted("docs/api.ts", &inc, &exc));
        // an empty include is "everywhere", not "nowhere"
        assert!(wanted("docs/api.ts", &Globs::parse(""), &exc));
    }

    #[test]
    fn replacing_one_match_leaves_its_neighbours_alone() {
        let dir = std::env::temp_dir().join("zero-replace-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        // no trailing newline on the last line, and a CRLF in the middle
        std::fs::write(&file, "Foo foo\r\nfoo\nkeep foo").unwrap();
        let cwd = dir.to_string_lossy().to_string();

        let picked = replace(
            &cwd,
            &q("foo", false, false),
            "bar",
            &[Target {
                path: "a.txt".into(),
                line: Some(1),
                nth: Some(1),
            }],
        )
        .unwrap();
        assert_eq!(picked, 1);
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "Foo bar\r\nfoo\nkeep foo",
            "line endings and the other matches should be untouched"
        );

        let all = replace(
            &cwd,
            &q("foo", false, false),
            "bar",
            &[Target {
                path: "a.txt".into(),
                line: None,
                nth: None,
            }],
        )
        .unwrap();
        assert_eq!(all, 3, "a case-insensitive replace takes Foo as well");
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "bar bar\r\nbar\nkeep bar"
        );
    }

    /// Not an assertion about speed — a way to measure it. Point it at a real
    /// repository: `ZERO_BENCH=/path/to/repo cargo test bench_search -- --nocapture --ignored`
    #[test]
    #[ignore]
    fn bench_search() {
        let Ok(root) = std::env::var("ZERO_BENCH") else { return };
        for (label, query) in [
            ("miss, insensitive", q("zzqqxxnotpresent", false, false)),
            ("miss, sensitive", q("zzqqxxnotpresent", true, false)),
            ("hit", q("useEffect", false, false)),
            ("hit, whole word", q("useEffect", false, true)),
            // what excluding generated files is worth, which on the repository
            // this was tuned against turned out to be about 4 ms — the cost is
            // spread across thousands of ordinary files, not concentrated in a
            // few big ones, so narrowing the set is not where the time is
            ("hit, no generated", {
                let mut q = q("useEffect", false, false);
                q.exclude = "**/*.snap, drizzle, *.lock, dist, build".into();
                q
            }),
        ] {
            // warm the page cache first, so this measures the search
            let _ = search(&root, &query);
            let at = Instant::now();
            let r = search(&root, &query).unwrap();
            println!(
                "{label:20} {:>6} ms  {} matches in {} files",
                at.elapsed().as_millis(),
                r.matches,
                r.files.len()
            );
        }
    }
}
