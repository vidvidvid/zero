//! Making, renaming, copying and throwing away files — the verbs the right-click
//! menu adds to the ones that only read.
//!
//! Every path here comes from the app's own model of the project (a tree row, a
//! tab, a search hit), never from anything a program printed, so there is no
//! scheme or argument to vet the way `links` has to. What is checked is the
//! *name*: a new or renamed entry is one path component, never a walk, so
//! renaming a file can only ever move it within the folder it is already in.
//! That is the whole boundary, and it is a boundary about what the gesture
//! means rather than about trust — "rename" that could write two directories up
//! is not a rename.

use std::path::Path;

/// A single path component, and one that isn't a way of naming somewhere else.
///
/// Empty, `.` and `..` are all names Finder refuses too. The separator check is
/// the load-bearing one: without it "rename" is "move anywhere", and a typo
/// with a slash in it silently puts the file somewhere you weren't looking.
fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("a name is needed".into());
    }
    if name == "." || name == ".." {
        return Err(format!("{name} isn't a name"));
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err("a name can't contain a slash".into());
    }
    Ok(())
}

/// Refuse rather than overwrite. Every one of these commands is reached from a
/// menu item, and a menu item that silently replaces a file you'd forgotten
/// about is the kind of thing you find out about later.
fn check_free(path: &Path) -> Result<(), String> {
    // `symlink_metadata`, not `exists`: a broken symlink is still something
    // occupying the name, and `exists` follows the link and says no.
    if path.symlink_metadata().is_ok() {
        return Err(format!(
            "{} already exists",
            path.file_name().unwrap_or_default().to_string_lossy()
        ));
    }
    Ok(())
}

fn as_str(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| "path is not valid UTF-8".to_string())
}

/// An empty file, or a folder, inside `dir`. Returns what it made, so the
/// caller can open it without recomputing the path it asked for.
#[tauri::command]
pub fn create_entry(dir: String, name: String, folder: bool) -> Result<String, String> {
    check_name(&name)?;
    let path = Path::new(&dir).join(&name);
    check_free(&path)?;
    if folder {
        std::fs::create_dir(&path).map_err(|e| e.to_string())?;
    } else {
        // create_new: the check above is a better error message, this is the
        // one that is actually atomic
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
    }
    as_str(&path)
}

/// Rename within the folder the entry is already in.
#[tauri::command]
pub fn rename_entry(path: String, name: String) -> Result<String, String> {
    check_name(&name)?;
    let from = Path::new(&path);
    let parent = from.parent().ok_or("nothing to rename")?;
    let to = parent.join(&name);
    if to == from {
        return as_str(&to);
    }
    // Two files whose names differ only in case are one file on the default
    // macOS filesystem, so `check_free` would refuse to let you fix the case of
    // a name — which is the rename people most often want and the one HFS is
    // most confusing about. Same file, so there is nothing to overwrite.
    let same_file = from
        .symlink_metadata()
        .ok()
        .zip(to.symlink_metadata().ok())
        .is_some_and(|(a, b)| {
            use std::os::unix::fs::MetadataExt;
            a.dev() == b.dev() && a.ino() == b.ino()
        });
    if !same_file {
        check_free(&to)?;
    }
    std::fs::rename(from, &to).map_err(|e| e.to_string())?;
    as_str(&to)
}

/// `api.ts` → `api copy.ts` → `api copy 2.ts`, the way Finder counts.
///
/// The suffix goes before the extension so the copy is still a TypeScript file
/// — `api.ts copy` opens in nothing.
#[tauri::command]
pub fn duplicate_entry(path: String) -> Result<String, String> {
    let from = Path::new(&path);
    let parent = from.parent().ok_or("nothing to duplicate")?;
    let name = from
        .file_name()
        .ok_or("nothing to duplicate")?
        .to_string_lossy()
        .to_string();
    // split on the *last* dot, and never on a leading one: `.gitignore` is a
    // name, not an extension
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name.as_str(), ""),
    };

    let mut to = parent.join(format!("{stem} copy{ext}"));
    let mut n = 2;
    while to.symlink_metadata().is_ok() {
        to = parent.join(format!("{stem} copy {n}{ext}"));
        n += 1;
        if n > 999 {
            return Err("too many copies".into());
        }
    }

    let meta = from.symlink_metadata().map_err(|e| e.to_string())?;
    if meta.is_dir() {
        copy_dir(from, &to)?;
    } else {
        std::fs::copy(from, &to).map_err(|e| e.to_string())?;
    }
    as_str(&to)
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir(to).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = to.join(entry.file_name());
        // `file_type`, not `metadata`: a symlink inside the tree is copied as a
        // link rather than followed, which is what keeps a node_modules-shaped
        // folder from becoming an infinite walk
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if kind.is_symlink() {
            let link = std::fs::read_link(entry.path()).map_err(|e| e.to_string())?;
            std::os::unix::fs::symlink(link, &target).map_err(|e| e.to_string())?;
        } else {
            std::fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Into the Trash, not into nothing.
///
/// `NSFileManager` rather than a move to `~/.Trash`, because the difference is
/// Put Back: the OS records where the file came from and Finder can undo this,
/// which is the entire reason a destructive menu item is acceptable at all. A
/// hand-rolled move gets the file out of the way and loses that.
#[tauri::command]
pub fn trash_entry(path: String) -> Result<(), String> {
    let abs = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    trash(&abs)
}

#[cfg(target_os = "macos")]
fn trash(path: &Path) -> Result<(), String> {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::msg_send;
    use std::ffi::{c_char, CStr, CString};

    let c_path = CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| "path contains a null byte".to_string())?;

    unsafe {
        let string_class = AnyClass::get(c"NSString").ok_or("no NSString")?;
        let ns_path: Option<Retained<AnyObject>> =
            msg_send![string_class, stringWithUTF8String: c_path.as_ptr()];
        let ns_path = ns_path.ok_or("path is not valid UTF-8")?;

        let url_class = AnyClass::get(c"NSURL").ok_or("no NSURL")?;
        let url: Option<Retained<AnyObject>> =
            msg_send![url_class, fileURLWithPath: &*ns_path];
        let url = url.ok_or("not a file url")?;

        let fm_class = AnyClass::get(c"NSFileManager").ok_or("no NSFileManager")?;
        let fm: Option<Retained<AnyObject>> = msg_send![fm_class, defaultManager];
        let fm = fm.ok_or("no file manager")?;

        let mut error: *mut AnyObject = std::ptr::null_mut();
        let ok: Bool = msg_send![
            &*fm,
            trashItemAtURL: &*url,
            resultingItemURL: std::ptr::null_mut::<*mut AnyObject>(),
            error: &mut error,
        ];
        if ok.as_bool() {
            return Ok(());
        }
        // whatever the OS said, verbatim — "file is in use", "permission
        // denied", and the ones we haven't thought of
        if !error.is_null() {
            let desc: Option<Retained<AnyObject>> = msg_send![error, localizedDescription];
            if let Some(desc) = desc {
                let utf8: *const c_char = msg_send![&*desc, UTF8String];
                if !utf8.is_null() {
                    return Err(CStr::from_ptr(utf8).to_string_lossy().to_string());
                }
            }
        }
        Err("could not move it to the Trash".into())
    }
}

#[cfg(not(target_os = "macos"))]
fn trash(_path: &Path) -> Result<(), String> {
    Err("no Trash on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The one check that decides what "rename" means. Everything it lets
    /// through stays in the folder it started in.
    #[test]
    fn names_are_one_component() {
        assert!(check_name("api.ts").is_ok());
        assert!(check_name(".gitignore").is_ok());
        for bad in ["", ".", "..", "a/b", "..\\b", "a\0b"] {
            assert!(check_name(bad).is_err(), "{bad:?} should be refused");
        }
    }

    /// Nothing here overwrites, and a duplicate keeps its extension so the copy
    /// is still the kind of file the original was.
    #[test]
    fn duplicates_count_and_keep_the_extension() {
        let dir = scratch("zero-files-dup");
        std::fs::write(dir.join("api.ts"), "x").unwrap();

        let one = duplicate_entry(dir.join("api.ts").to_string_lossy().into()).unwrap();
        assert!(one.ends_with("/api copy.ts"), "{one}");
        let two = duplicate_entry(dir.join("api.ts").to_string_lossy().into()).unwrap();
        assert!(two.ends_with("/api copy 2.ts"), "{two}");

        // a dotfile's dot isn't an extension
        std::fs::write(dir.join(".gitignore"), "x").unwrap();
        let dot = duplicate_entry(dir.join(".gitignore").to_string_lossy().into()).unwrap();
        assert!(dot.ends_with("/.gitignore copy"), "{dot}");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn creating_and_renaming_never_clobber() {
        let dir = scratch("zero-files-new");
        let d = dir.to_string_lossy().to_string();

        let made = create_entry(d.clone(), "one.ts".into(), false).unwrap();
        assert!(Path::new(&made).is_file());
        assert!(
            create_entry(d.clone(), "one.ts".into(), false).is_err(),
            "a second file of the same name would replace the first"
        );

        std::fs::write(dir.join("two.ts"), "x").unwrap();
        assert!(
            rename_entry(made.clone(), "two.ts".into()).is_err(),
            "renaming onto an existing file would lose it"
        );

        let moved = rename_entry(made, "three.ts".into()).unwrap();
        assert!(moved.ends_with("/three.ts"));
        assert!(dir.join("three.ts").is_file());
        assert!(!dir.join("one.ts").exists());

        // …and fixing only the case of a name is still allowed, though on this
        // filesystem the two names are one file
        let cased = rename_entry(moved, "Three.ts".into()).unwrap();
        assert!(cased.ends_with("/Three.ts"));

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
