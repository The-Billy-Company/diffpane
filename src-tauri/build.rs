fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_connect",
            "desktop_invoke",
            "desktop_send",
            "desktop_shortcut_prefix",
        ]),
    ))
    .expect("could not generate Diffpane's Tauri build context");
}
