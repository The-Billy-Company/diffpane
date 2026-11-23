// Copyright (c) 2026 The Billy Company
use rusty_leveldb::{DB, Options};
use serde_json::{Map, Value};
use std::{
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
};

const MAX_FILES: usize = 64;
const MAX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_VALUE_BYTES: usize = 64 * 1024;

// The legacy Local Storage format prefixes each key with its serialized origin and a NUL.
// File origins are stored as "file://". String tags 1 and 0 indicate Latin-1 and UTF-16.
const KEYS: [(&str, &[u8]); 3] = [
    ("appearance", b"_file://\x00\x01diffpane.appearance"),
    ("layout", b"_file://\x00\x01diffpane.workspace-layout.v1"),
    ("ideasVisible", b"_file://\x00\x01diffpane.ideas.visible"),
];

pub(in crate::host) async fn read(profile: &Path) -> Map<String, Value> {
    let source = profile.join("Local Storage").join("leveldb");
    if !source.join("CURRENT").is_file() {
        return Map::new();
    }
    tauri::async_runtime::spawn_blocking(move || read_values(&source).unwrap_or_default())
        .await
        .unwrap_or_default()
}

fn read_values(source: &Path) -> Option<Map<String, Value>> {
    let copy = tempfile::tempdir().ok()?;
    copy_leveldb(source, copy.path()).ok()?;
    let current = fs::read_to_string(copy.path().join("CURRENT")).ok()?;
    let manifest = current.strip_suffix('\n')?;
    let sequence = manifest.strip_prefix("MANIFEST-")?;
    if !numbered(sequence) || !copy.path().join(manifest).is_file() {
        return None;
    }
    let options = Options {
        create_if_missing: false,
        paranoid_checks: true,
        ..Options::default()
    };
    let mut db = DB::open(copy.path(), options).ok()?;
    if db.get(b"VERSION").as_deref() != Some(b"1") {
        return None;
    }
    Some(
        KEYS.into_iter()
            .filter_map(|(name, key)| {
                let raw = db.get(key)?;
                let json = decode_value(&raw)?;
                Some((name.to_owned(), serde_json::from_str(&json).ok()?))
            })
            .collect(),
    )
}

fn copy_leveldb(source: &Path, output: &Path) -> io::Result<()> {
    for directory in std::iter::once(source).chain(source.parent()) {
        if !directory.symlink_metadata()?.file_type().is_dir() {
            return Err(io::ErrorKind::InvalidData.into());
        }
    }
    let mut remaining = MAX_BYTES;
    for (index, entry) in fs::read_dir(source)?.enumerate() {
        if index >= MAX_FILES {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let entry = entry?;
        let name = entry.file_name();
        if !is_database_file(&name) {
            continue;
        }
        if !entry.file_type()?.is_file() {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let input = open_source(entry.path())?;
        let length = input.metadata()?.len();
        if length > remaining {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut destination = File::create(output.join(name))?;
        let count = io::copy(&mut input.take(length + 1), &mut destination)?;
        if count != length {
            return Err(io::ErrorKind::InvalidData.into());
        }
        remaining -= length;
    }
    Ok(())
}

fn open_source(path: PathBuf) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(file)
}

fn is_database_file(name: &OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    if name == "CURRENT" {
        return true;
    }
    if let Some(suffix) = name.strip_prefix("MANIFEST-") {
        return numbered(suffix);
    }
    name.rsplit_once('.')
        .is_some_and(|(stem, suffix)| matches!(suffix, "log" | "ldb" | "sst") && numbered(stem))
}

fn numbered(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn decode_value(bytes: &[u8]) -> Option<String> {
    if bytes.len() > MAX_VALUE_BYTES {
        return None;
    }
    match bytes.split_first()? {
        (1, latin1) => Some(latin1.iter().copied().map(char::from).collect()),
        (0, utf16) if utf16.len().is_multiple_of(2) => {
            let units: Vec<_> = utf16
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            String::from_utf16(&units).ok()
        }
        _ => None,
    }
}

#[cfg(test)]
#[path = "legacy_preferences_tests.rs"]
mod tests;
