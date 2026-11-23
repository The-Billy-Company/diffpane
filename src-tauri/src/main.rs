// Copyright (c) 2026 The Billy Company
mod dialogs;
mod host;
mod media;
mod terminal;

fn main() {
    if let Err(error) = host::run() {
        eprintln!("Diffpane could not start: {error}");
        std::process::exit(1);
    }
}
