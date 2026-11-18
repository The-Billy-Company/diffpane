use std::{
    ffi::CString,
    fs::{Metadata, symlink_metadata},
    io::{self, ErrorKind},
    os::unix::fs::MetadataExt,
    path::Path,
};

use objc2::rc::autoreleasepool;
use objc2_foundation::{NSFileManager, NSString, NSURL};
use serde_json::{Value, json};

fn identity(metadata: &Metadata) -> String {
    format!("{}:{}", metadata.dev(), metadata.ino())
}

pub(super) fn move_to_trash(path: &str, expected_identity: Option<&str>) -> Result<Value, String> {
    if !Path::new(path).is_absolute() || path.contains('\0') {
        return Err("Invalid path to move to Trash.".into());
    }
    let metadata = symlink_metadata(path).map_err(|error| error.to_string())?;
    let identity = identity(&metadata);
    if expected_identity.is_some_and(|expected| expected != identity) {
        return Err("This file or folder has changed since it was restored from Trash.".into());
    }

    autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(path), metadata.is_dir());
        let mut resulting_url = None;
        NSFileManager::defaultManager()
            .trashItemAtURL_resultingItemURL_error(&url, Some(&mut resulting_url))
            .map_err(|error| error.localizedDescription().to_string())?;
        let trashed_path = resulting_url
            .and_then(|url| url.path())
            .ok_or("macOS did not return the location of the item in Trash.")?;
        Ok(json!({ "path": trashed_path.to_string(), "identity": identity }))
    })
}

pub(super) fn restore(
    path: &str,
    destination: &str,
    expected_identity: &str,
) -> Result<(), String> {
    let invalid_path = "Invalid path to restore from Trash.";
    if !Path::new(path).is_absolute() || !Path::new(destination).is_absolute() {
        return Err(invalid_path.into());
    }
    let source = CString::new(path).map_err(|_| invalid_path)?;
    let destination = CString::new(destination).map_err(|_| invalid_path)?;
    let metadata = symlink_metadata(path).map_err(|error| match error.kind() {
        ErrorKind::NotFound => "This file or folder is no longer in Trash.".to_owned(),
        _ => error.to_string(),
    })?;
    if identity(&metadata) != expected_identity {
        return Err("This file or folder has changed since it was moved to Trash.".into());
    }

    // Both pointers are valid NUL-terminated paths. RENAME_EXCL checks that the
    // destination does not exist as part of the move and preserves symbolic links.
    if unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    match error.kind() {
        ErrorKind::AlreadyExists => Err("A file or folder with that name already exists.".into()),
        _ => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::symlink};

    #[test]
    fn restore_checks_identity_and_preserves_existing_entries_and_symbolic_links() {
        let directory = tempfile::tempdir().unwrap();
        let trashed = directory.path().join("trashed");
        let destination = directory.path().join("restored");
        let link_target = Path::new("missing");
        symlink(link_target, &trashed).unwrap();
        fs::write(&destination, b"replacement").unwrap();
        let source = trashed.to_str().unwrap();
        let target = destination.to_str().unwrap();
        let original_identity = identity(&fs::symlink_metadata(&trashed).unwrap());

        assert!(
            restore(source, target, "0:0")
                .unwrap_err()
                .contains("has changed")
        );
        assert_eq!(
            restore(source, target, &original_identity).unwrap_err(),
            "A file or folder with that name already exists."
        );
        assert_eq!(fs::read(&destination).unwrap(), b"replacement");
        fs::remove_file(&destination).unwrap();
        restore(source, target, &original_identity).unwrap();

        assert_eq!(fs::read_link(destination).unwrap(), link_target);
        assert!(fs::symlink_metadata(trashed).is_err());
    }
}
