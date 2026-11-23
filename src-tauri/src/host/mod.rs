// Copyright (c) 2026 The Billy Company
mod platform;
mod wire;
mod workspace;

use platform::{
    desktop, dialogs,
    profile::{keychain, legacy_preferences, paths},
};
use workspace::{bridge, menu, windows};

use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    process::ExitStatus,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{App, AppHandle, Manager, RunEvent};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

#[derive(Default)]
struct Host {
    startup: Arc<Mutex<Startup>>,
    exiting: AtomicBool,
}

#[derive(Default)]
struct Startup {
    sidecar: Option<Arc<wire::Sidecar>>,
    pending_paths: Vec<PathBuf>,
}

pub(super) fn run() -> Result<(), Box<dyn std::error::Error>> {
    let builder = tauri::Builder::default()
        .enable_macos_default_menu(false)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Host::default())
        .manage(bridge::Connections::default())
        .manage(tokio::sync::Mutex::new(menu::Menus::default()))
        .manage(crate::terminal::TerminalLayouts::default())
        .invoke_handler(tauri::generate_handler![
            bridge::desktop_connect,
            bridge::desktop_invoke,
            bridge::desktop_send,
            bridge::desktop_shortcut_prefix
        ])
        .on_window_event(windows::event)
        .on_menu_event(menu::click)
        .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny)
        .setup(setup);
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(windows::process_terminated);
    let app = builder.build(tauri::generate_context!())?;
    app.run(run_event);
    Ok(())
}

fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let app = app.handle().clone();
    let mut paths = paths::Paths::new(&app)?;
    let entry = paths.entry();
    let startup = app.state::<Host>().startup.clone();
    let server =
        crate::media::MediaServer::start(&bridge::origin(&app), move |label, token, path| {
            let startup = startup.clone();
            async move {
                let sidecar = startup_sidecar(&startup)?;
                let response = sidecar
                    .request(
                        "media.resolve",
                        vec![json!(label), json!(token), json!(path)],
                    )
                    .await?;
                serde_json::from_str(response.get())
                    .map_err(|error| format!("Invalid desktop response: {error}"))
            }
        })?;
    paths.media_origin = Some(server.origin().to_owned());
    app.manage(server);
    tauri::async_runtime::spawn(async move {
        paths.legacy_preferences = legacy_preferences::read(&paths.profile_path).await;
        match wire::Sidecar::launch(&app, &paths.node, &entry) {
            Ok(sidecar) => {
                let host = app.state::<Host>();
                let mut startup = host.startup.lock().expect("startup state");
                paths.targets.append(&mut startup.pending_paths);
                sidecar.event("app.start", vec![json!(paths)]);
                startup.sidecar = Some(sidecar);
            }
            Err(error) => fatal(
                &app,
                format!("Diffpane could not start its workspace service.\n\n{error}"),
            ),
        }
    });
    Ok(())
}

fn run_event(app: &AppHandle, event: RunEvent) {
    match event {
        RunEvent::ExitRequested { api, .. } => {
            let host = app.state::<Host>();
            if !host.exiting.load(Ordering::Acquire) && sidecar(app).is_ok() {
                api.prevent_exit();
                self::event(app, "app.exit-requested", vec![]);
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => {
            let paths = urls.into_iter().filter_map(|url| url.to_file_path().ok());
            let host = app.state::<Host>();
            let mut startup = host.startup.lock().expect("startup state");
            if let Some(sidecar) = &startup.sidecar {
                for path in paths {
                    sidecar.event("app.open-file", vec![json!(path)]);
                }
            } else {
                startup.pending_paths.extend(paths);
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => {
            self::event(app, "app.activate", vec![]);
        }
        _ => {}
    }
}

fn sidecar(app: &AppHandle) -> Result<Arc<wire::Sidecar>, String> {
    startup_sidecar(&app.state::<Host>().startup)
}

fn startup_sidecar(startup: &Mutex<Startup>) -> Result<Arc<wire::Sidecar>, String> {
    startup
        .lock()
        .expect("startup state")
        .sidecar
        .clone()
        .ok_or_else(|| "The Diffpane workspace service is unavailable.".into())
}

fn event(app: &AppHandle, name: &str, args: Vec<Value>) {
    if let Ok(sidecar) = sidecar(app) {
        sidecar.event(name, args);
    }
}

fn sidecar_exited(app: &AppHandle, status: std::io::Result<ExitStatus>) {
    let host = app.state::<Host>();
    host.startup.lock().expect("startup state").sidecar = None;
    if host.exiting.load(Ordering::Acquire) {
        return;
    }
    let message = status
        .map(|status| status.to_string())
        .unwrap_or_else(|error| error.to_string());
    fatal(
        app,
        format!("The workspace service stopped unexpectedly.\n\n{message}"),
    );
}

fn fatal(app: &AppHandle, message: String) {
    let has_windows = !app.windows().is_empty();
    let keep_open = "Keep Windows Open";
    let quit = "Quit Diffpane";
    let message = if has_windows {
        format!("{message}\n\nYou can copy any unsaved edits from open windows before quitting.")
    } else {
        message
    };
    eprintln!("{message}");
    let app = app.clone();
    let mut dialog = app
        .dialog()
        .message(message)
        .title("Diffpane")
        .kind(MessageDialogKind::Error);
    if has_windows {
        dialog = dialog.buttons(MessageDialogButtons::OkCancelCustom(
            keep_open.into(),
            quit.into(),
        ));
    }
    dialog.show_with_result(move |result| {
        if has_windows && result != MessageDialogResult::Custom(quit.into()) {
            return;
        }
        app.state::<Host>().exiting.store(true, Ordering::Release);
        app.exit(1);
    });
}

async fn native_request(app: &AppHandle, method: &str, args: Vec<Value>) -> Result<Value, String> {
    match method.split('.').next() {
        Some("window") => windows::request(app, method, args).await,
        Some("menu") => menu::request(app, method, args).await,
        Some("dialog") => dialogs::request(app, method, args).await,
        Some("diagnostics") if method == "diagnostics.memory-pressure" && args.is_empty() => {
            Ok(json!(platform::diagnostics::memory_pressure()))
        }
        Some("shell" | "clipboard") => desktop::request(app, method, args).await,
        Some("keychain") => keychain::request(method, args).await,
        Some("terminal") => {
            if method == "terminal.close" {
                if let Some(label) = args.first().and_then(Value::as_str) {
                    bridge::disconnect(app, label);
                }
            }
            crate::terminal::native_request(app, method, args).await
        }
        Some("app") if method == "app.exit" => {
            let (code,) = decode(args)?;
            app.state::<Host>().exiting.store(true, Ordering::Release);
            app.exit(code);
            Ok(Value::Null)
        }
        _ => Err("Unknown native application request.".into()),
    }
}

fn native_event(app: &AppHandle, event: &str, args: Vec<Value>) {
    if event == "renderer-event" {
        type RendererEvent = (String, String, Vec<Value>, Option<Vec<usize>>);
        let mut args = args;
        if args.len() == 3 {
            args.push(Value::Null);
        }
        if let Ok((label, channel, args, undefined_args)) = decode::<RendererEvent>(args) {
            bridge::emit(
                app,
                &label,
                bridge::RendererEvent {
                    channel,
                    args,
                    undefined_args,
                },
            );
        }
    }
}

fn decode<T: DeserializeOwned>(args: Vec<Value>) -> Result<T, String> {
    decode_value(Value::Array(args))
}

fn decode_value<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|error| format!("Invalid desktop request: {error}"))
}
