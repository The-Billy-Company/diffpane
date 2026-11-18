use std::path::PathBuf;

use serde_json::{Value, json};
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

pub(in crate::host) async fn request(
    app: &AppHandle,
    method: &str,
    args: Vec<Value>,
) -> Result<Value, String> {
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
        "shell.trash" => {
            let path = PathBuf::from(value);
            tauri::async_runtime::spawn_blocking(move || {
                trash::delete(path).map_err(|error| error.to_string())
            })
            .await
            .map_err(|error| error.to_string())??;
        }
        _ => return Err("Unknown desktop request.".into()),
    }
    Ok(Value::Null)
}
