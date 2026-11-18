use serde::Serialize;
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Mutex};
use tauri::{AppHandle, Manager, Url, Webview, ipc::Channel};

const INVOKE: &[&str] = &[
    "agent-threads-children",
    "agent-threads-clear",
    "agent-threads-file",
    "agent-threads-list",
    "agent-threads-memory",
    "agent-threads-read",
    "agent-threads-update",
    "billy-available",
    "billy-claims",
    "billy-contract",
    "billy-lane-checks",
    "billy-lane-log",
    "billy-lanes",
    "billy-pick-replay",
    "billy-playbook",
    "billy-replay-case",
    "billy-setup-run",
    "billy-setup-status",
    "billy-siblings",
    "capture-checkpoint",
    "claude-apply",
    "claude-cancel",
    "claude-discard",
    "claude-remove-key",
    "claude-reset",
    "claude-save-key",
    "claude-send",
    "claude-status",
    "content-search",
    "content-search-cancel",
    "directory-expanded",
    "document",
    "file-action",
    "files",
    "files-delta",
    "git-changes",
    "git-contents",
    "git-overview",
    "howmany-analyze",
    "howmany-close",
    "howmany-export",
    "howmany-file",
    "ideas-delete",
    "ideas-list",
    "ideas-upsert",
    "language-cancel",
    "language-close",
    "language-open",
    "language-request",
    "language-status",
    "media",
    "onboarding-enter",
    "onboarding-save",
    "open-external",
    "open-file",
    "open-folder",
    "open-recent",
    "preferences-get",
    "preferences-set",
    "recent-targets",
    "refresh",
    "rename",
    "restart-workspace",
    "review-notes-change",
    "review-notes-copy",
    "review-notes-list",
    "save",
    "shortcuts-capture",
    "shortcuts-get",
    "shortcuts-reset",
    "shortcuts-set",
    "snapshot",
    "terminal-toggle",
    "workspaces-close",
    "workspaces-current",
    "workspaces-list",
    "workspaces-open",
    "workspaces-pick-folders",
    "workspaces-remove",
    "workspaces-save",
    "workspaces-switch-folder",
];

const SEND: &[&str] = &[
    "file-menu-actions",
    "onboarding-release",
    "preload-diagnostic",
    "renderer-diagnostic",
    "renderer-ready",
    "save-state",
    "saves-flushed",
    "shortcuts-modal",
    "terminal-layout",
    "workspaces-remember-file",
];
const TERMINAL_INVOKE: &[&str] = &["terminal-ready", "terminal-start", "terminal-stop"];
const TERMINAL_SEND: &[&str] = &[
    "terminal-input",
    "terminal-resize",
    "terminal-ack",
    "terminal-hide",
];
const TERMINAL_FOCUS: &[&str] = &["terminal-start", "terminal-stop", "terminal-input"];

#[derive(Default)]
pub(in crate::host) struct Connections(Mutex<HashMap<String, Channel<RendererEvent>>>);

pub(in crate::host) fn workspace(label: &str) -> bool {
    numbered_label(label, "workspace-")
}

pub(in crate::host) fn terminal(label: &str) -> bool {
    numbered_label(label, "terminal-")
}

fn numbered_label(label: &str, prefix: &str) -> bool {
    label.strip_prefix(prefix).is_some_and(|suffix| {
        suffix
            .as_bytes()
            .first()
            .is_some_and(|first| matches!(first, b'1'..=b'9'))
            && suffix.bytes().all(|digit| digit.is_ascii_digit())
    })
}

pub(in crate::host) fn origin(app: &AppHandle) -> String {
    if tauri::is_dev() {
        if let Some(url) = &app.config().build.dev_url {
            return url.origin().ascii_serialization();
        }
    }
    if cfg!(target_os = "windows") {
        "http://tauri.localhost".into()
    } else {
        "tauri://localhost".into()
    }
}

pub(in crate::host) fn workspace_url(origin: &str, url: &Url) -> bool {
    let Some(suffix) = url.as_str().strip_prefix(origin) else {
        return false;
    };
    matches!(suffix, "" | "/" | "/index.html")
}

#[tauri::command]
pub(in crate::host) async fn desktop_connect(
    webview: Webview,
    events: Channel<RendererEvent>,
) -> Result<(), String> {
    let app = webview.app_handle();
    let url = webview
        .url()
        .map_err(|_| "The app could not verify this view.")?;
    let label = webview.label();
    let allowed = workspace(label) && workspace_url(&origin(app), &url)
        || terminal(label) && crate::terminal::allows_url(app, &url);
    if !allowed {
        return Err("This desktop bridge is unavailable in this view.".into());
    }
    app.state::<Connections>()
        .0
        .lock()
        .expect("desktop connection registry")
        .insert(label.to_owned(), events);
    Ok(())
}

pub(in crate::host) fn disconnect(app: &AppHandle, label: &str) {
    app.state::<Connections>()
        .0
        .lock()
        .expect("desktop connection registry")
        .remove(label);
}

#[tauri::command]
pub(in crate::host) async fn desktop_shortcut_prefix(
    webview: Webview,
    pending: bool,
) -> Result<(), String> {
    let app = webview.app_handle();
    let url = webview
        .url()
        .map_err(|_| "The app could not verify this view.")?;
    let label = webview.label();
    if !workspace(label) || !workspace_url(&origin(app), &url) {
        return Err("This desktop operation is unavailable in this view.".into());
    }
    super::menu::chord_prefix(app, label.to_owned(), pending).await
}

#[tauri::command]
pub(in crate::host) async fn desktop_invoke(
    webview: Webview,
    channel: String,
    args: Vec<Value>,
    undefined_args: Option<Vec<usize>>,
) -> Result<Value, String> {
    route(webview, channel, args, undefined_args, true).await
}

#[tauri::command]
pub(in crate::host) async fn desktop_send(
    webview: Webview,
    channel: String,
    args: Vec<Value>,
    undefined_args: Option<Vec<usize>>,
) -> Result<(), String> {
    route(webview, channel, args, undefined_args, false).await?;
    Ok(())
}

async fn route(
    webview: Webview,
    channel: String,
    args: Vec<Value>,
    undefined_args: Option<Vec<usize>>,
    invoke: bool,
) -> Result<Value, String> {
    let app = webview.app_handle();
    let url = webview
        .url()
        .map_err(|_| "The app could not verify this view.")?;
    let label = webview.label();
    let allowed = if workspace(label) {
        workspace_url(&origin(app), &url)
            && if invoke { INVOKE } else { SEND }.contains(&channel.as_str())
    } else if terminal(label) {
        crate::terminal::allows_url(app, &url)
            && if invoke {
                TERMINAL_INVOKE
            } else {
                TERMINAL_SEND
            }
            .contains(&channel.as_str())
            && (!TERMINAL_FOCUS.contains(&channel.as_str())
                || crate::terminal::is_focused(&webview).await)
    } else {
        false
    };
    if !allowed {
        return Err("This desktop operation is unavailable in this view.".into());
    }
    let undefined_args = undefined_args.unwrap_or_default();
    if undefined_args.len() > args.len()
        || undefined_args
            .iter()
            .any(|&index| !args.get(index).is_some_and(Value::is_null))
    {
        return Err("The desktop operation has invalid arguments.".into());
    }
    let method = if invoke { "invoke" } else { "send" };
    super::sidecar(app)?
        .request(
            method,
            vec![
                json!(label),
                json!(channel),
                json!(args),
                json!(undefined_args),
            ],
        )
        .await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::host) struct RendererEvent {
    pub channel: String,
    pub args: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub undefined_args: Option<Vec<usize>>,
}

pub(in crate::host) fn emit(app: &AppHandle, label: &str, event: RendererEvent) {
    let state = app.state::<Connections>();
    let channel = state
        .0
        .lock()
        .expect("desktop connection registry")
        .get(label)
        .cloned();
    if let Some(channel) = channel {
        let _ = channel.send(event);
    }
}

#[cfg(test)]
#[path = "bridge_tests.rs"]
mod tests;
