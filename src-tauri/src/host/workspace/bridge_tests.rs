// Copyright (c) 2026 The Billy Company
use super::*;
use std::collections::HashSet;

const TYPESCRIPT: &str = include_str!("../../../../app/shared/bridge/workspace-bridge.ts");
const TRANSPORT: &str = include_str!("../../../../app/shared/bridge/transport.ts");

fn channels<'a>(source: &'a str, prefix: &str) -> HashSet<&'a str> {
    source
        .split(prefix)
        .skip(1)
        .filter_map(|suffix| suffix.split_once('\''))
        .map(|(channel, _)| channel)
        .collect()
}

#[test]
fn rust_permissions_match_the_workspace_bridge() {
    assert_eq!(
        channels(TYPESCRIPT, "invoke('"),
        INVOKE.iter().copied().collect()
    );
    let mut sends = channels(TYPESCRIPT, "transport.send('");
    sends.extend(channels(TRANSPORT, "transport.send('"));
    assert_eq!(sends, SEND.iter().copied().collect());
}

#[test]
fn workspace_permissions_exclude_other_views_and_origins() {
    let entry = "tauri://localhost/index.html".parse().unwrap();
    assert!(workspace("workspace-1"));
    assert!(!workspace("terminal-1"));
    assert!(!workspace("workspace-01"));
    assert!(!workspace("workspace-1/test"));
    assert!(workspace_url("tauri://localhost", &entry));
    assert!(workspace_url(
        "tauri://localhost",
        &"tauri://localhost".parse().unwrap()
    ));
    for other in [
        "tauri://localhost/terminal.html",
        "tauri://localhost/index.html?mode=terminal",
        "tauri://localhost.example/index.html",
        "https://tauri.localhost/index.html",
    ] {
        assert!(!workspace_url("tauri://localhost", &other.parse().unwrap()));
    }
}
