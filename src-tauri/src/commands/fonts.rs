//! Installed-font discovery for the font pickers in Settings.

use std::collections::BTreeSet;

/// True when letters of very different shapes share one advance width.
/// Measuring beats trusting the font's "fixed pitch" flag: Monaco and
/// Nerd Font builds don't set it, and some proportional fonts do.
fn has_uniform_advances(data: &[u8], index: u32) -> bool {
    let Ok(face) = ttf_parser::Face::parse(data, index) else {
        return false;
    };
    let advances: Vec<u16> = ['i', 'W', 'm', '.', '0']
        .iter()
        .filter_map(|&character| {
            let glyph = face.glyph_index(character)?;
            face.glyph_hor_advance(glyph)
        })
        .collect();
    advances.len() == 5 && advances.iter().all(|&advance| advance == advances[0])
}

/// Family names of every installed monospace font, sorted and de-duped.
/// Scanning and measuring takes a few hundred ms, so it runs off the
/// main thread.
#[tauri::command]
pub async fn list_monospace_fonts() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(|| {
        let mut database = fontdb::Database::new();
        database.load_system_fonts();
        let mut families = BTreeSet::new();
        for face in database.faces() {
            let Some((name, _)) = face.families.first() else { continue };
            // Dot-prefixed families are private system fonts (".SF NS
            // Mono" — reachable from CSS as `ui-monospace` instead), and
            // bitmap fonts render badly at editor sizes.
            if name.starts_with('.') || name.contains("Bitmap") || families.contains(name) {
                continue;
            }
            let monospace = database
                .with_face_data(face.id, has_uniform_advances)
                .unwrap_or(false);
            if monospace {
                families.insert(name.clone());
            }
        }
        families.into_iter().collect::<Vec<String>>()
    })
    .await
    .map_err(|error| format!("Could not list fonts: {error}"))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[tokio::test]
    async fn finds_system_monospace_fonts() {
        let fonts = super::list_monospace_fonts().await.unwrap();
        println!("{} monospace families: {fonts:?}", fonts.len());
        for expected in ["Menlo", "Monaco", "Courier New"] {
            assert!(fonts.iter().any(|name| name == expected), "missing {expected}");
        }
        assert!(!fonts.iter().any(|name| name == "Helvetica"));
        assert!(fonts.iter().all(|name| !name.starts_with('.')));
    }
}
