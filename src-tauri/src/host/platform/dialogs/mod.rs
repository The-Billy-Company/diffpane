#[cfg(target_os = "macos")]
mod macos;

use rfd::{AsyncMessageDialog, MessageButtons, MessageDialogResult, MessageLevel};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Window};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder, FilePath};
use tokio::sync::oneshot;

#[derive(Deserialize)]
struct FileFilter {
    name: String,
    extensions: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct FileOptions {
    title: Option<String>,
    default_path: Option<PathBuf>,
    #[cfg(target_os = "macos")]
    button_label: Option<String>,
    properties: Vec<String>,
    filters: Vec<FileFilter>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct MessageOptions {
    title: Option<String>,
    message: String,
    detail: String,
    #[serde(rename = "type")]
    kind: String,
    buttons: Vec<String>,
    default_id: usize,
    cancel_id: usize,
}

pub(in crate::host) async fn request(
    app: &AppHandle,
    method: &str,
    args: Vec<Value>,
) -> Result<Value, String> {
    let (label, options): (Option<String>, Value) = super::decode(args)?;
    let parent = label
        .as_deref()
        .map(|label| {
            app.get_window(label)
                .ok_or("The dialog's workspace window closed.")
        })
        .transpose()?;
    match method {
        "dialog.open" => {
            let options: FileOptions = super::decode_value(options)?;
            let folder = options.properties.iter().any(|p| p == "openDirectory");
            let multiple = options.properties.iter().any(|p| p == "multiSelections");
            #[cfg(target_os = "macos")]
            if folder && multiple {
                if let Some(button) = options.button_label.as_ref() {
                    let result =
                        macos::pick_folders(app, parent, options.title, button.clone()).await?;
                    return Ok(
                        json!({ "canceled": result.is_none(), "filePaths": result.unwrap_or_default() }),
                    );
                }
            }
            let builder = file_builder(app, parent.as_ref(), options);
            let (reply, waiting) = oneshot::channel();
            match (folder, multiple) {
                (true, true) => builder.pick_folders(move |paths| {
                    let _ = reply.send(paths);
                }),
                (false, true) => builder.pick_files(move |paths| {
                    let _ = reply.send(paths);
                }),
                (true, false) => builder.pick_folder(move |path| {
                    let _ = reply.send(path.map(|path| vec![path]));
                }),
                (false, false) => builder.pick_file(move |path| {
                    let _ = reply.send(path.map(|path| vec![path]));
                }),
            }
            let paths = waiting
                .await
                .map_err(|_| "The open panel closed unexpectedly.")?;
            let canceled = paths.is_none();
            let paths = paths
                .unwrap_or_default()
                .into_iter()
                .map(local_path)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(json!({ "canceled": canceled, "filePaths": paths }))
        }
        "dialog.save" => {
            let options = super::decode_value(options)?;
            let (reply, waiting) = oneshot::channel();
            file_builder(app, parent.as_ref(), options).save_file(move |path| {
                let _ = reply.send(path);
            });
            let path = waiting
                .await
                .map_err(|_| "The save panel closed unexpectedly.")?;
            let path = path.map(local_path).transpose()?;
            Ok(json!({ "canceled": path.is_none(), "filePath": path }))
        }
        "dialog.message" => message(app, parent.as_ref(), super::decode_value(options)?).await,
        _ => Err("Unknown dialog request.".into()),
    }
}

fn file_builder(
    app: &AppHandle,
    parent: Option<&Window>,
    options: FileOptions,
) -> FileDialogBuilder<tauri::Wry> {
    let mut dialog = app.dialog().file();
    if let Some(parent) = parent {
        dialog = dialog.set_parent(parent);
    }
    if let Some(title) = options.title {
        dialog = dialog.set_title(title);
    }
    if let Some(path) = options.default_path {
        if path.is_dir() {
            dialog = dialog.set_directory(path);
        } else {
            if let Some(parent) = path.parent().filter(|p| p.is_absolute()) {
                dialog = dialog.set_directory(parent);
            }
            if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
                dialog = dialog.set_file_name(name);
            }
        }
    }
    for filter in options.filters {
        let extensions: Vec<_> = filter.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(filter.name, &extensions);
    }
    dialog
}

fn local_path(path: FilePath) -> Result<PathBuf, String> {
    path.into_path().map_err(|error| error.to_string())
}

async fn message(
    app: &AppHandle,
    parent: Option<&Window>,
    options: MessageOptions,
) -> Result<Value, String> {
    let text = if options.detail.is_empty() {
        options.message
    } else {
        format!("{}\n\n{}", options.message, options.detail)
    };
    let mut dialog =
        AsyncMessageDialog::new()
            .set_description(text)
            .set_level(match options.kind.as_str() {
                "warning" => MessageLevel::Warning,
                "error" => MessageLevel::Error,
                _ => MessageLevel::Info,
            });
    if let Some(title) = options.title {
        dialog = dialog.set_title(title);
    }
    if let Some(parent) = parent {
        dialog = dialog.set_parent(parent);
    }
    let mut order: Vec<_> = (0..options.buttons.len()).collect();
    if options.default_id < order.len() {
        order.remove(options.default_id);
        order.insert(0, options.default_id);
    }
    let labels: Vec<_> = order
        .iter()
        .map(|index| options.buttons[*index].clone())
        .collect();
    dialog = dialog.set_buttons(match labels.as_slice() {
        [] => MessageButtons::Ok,
        [one] => MessageButtons::OkCustom(one.clone()),
        [one, two] => MessageButtons::OkCancelCustom(one.clone(), two.clone()),
        [one, two, three] => {
            MessageButtons::YesNoCancelCustom(one.clone(), two.clone(), three.clone())
        }
        _ => return Err("Diffpane dialogs support up to three buttons.".into()),
    });
    // Preserve an explicit dismissal independently of the display order of custom actions.
    let choice = crate::dialogs::show(app, dialog).await?;
    let response = selected_action(choice, &options.buttons, &order, options.cancel_id);
    Ok(json!({ "response": response }))
}

fn selected_action(
    choice: MessageDialogResult,
    buttons: &[String],
    order: &[usize],
    cancel_id: usize,
) -> usize {
    match choice {
        MessageDialogResult::Custom(label) => buttons.iter().position(|button| button == &label),
        MessageDialogResult::Ok | MessageDialogResult::Yes => order.first().copied(),
        MessageDialogResult::No => order.get(1).copied(),
        MessageDialogResult::Cancel => None,
    }
    .unwrap_or(cancel_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dismissed_recovery_dialog_never_selects_a_reordered_action() {
        let buttons = vec![
            "Reload Window".into(),
            "Close Window".into(),
            "Cancel".into(),
        ];
        let order = [2, 0, 1];
        assert_eq!(
            selected_action(MessageDialogResult::Cancel, &buttons, &order, 2),
            2
        );
        assert_eq!(
            selected_action(
                MessageDialogResult::Custom("Reload Window".into()),
                &buttons,
                &order,
                2
            ),
            0
        );
    }
}
