use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent,
    webview::{Color, NewWindowResponse, PageLoadEvent},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Options {
    title: String,
    width: f64,
    height: f64,
    min_width: f64,
    min_height: f64,
    background_color: String,
}

fn color(input: &str) -> Result<Color, String> {
    let hex = input
        .strip_prefix('#')
        .ok_or("Invalid window background color.")?;
    if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid window background color.".into());
    }
    let value = u32::from_str_radix(hex, 16).map_err(|error| error.to_string())?;
    Ok(Color(
        (value >> 16) as u8,
        (value >> 8) as u8,
        value as u8,
        255,
    ))
}

fn create(app: &AppHandle, label: String, options: Options) -> Result<(), String> {
    let origin = super::bridge::origin(app);
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(options.title)
        .inner_size(options.width, options.height)
        .min_inner_size(options.min_width, options.min_height)
        .background_color(color(&options.background_color)?)
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            // WebKit also applies this policy to the PDF preview's embedded frame.
            super::bridge::workspace_url(&origin, url) || matches!(url.scheme(), "blob")
        })
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .on_page_load(|window, page| {
            if page.event() == PageLoadEvent::Started {
                super::bridge::disconnect(window.app_handle(), window.label());
                super::event(
                    window.app_handle(),
                    "window.navigation",
                    vec![json!(window.label())],
                );
            }
        });
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(20_f64, 10_f64));
    builder.build().map_err(|error| error.to_string())?;
    Ok(())
}

pub(in crate::host) async fn request(
    app: &AppHandle,
    method: &str,
    args: Vec<Value>,
) -> Result<Value, String> {
    let label = args
        .first()
        .and_then(Value::as_str)
        .ok_or("Invalid workspace view.")?;
    if !super::bridge::workspace(label) {
        return Err("Invalid workspace view.".into());
    }
    if method == "window.create" {
        let (label, options) = super::decode(args)?;
        create(app, label, options)?;
        return Ok(Value::Null);
    }
    // Docking a second view turns this into a compound Tauri window.
    let window = app
        .get_window(label)
        .ok_or("The workspace window closed.")?;
    let result = match method {
        "window.close" => window.destroy(),
        "window.focus" => window
            .unminimize()
            .and_then(|_| window.show())
            .and_then(|_| window.set_focus()),
        "window.reload" => app
            .get_webview(label)
            .ok_or("The workspace editor closed.")?
            .reload(),
        "window.shortcuts" => {
            let (label, ignored) = super::decode(args)?;
            super::menu::shortcut_mode(app, label, ignored).await?;
            return Ok(Value::Null);
        }
        _ => return Err("Unknown window operation.".into()),
    };
    result.map_err(|error| error.to_string())?;
    Ok(Value::Null)
}

pub(in crate::host) fn focused(app: &AppHandle) -> Option<Window> {
    app.windows().into_values().find(|window| {
        super::bridge::workspace(window.label()) && window.is_focused().unwrap_or(false)
    })
}

pub(in crate::host) fn event(window: &Window, event: &WindowEvent) {
    let label = window.label();
    if !super::bridge::workspace(label) {
        return;
    }
    let app = window.app_handle();
    match event {
        WindowEvent::CloseRequested { api, .. } if super::sidecar(app).is_ok() => {
            api.prevent_close();
            super::event(app, "window.close-requested", vec![json!(label)]);
        }
        WindowEvent::Destroyed => {
            super::bridge::disconnect(app, label);
            super::menu::forget_window(app, label);
            crate::terminal::forget_workspace(window);
            super::event(app, "window.closed", vec![json!(label)]);
        }
        WindowEvent::Resized(_) => crate::terminal::reposition(window),
        WindowEvent::Focused(focused) => {
            super::event(app, "window.focused", vec![json!(label), json!(focused)]);
            super::menu::focus_changed(app);
        }
        _ => {}
    }
}

#[cfg(target_os = "macos")]
pub(in crate::host) fn process_terminated(webview: &tauri::Webview) {
    let app = webview.app_handle();
    let label = webview.label();
    super::bridge::disconnect(app, label);
    if super::bridge::workspace(label) {
        super::event(
            app,
            "window.crashed",
            vec![json!(label), json!("terminated")],
        );
    } else if super::bridge::terminal(label) {
        super::event(app, "terminal.closed", vec![json!(label)]);
    }
}
