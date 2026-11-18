use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};
use tauri::{
    AppHandle, Manager,
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu},
};
use tokio::sync::Mutex;
use tokio::time::Instant;

const CLOSE: &str = "native-close";
const QUIT: &str = "native-quit";
const DEVTOOLS: &str = "native-devtools";
const ZOOM_IN: &str = "native-zoom-in";
const ZOOM_OUT: &str = "native-zoom-out";
const ZOOM_RESET: &str = "native-zoom-reset";
const CHORD_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Deserialize)]
struct Item {
    id: Option<String>,
    label: Option<String>,
    role: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    accelerator: Option<String>,
    enabled: Option<bool>,
    visible: Option<bool>,
    submenu: Option<Vec<Item>>,
}

#[derive(Deserialize, PartialEq, Eq)]
struct ItemState {
    id: String,
    enabled: bool,
    visible: bool,
}

#[derive(Default)]
pub(in crate::host) struct Menus {
    template: Vec<Item>,
    overrides: Vec<ItemState>,
    ignore_shortcuts: HashSet<String>,
    pending_chords: HashMap<String, Instant>,
    active_ignored: bool,
    zoom: HashMap<String, f64>,
}

pub(in crate::host) async fn request(
    app: &AppHandle,
    method: &str,
    args: Vec<Value>,
) -> Result<Value, String> {
    let state = app.state::<Mutex<Menus>>();
    let mut menu = state.lock().await;
    match method {
        "menu.set" => {
            let (template,) = super::decode(args)?;
            menu.template = template;
        }
        "menu.state" => {
            let (overrides,) = super::decode(args)?;
            if menu.overrides == overrides {
                return Ok(Value::Null);
            }
            menu.overrides = overrides;
        }
        _ => return Err("Unknown menu request.".into()),
    }
    install(app, &menu).map_err(|error| error.to_string())?;
    Ok(Value::Null)
}

fn install(app: &AppHandle, state: &Menus) -> tauri::Result<()> {
    let menu = Menu::new(app)?;
    for item in &state.template {
        if let Some(children) = &item.submenu {
            let label = item.label.as_deref().unwrap_or("Help");
            let submenu = submenu(app, label, children, state)?;
            menu.append(&submenu)?;
            #[cfg(target_os = "macos")]
            {
                if label == "Window" {
                    submenu.set_as_windows_menu_for_nsapp()?;
                }
                if item.role.as_deref() == Some("help") {
                    submenu.set_as_help_menu_for_nsapp()?;
                }
            }
        }
    }
    app.set_menu(menu)?;
    Ok(())
}

fn submenu(
    app: &AppHandle,
    label: &str,
    entries: &[Item],
    state: &Menus,
) -> tauri::Result<Submenu<tauri::Wry>> {
    let menu = Submenu::new(app, label, true)?;
    for entry in entries {
        let update = entry
            .id
            .as_ref()
            .and_then(|id| state.overrides.iter().find(|item| item.id == *id));
        let visible = update
            .map(|item| item.visible)
            .or(entry.visible)
            .unwrap_or(true);
        if !visible {
            continue;
        }
        if entry.kind.as_deref() == Some("separator") {
            menu.append(&PredefinedMenuItem::separator(app)?)?;
            continue;
        }
        if let (Some(label), Some(children)) = (&entry.label, &entry.submenu) {
            menu.append(&submenu(app, label, children, state)?)?;
            continue;
        }
        let role = entry.role.as_deref();
        if let Some(item) = role
            .map(|role| native_item(app, role, entry.label.as_deref()))
            .transpose()?
            .flatten()
        {
            menu.append(&item)?;
            continue;
        }
        let (id, label, fallback) = match role {
            Some("close") => (CLOSE, "Close Window", None),
            Some("quit") => (QUIT, "Quit Diffpane", Some("CmdOrCtrl+Q")),
            Some("toggleDevTools") => (DEVTOOLS, "Toggle Developer Tools", Some("CmdOrCtrl+Alt+I")),
            Some("zoomIn") => (ZOOM_IN, "Zoom In", Some("CmdOrCtrl+Plus")),
            Some("zoomOut") => (ZOOM_OUT, "Zoom Out", Some("CmdOrCtrl+Minus")),
            Some("resetZoom") => (ZOOM_RESET, "Actual Size", Some("CmdOrCtrl+0")),
            _ => match (&entry.id, &entry.label) {
                (Some(id), Some(label)) => (id.as_str(), label.as_str(), None),
                _ => continue,
            },
        };
        let enabled = update
            .map(|item| item.enabled)
            .or(entry.enabled)
            .unwrap_or(true);
        let accelerator = if state.active_ignored {
            None
        } else {
            entry.accelerator.as_deref().or(fallback)
        };
        let create = |accelerator| MenuItem::with_id(app, id, label, enabled, accelerator);
        let item = create(accelerator).or_else(|error| {
            // Some portable bindings have no native equivalent. Keep the menu operation available.
            if accelerator.is_some() {
                create(None::<&str>)
            } else {
                Err(error)
            }
        })?;
        menu.append(&item)?;
    }
    Ok(menu)
}

fn native_item(
    app: &AppHandle,
    role: &str,
    label: Option<&str>,
) -> tauri::Result<Option<PredefinedMenuItem<tauri::Wry>>> {
    let item = match role {
        "about" => PredefinedMenuItem::about(app, label, None),
        "hide" => PredefinedMenuItem::hide(app, label),
        "hideOthers" => PredefinedMenuItem::hide_others(app, label),
        "unhide" => PredefinedMenuItem::show_all(app, label),
        "undo" => PredefinedMenuItem::undo(app, label),
        "redo" => PredefinedMenuItem::redo(app, label),
        "cut" => PredefinedMenuItem::cut(app, label),
        "copy" => PredefinedMenuItem::copy(app, label),
        "paste" => PredefinedMenuItem::paste(app, label),
        "selectAll" => PredefinedMenuItem::select_all(app, label),
        "togglefullscreen" => PredefinedMenuItem::fullscreen(app, label),
        "minimize" => PredefinedMenuItem::minimize(app, label),
        "zoom" => PredefinedMenuItem::maximize(app, label),
        _ => return Ok(None),
    };
    item.map(Some)
}

pub(in crate::host) async fn shortcut_mode(
    app: &AppHandle,
    label: String,
    ignored: bool,
) -> Result<(), String> {
    let state = app.state::<Mutex<Menus>>();
    let mut menu = state.lock().await;
    if ignored {
        menu.ignore_shortcuts.insert(label);
    } else {
        menu.ignore_shortcuts.remove(&label);
    }
    install_shortcut_mode(app, &mut menu).map_err(|error| error.to_string())
}

pub(in crate::host) async fn chord_prefix(
    app: &AppHandle,
    label: String,
    pending: bool,
) -> Result<(), String> {
    let expires = Instant::now() + CHORD_TIMEOUT;
    {
        let state = app.state::<Mutex<Menus>>();
        let mut menu = state.lock().await;
        if pending {
            menu.pending_chords.insert(label.clone(), expires);
        } else {
            menu.pending_chords.remove(&label);
        }
        install_shortcut_mode(app, &mut menu).map_err(|error| error.to_string())?;
    }
    if pending {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep_until(expires).await;
            let state = app.state::<Mutex<Menus>>();
            let mut menu = state.lock().await;
            if menu.pending_chords.get(&label) == Some(&expires) {
                menu.pending_chords.remove(&label);
                if let Err(error) = install_shortcut_mode(&app, &mut menu) {
                    eprintln!("Diffpane could not restore its menu shortcuts: {error}");
                }
            }
        });
    }
    Ok(())
}

pub(in crate::host) fn focus_changed(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Mutex<Menus>>();
        let mut menu = state.lock().await;
        if let Err(error) = install_shortcut_mode(&app, &mut menu) {
            eprintln!("Diffpane could not update menu shortcuts: {error}");
        }
    });
}

fn install_shortcut_mode(app: &AppHandle, menu: &mut Menus) -> tauri::Result<()> {
    let ignored = super::windows::focused(app).is_some_and(|window| {
        let label = window.label();
        menu.ignore_shortcuts.contains(label)
            || menu
                .pending_chords
                .get(label)
                .is_some_and(|expires| *expires > Instant::now())
    });
    if menu.active_ignored != ignored {
        menu.active_ignored = ignored;
        install(app, menu)?;
    }
    Ok(())
}

pub(in crate::host) fn forget_window(app: &AppHandle, label: &str) {
    let app = app.clone();
    let label = label.to_owned();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Mutex<Menus>>();
        let mut menu = state.lock().await;
        menu.ignore_shortcuts.remove(&label);
        menu.pending_chords.remove(&label);
        menu.zoom.remove(&label);
    });
}

pub(in crate::host) fn click(app: &AppHandle, event: MenuEvent) {
    let id = event.id.as_ref();
    if id == QUIT {
        if super::sidecar(app).is_ok() {
            // AppKit's built-in quit selector terminates the app directly. Let the
            // workspace service save any edits and then request the native exit.
            super::event(app, "app.exit-requested", vec![]);
        } else {
            app.exit(0);
        }
    } else if matches!(id, CLOSE | DEVTOOLS | ZOOM_IN | ZOOM_OUT | ZOOM_RESET) {
        let app = app.clone();
        let id = id.to_owned();
        tauri::async_runtime::spawn(async move {
            if let Some(window) = super::windows::focused(&app) {
                match id.as_str() {
                    CLOSE => {
                        let _ = window.close();
                    }
                    DEVTOOLS => {
                        if let Some(view) = app.get_webview(window.label()) {
                            if view.is_devtools_open() {
                                view.close_devtools();
                            } else {
                                view.open_devtools();
                            }
                        }
                    }
                    _ => {
                        let state = app.state::<Mutex<Menus>>();
                        let mut menu = state.lock().await;
                        let zoom = menu.zoom.entry(window.label().to_owned()).or_insert(1.0);
                        *zoom = match id.as_str() {
                            ZOOM_IN => (*zoom * 1.2).min(3.0),
                            ZOOM_OUT => (*zoom / 1.2).max(0.5),
                            _ => 1.0,
                        };
                        if app
                            .get_webview(window.label())
                            .is_some_and(|view| view.set_zoom(*zoom).is_ok())
                        {
                            crate::terminal::set_workspace_zoom(&window, *zoom);
                        }
                    }
                }
            }
        });
    } else {
        super::event(app, "menu.click", vec![json!(id)]);
    }
}
