mod focus;
mod prompt;

use std::{
    collections::HashMap,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Rect, Url, Webview, WebviewUrl, Window,
    webview::{Color, NewWindowResponse, WebviewBuilder},
};

pub(crate) use focus::is_focused;

const PAGE: &str = "terminal.html";

#[derive(Clone, Copy)]
struct Layout {
    height: f64,
    bottom: f64,
}

struct Dock {
    owner: String,
    layout: Option<Layout>,
}

#[derive(Default)]
struct LayoutState {
    docks: HashMap<String, Dock>,
    zoom: HashMap<String, f64>,
}

#[derive(Default)]
pub(crate) struct TerminalLayouts {
    layouts: Mutex<LayoutState>,
    confirmations: prompt::Confirmations,
}

pub(crate) async fn native_request(
    app: &AppHandle,
    method: &str,
    args: Vec<Value>,
) -> Result<Value, String> {
    match method {
        "terminal.create" => {
            let (owner, label): (String, String) = arguments(args)?;
            create(app, &owner, &label)?;
        }
        "terminal.layout" => {
            let (label, height, bottom, color, focus): (
                String,
                Option<f64>,
                Option<f64>,
                String,
                bool,
            ) = arguments(args)?;
            let layout = match (height, bottom) {
                (Some(height), Some(bottom))
                    if height > 0.0 && height <= 600.0 && (0.0..=86.0).contains(&bottom) =>
                {
                    Some(Layout { height, bottom })
                }
                (None, None) => None,
                _ => return Err("Invalid terminal layout.".into()),
            };
            set_layout(app, &label, layout, color_from_hex(&color)?, focus).await?;
        }
        "terminal.is-focused" => {
            let (label,): (String,) = arguments(args)?;
            return Ok(json!(is_focused(&get(app, &label)?).await));
        }
        "terminal.close" => {
            let (label,): (String,) = arguments(args)?;
            close(app, &label).await?;
        }
        "terminal.confirm" => {
            let (owner, id, copy): (String, u64, prompt::Prompt) = arguments(args)?;
            return Ok(json!(prompt::show(app, owner, id, copy).await?));
        }
        "terminal.cancel-confirmation" => {
            let (owner, id): (String, u64) = arguments(args)?;
            prompt::cancel(app, owner, id);
        }
        _ => return Err("Unknown terminal operation.".into()),
    }
    Ok(Value::Null)
}

fn arguments<T: DeserializeOwned>(args: Vec<Value>) -> Result<T, String> {
    serde_json::from_value(Value::Array(args)).map_err(|error| error.to_string())
}

fn terminal_label(label: &str) -> bool {
    label.strip_prefix("terminal-").is_some_and(|suffix| {
        !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
    })
}

pub(crate) fn allows_url(app: &AppHandle, url: &Url) -> bool {
    let origin_ok = app
        .config()
        .build
        .dev_url
        .as_ref()
        .filter(|_| tauri::is_dev())
        .map_or_else(
            || {
                #[cfg(any(target_os = "windows", target_os = "android"))]
                return matches!(url.scheme(), "http" | "https")
                    && url.host_str() == Some("tauri.localhost")
                    && url.port().is_none();
                #[cfg(not(any(target_os = "windows", target_os = "android")))]
                return url.scheme() == "tauri"
                    && url.host_str() == Some("localhost")
                    && url.port().is_none();
            },
            |development| url.origin() == development.origin(),
        );
    origin_ok
        && url.path() == "/terminal.html"
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

fn get(app: &AppHandle, label: &str) -> Result<Webview, String> {
    if terminal_label(label)
        && let Some(webview) = app.get_webview(label)
    {
        return Ok(webview);
    }
    Err("The terminal view is unavailable.".into())
}

fn create(app: &AppHandle, owner: &str, label: &str) -> Result<(), String> {
    if !terminal_label(label)
        || !owner.starts_with("workspace-")
        || app.get_webview(label).is_some()
    {
        return Err("Invalid terminal view.".into());
    }
    let window = app
        .get_window(owner)
        .ok_or("The terminal workspace is unavailable.")?;
    let app_handle = app.clone();
    let navigated = AtomicBool::new(false);
    let builder = WebviewBuilder::new(label, WebviewUrl::App(PAGE.into()))
        .incognito(true)
        .focused(false)
        .disable_drag_drop_handler()
        .devtools(false)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .on_navigation(move |url| {
            allows_url(&app_handle, url) && !navigated.swap(true, Ordering::AcqRel)
        });
    let view = window
        .add_child(
            builder,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|error| error.to_string())?;
    if let Err(error) = view.hide() {
        let _ = view.close();
        return Err(error.to_string());
    }
    app.state::<TerminalLayouts>()
        .layouts
        .lock()
        .map_err(|error| error.to_string())?
        .docks
        .insert(
            label.to_owned(),
            Dock {
                owner: owner.to_owned(),
                layout: None,
            },
        );
    Ok(())
}

async fn set_layout(
    app: &AppHandle,
    label: &str,
    layout: Option<Layout>,
    background: Color,
    focus: bool,
) -> Result<(), String> {
    let view = get(app, label)?;
    let zoom = {
        let state = app.state::<TerminalLayouts>();
        let mut placements = state.layouts.lock().map_err(|error| error.to_string())?;
        placements
            .docks
            .get_mut(label)
            .ok_or("The terminal view is unavailable.")?
            .layout = layout;
        placements
            .zoom
            .get(view.window().label())
            .copied()
            .unwrap_or(1.0)
    };
    view.set_background_color(Some(background))
        .map_err(|error| error.to_string())?;
    if let Some(layout) = layout {
        place(&view, layout, zoom).map_err(|error| error.to_string())?;
        view.show().map_err(|error| error.to_string())?;
        if focus && view.window().is_focused().unwrap_or(false) {
            view.set_focus().map_err(|error| error.to_string())?;
        }
    } else {
        restore_focus(app, &view).await;
        view.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn reposition(window: &Window) {
    let app = window.app_handle();
    let stored = app.state::<TerminalLayouts>();
    let Ok(placements) = stored.layouts.lock() else {
        return;
    };
    let zoom = placements.zoom.get(window.label()).copied().unwrap_or(1.0);
    let active: Vec<_> = placements
        .docks
        .iter()
        .filter_map(|(label, dock)| {
            (dock.owner == window.label()).then_some((label.clone(), dock.layout?))
        })
        .collect();
    drop(placements);
    for (label, layout) in active {
        if let Ok(view) = get(app, &label) {
            let _ = place(&view, layout, zoom);
        }
    }
}

pub(crate) fn set_workspace_zoom(window: &Window, zoom: f64) {
    let stored = window.app_handle().state::<TerminalLayouts>();
    if let Ok(mut placements) = stored.layouts.lock() {
        placements.zoom.insert(window.label().to_owned(), zoom);
    }
    reposition(window);
}

pub(crate) fn forget_workspace(window: &Window) {
    let stored = window.app_handle().state::<TerminalLayouts>();
    prompt::forget(&stored.confirmations, window.label());
    if let Ok(mut placements) = stored.layouts.lock() {
        placements.zoom.remove(window.label());
        placements
            .docks
            .retain(|_, dock| dock.owner != window.label());
    }
}

fn place(view: &Webview, layout: Layout, zoom: f64) -> tauri::Result<()> {
    let window = view.window();
    let size = window
        .inner_size()?
        .to_logical::<f64>(window.scale_factor()?);
    let height = (layout.height * zoom)
        .round()
        .max(1.0)
        .min((size.height * 0.48).floor().max(1.0));
    let bottom = (layout.bottom * zoom).round().min(86.0);
    let y = (size.height - height - bottom).max(0.0);
    view.set_bounds(Rect {
        position: LogicalPosition::new(0.0, y).into(),
        size: LogicalSize::new(size.width.max(1.0), height).into(),
    })
}

async fn close(app: &AppHandle, label: &str) -> Result<(), String> {
    app.state::<TerminalLayouts>()
        .layouts
        .lock()
        .map_err(|error| error.to_string())?
        .docks
        .remove(label);
    if let Ok(view) = get(app, label) {
        restore_focus(app, &view).await;
        view.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

async fn restore_focus(app: &AppHandle, view: &Webview) {
    if is_focused(view).await
        && let Some(owner) = app.get_webview(view.window().label())
    {
        let _ = owner.set_focus();
    }
}

fn color_from_hex(hex: &str) -> Result<Color, String> {
    let parsed = hex
        .strip_prefix('#')
        .filter(|value| value.len() == 6 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .and_then(|value| u32::from_str_radix(value, 16).ok())
        .ok_or("Invalid terminal background color.")?;
    Ok(Color(
        (parsed >> 16) as u8,
        (parsed >> 8) as u8,
        parsed as u8,
        255,
    ))
}
