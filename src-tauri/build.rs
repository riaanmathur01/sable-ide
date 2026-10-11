fn main() {
    // The remote agent (built without the "desktop" feature) has no app
    // window, icons or capabilities to generate.
    if std::env::var_os("CARGO_FEATURE_DESKTOP").is_some() {
        tauri_build::build()
    }
}
