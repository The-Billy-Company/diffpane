use serde::Serialize;
use serde_json::{Map, Value};
use std::{
    env,
    ffi::OsString,
    io,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const ENTRY: &str = "app/desktop/host/entry.ts";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::host) struct Paths {
    pub version: String,
    pub app_path: PathBuf,
    pub resources_path: PathBuf,
    pub profile_path: PathBuf,
    pub logs_path: PathBuf,
    pub targets: Vec<PathBuf>,
    pub media_origin: Option<String>,
    pub legacy_preferences: Map<String, Value>,
    pub is_packaged: bool,
    #[serde(skip)]
    pub node: PathBuf,
}

impl Paths {
    pub(in crate::host) fn new(app: &AppHandle) -> tauri::Result<Self> {
        let app_bundle = env::current_exe()
            .ok()
            .and_then(|executable| executable.canonicalize().ok())
            .as_deref()
            .and_then(bundle_resources);
        let packaged_resources = app
            .path()
            .resource_dir()
            .ok()
            .into_iter()
            .chain(app_bundle.clone())
            .find(|resources| resources.join("backend").join(ENTRY).is_file());
        let packaged = packaged_resources.is_some();
        let (app_path, resources_path, node) = if let Some(resources) = packaged_resources {
            let backend = resources.join("backend");
            let node = backend.join("bin/node");
            if !node.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "Diffpane's bundled Node.js runtime is missing.",
                )
                .into());
            }
            (backend, resources, node)
        } else {
            if app_bundle.is_some() && !tauri::is_dev() {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "Diffpane's bundled workspace service is missing.",
                )
                .into());
            }
            let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .canonicalize()?;
            if !repo.join(ENTRY).is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "The Diffpane workspace service is missing from the source checkout.",
                )
                .into());
            }
            let node = env::var_os("DIFFPANE_NODE").unwrap_or_else(|| OsString::from("node"));
            (repo.clone(), repo, PathBuf::from(node))
        };
        let home = app.path().home_dir()?;
        let (profile_path, logs_path) = if cfg!(target_os = "macos") {
            (
                home.join("Library/Application Support/Diffpane"),
                home.join("Library/Logs/Diffpane"),
            )
        } else {
            let profile = app.path().data_dir()?.join("Diffpane");
            let logs = profile.join("logs");
            (profile, logs)
        };
        let cwd = env::current_dir().unwrap_or_else(|_| app_path.clone());
        let targets = env::args_os()
            .skip(1)
            .filter(|arg| !arg.to_string_lossy().starts_with('-'))
            .take(1)
            .map(|arg| cwd.join(arg))
            .collect();
        Ok(Self {
            app_path,
            resources_path,
            profile_path: env::var_os("DIFFPANE_PROFILE_DIR")
                .map(PathBuf::from)
                .unwrap_or(profile_path),
            logs_path: env::var_os("DIFFPANE_LOGS_DIR")
                .map(PathBuf::from)
                .unwrap_or(logs_path),
            targets,
            version: app.package_info().version.to_string(),
            media_origin: None,
            legacy_preferences: Map::new(),
            is_packaged: packaged,
            node,
        })
    }

    pub(in crate::host) fn entry(&self) -> PathBuf {
        self.app_path.join(ENTRY)
    }
}

fn bundle_resources(executable: &Path) -> Option<PathBuf> {
    let platform_binary = executable.parent()?;
    let contents = platform_binary.parent()?;
    let app = contents.parent()?;
    (platform_binary.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && app.extension()? == "app")
        .then(|| contents.join("Resources"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_packaged_resources_independently_of_tauri_path_resolution() {
        assert_eq!(
            bundle_resources(Path::new(
                "/Applications/Diffpane.app/Contents/MacOS/Diffpane"
            )),
            Some(PathBuf::from(
                "/Applications/Diffpane.app/Contents/Resources"
            ))
        );
        assert_eq!(
            bundle_resources(Path::new("/src/target/debug/Diffpane")),
            None
        );
    }
}
