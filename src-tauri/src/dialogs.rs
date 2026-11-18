use rfd::{AsyncMessageDialog, MessageDialogResult};
use tauri::AppHandle;
use tokio::sync::oneshot;

pub(crate) async fn show(
    app: &AppHandle,
    dialog: AsyncMessageDialog,
) -> Result<MessageDialogResult, String> {
    let (reply, waiting) = oneshot::channel();
    app.run_on_main_thread(move || {
        let dialog = dialog.show();
        tauri::async_runtime::spawn(async move {
            let _ = reply.send(dialog.await);
        });
    })
    .map_err(|error| error.to_string())?;
    waiting
        .await
        .map_err(|_| "The dialog closed unexpectedly.".into())
}
