// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Run by ssh as its SSH_ASKPASS helper: ask the running app, answer, exit.
    if let Ok(address) = std::env::var("SABLE_ASKPASS") {
        let prompt = std::env::args().nth(1).unwrap_or_default();
        std::process::exit(sable_lib::askpass_client(&address, &prompt));
    }
    sable_lib::run()
}
