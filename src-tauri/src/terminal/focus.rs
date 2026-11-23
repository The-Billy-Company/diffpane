// Copyright (c) 2026 The Billy Company
use tauri::Webview;

#[cfg(target_os = "macos")]
pub(crate) async fn is_focused(view: &Webview) -> bool {
    use objc2_app_kit::NSView;
    use tokio::sync::oneshot;

    let (send, receive) = oneshot::channel();
    if view
        .with_webview(move |platform| {
            // Tauri supplies a live WKWebView, an NSView subclass, on the AppKit main thread.
            let focused =
                unsafe { platform.inner().cast::<NSView>().as_ref() }.is_some_and(|view| {
                    !view.isHiddenOrHasHiddenAncestor()
                        && view.window().is_some_and(|window| {
                            window.isKeyWindow()
                                && window.firstResponder().is_some_and(|responder| {
                                    responder
                                        .downcast_ref::<NSView>()
                                        .is_some_and(|first| first.isDescendantOf(view))
                                })
                        })
                });
            let _ = send.send(focused);
        })
        .is_err()
    {
        return false;
    }
    receive.await.unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
pub(crate) async fn is_focused(_view: &Webview) -> bool {
    false
}
