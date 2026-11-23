// Copyright (c) 2026 The Billy Company
use block2::RcBlock;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSModalResponse, NSModalResponseOK, NSOpenPanel, NSWindow};
use objc2_foundation::NSString;
use std::{cell::RefCell, path::PathBuf};
use tauri::{AppHandle, Window};
use tokio::sync::oneshot;

pub(super) async fn pick_folders(
    app: &AppHandle,
    owner: Option<Window>,
    title: Option<String>,
    button: String,
) -> Result<Option<Vec<PathBuf>>, String> {
    let (send, receive) = oneshot::channel();
    app.run_on_main_thread(move || {
        let Some(thread) = MainThreadMarker::new() else {
            let _ = send.send(Err(
                "The folder picker did not run on the AppKit thread.".into()
            ));
            return;
        };
        let owner_handle = owner.as_ref().map(Window::ns_window).transpose();
        let Ok(owner_handle) = owner_handle else {
            let _ = send.send(Err("The folder picker's workspace window closed.".into()));
            return;
        };
        let panel = NSOpenPanel::openPanel(thread);
        panel.setCanChooseDirectories(true);
        panel.setCanChooseFiles(false);
        panel.setAllowsMultipleSelection(true);
        panel.setCanCreateDirectories(true);
        panel.setPrompt(Some(&NSString::from_str(&button)));
        if let Some(title) = title.as_deref() {
            panel.setMessage(Some(&NSString::from_str(title)));
        }

        let reply = RefCell::new(Some(send));
        let selected = panel.clone();
        let complete = RcBlock::new(move |response: NSModalResponse| {
            let result = (response == NSModalResponseOK).then(|| {
                selected
                    .URLs()
                    .iter()
                    .filter_map(|url| url.path().map(|path| PathBuf::from(path.to_string())))
                    .collect()
            });
            if let Some(reply) = reply.borrow_mut().take() {
                let _ = reply.send(Ok(result));
            }
        });
        if let Some(owner_handle) = owner_handle {
            // Tauri supplies a live AppKit window pointer and the window owner
            // remains alive until the asynchronous sheet has been registered.
            if let Some(window) = unsafe { owner_handle.cast::<NSWindow>().as_ref() } {
                panel.beginSheetModalForWindow_completionHandler(window, &complete);
            }
        } else {
            panel.beginWithCompletionHandler(&complete);
        }
    })
    .map_err(|error| error.to_string())?;
    receive
        .await
        .map_err(|_| String::from("The folder picker closed unexpectedly."))?
}
