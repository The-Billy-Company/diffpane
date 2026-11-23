// Copyright (c) 2026 The Billy Company
use std::{
    io::{self, SeekFrom},
    path::{Component, PathBuf},
};

use axum::http::StatusCode;
use tokio::{
    fs::{self, File, OpenOptions},
    io::AsyncSeekExt,
};

pub(super) async fn open(root: PathBuf, path: PathBuf) -> Result<(File, u64), StatusCode> {
    if path.as_os_str().is_empty()
        || !path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(StatusCode::FORBIDDEN);
    }
    let root = fs::canonicalize(root).await.map_err(path_error)?;
    let absolute = root.join(path);
    let (Some(parent), Some(name)) = (absolute.parent(), absolute.file_name()) else {
        return Err(StatusCode::FORBIDDEN);
    };
    let parent = fs::canonicalize(parent).await.map_err(path_error)?;
    if !parent.starts_with(&root) {
        return Err(StatusCode::FORBIDDEN);
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "macos")]
    options.custom_flags(libc::O_NOFOLLOW_ANY | libc::O_NONBLOCK);
    #[cfg(all(unix, not(target_os = "macos")))]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    let file = options.open(parent.join(name)).await.map_err(path_error)?;
    let metadata = file.metadata().await.map_err(path_error)?;
    if !metadata.is_file() {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok((file, metadata.len()))
}

fn path_error(error: io::Error) -> StatusCode {
    match error.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory => StatusCode::NOT_FOUND,
        _ => StatusCode::FORBIDDEN,
    }
}

pub(super) async fn seek(file: &mut File, start: u64) -> Result<(), StatusCode> {
    if start != 0 {
        file.seek(SeekFrom::Start(start))
            .await
            .map_err(path_error)?;
    }
    Ok(())
}

pub(super) fn range(header: &str, size: u64) -> Option<(u64, u64)> {
    let (start, end) = header.strip_prefix("bytes=")?.split_once('-')?;
    let last = size.checked_sub(1)?;
    let (start, end) = if start.is_empty() {
        (size.saturating_sub(decimal(end)?), last)
    } else if end.is_empty() {
        (decimal(start)?, last)
    } else {
        (decimal(start)?, decimal(end)?.min(last))
    };
    (start <= end).then_some((start, end))
}

fn decimal(text: &str) -> Option<u64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::range;

    #[test]
    fn supports_open_closed_and_suffix_ranges() {
        assert_eq!(range("bytes=1-2", 5), Some((1, 2)));
        assert_eq!(range("bytes=1-", 5), Some((1, 4)));
        assert_eq!(range("bytes=1-9", 5), Some((1, 4)));
        assert_eq!(range("bytes=-2", 5), Some((3, 4)));
        assert_eq!(range("bytes=-9", 5), Some((0, 4)));
    }

    #[test]
    fn rejects_empty_invalid_and_unsatisfiable_ranges() {
        for invalid in [
            "bytes=-",
            "bytes=-0",
            "bytes=5-",
            "bytes=3-2",
            "bytes=+1-2",
            "bytes=1-2,3-4",
        ] {
            assert_eq!(range(invalid, 5), None, "{invalid}");
        }
        assert_eq!(range("bytes=0-", 0), None);
    }
}
