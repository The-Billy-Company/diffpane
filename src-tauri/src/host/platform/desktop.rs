// Copyright (c) 2026 The Billy Company
use serde_json::{Value, json};
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

pub(in crate::host) async fn request(
    app: &AppHandle,
    method: &str,
    args: Vec<Value>,
) -> Result<Value, String> {
    if method == "shell.trash" {
        let mut args = args;
        if args.len() == 1 {
            args.push(Value::Null);
        }
        let (path, expected_identity): (String, Option<String>) = super::decode(args)?;
        return tauri::async_runtime::spawn_blocking(move || {
            #[cfg(target_os = "macos")]
            return super::trash::move_to_trash(&path, expected_identity.as_deref());
            #[cfg(not(target_os = "macos"))]
            {
                let _ = expected_identity;
                trash::delete(path).map_err(|error| error.to_string())?;
                Ok(Value::Null)
            }
        })
        .await
        .map_err(|error| error.to_string())?;
    }
    if method == "shell.restoreTrash" {
        #[cfg(target_os = "macos")]
        {
            let (path, destination, identity): (String, String, String) = super::decode(args)?;
            return tauri::async_runtime::spawn_blocking(move || {
                super::trash::restore(&path, &destination, &identity)?;
                Ok(Value::Null)
            })
            .await
            .map_err(|error| error.to_string())?;
        }
        #[cfg(not(target_os = "macos"))]
        return Err("Restoring from Trash is only available on macOS.".into());
    }
    let (value,): (String,) = super::decode(args)?;
    match method {
        "clipboard.write" => app
            .clipboard()
            .write_text(value)
            .map_err(|error| error.to_string())?,
        "shell.open" => app
            .opener()
            .open_url(value, None::<String>)
            .map_err(|error| error.to_string())?,
        "shell.openPath" => {
            let result = app.opener().open_path(value, None::<String>);
            return Ok(json!(
                result
                    .err()
                    .map(|error| error.to_string())
                    .unwrap_or_default()
            ));
        }
        "shell.reveal" => app
            .opener()
            .reveal_item_in_dir(value)
            .map_err(|error| error.to_string())?,
        _ => return Err("Unknown desktop request.".into()),
    }
    Ok(Value::Null)
}
