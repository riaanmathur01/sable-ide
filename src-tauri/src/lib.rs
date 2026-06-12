// Sable — application entry point for the Rust backend.
//
// All OS-level functionality (filesystem, terminal PTY, search, watching)
// lives behind Tauri commands registered here. The frontend never touches
// the OS directly; it calls these commands via `invoke()`.

mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::fs::read_directory,
            commands::fs::is_directory,
            commands::fs::create_file,
            commands::fs::create_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
