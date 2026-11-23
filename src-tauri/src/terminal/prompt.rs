// Copyright (c) 2026 The Billy Company
use rfd::{AsyncMessageDialog, MessageButtons, MessageDialogResult};
use serde::Deserialize;
use std::{collections::HashMap, sync::Mutex};
use tauri::{AppHandle, Manager};

use super::TerminalLayouts;

#[derive(Deserialize)]
pub(super) struct Prompt {
    title: String,
    message: String,
    detail: String,
    approve: String,
}

#[derive(Default)]
struct WindowConfirmation {
    canceled_through: u64,
    pending: Option<u64>,
}

#[derive(Default)]
pub(super) struct Confirmations(Mutex<HashMap<String, WindowConfirmation>>);

pub(super) async fn show(
    app: &AppHandle,
    owner: String,
    id: u64,
    prompt: Prompt,
) -> Result<bool, String> {
    let Some(parent) = app.get_window(&owner) else {
        return Ok(false);
    };
    {
        let state = app.state::<TerminalLayouts>();
        let mut windows = state
            .confirmations
            .0
            .lock()
            .expect("terminal confirmations");
        let confirmation = windows.entry(owner.clone()).or_default();
        if id <= confirmation.canceled_through || confirmation.pending.is_some() {
            return Ok(false);
        }
        confirmation.pending = Some(id);
    }

    let approve = prompt.approve;
    let message = format!("{}\n\n{}", prompt.message, prompt.detail);
    // The plugin aliases a dismissed dialog to its second custom label.
    // Use the raw native result so only pressing the approval button can start a shell.
    let dialog = AsyncMessageDialog::new()
        .set_description(message)
        .set_title(prompt.title)
        .set_parent(&parent)
        .set_buttons(MessageButtons::OkCancelCustom(
            "Cancel".into(),
            approve.clone(),
        ));
    let choice = crate::dialogs::show(app, dialog).await;
    let state = app.state::<TerminalLayouts>();
    let mut windows = state
        .confirmations
        .0
        .lock()
        .expect("terminal confirmations");
    let permitted = windows.get_mut(&owner).is_some_and(|confirmation| {
        if confirmation.pending != Some(id) {
            return false;
        }
        confirmation.pending = None;
        id > confirmation.canceled_through
    });
    Ok(permitted && choice? == MessageDialogResult::Custom(approve))
}

pub(super) fn cancel(app: &AppHandle, owner: String, id: u64) {
    let state = app.state::<TerminalLayouts>();
    let mut windows = state
        .confirmations
        .0
        .lock()
        .expect("terminal confirmations");
    let confirmation = windows.entry(owner).or_default();
    confirmation.canceled_through = confirmation.canceled_through.max(id);
}

pub(super) fn forget(state: &Confirmations, owner: &str) {
    state
        .0
        .lock()
        .expect("terminal confirmations")
        .remove(owner);
}
