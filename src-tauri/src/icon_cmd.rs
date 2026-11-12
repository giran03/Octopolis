//! The app icon follows the active theme: the UI renders it in the theme's colors and sends the pixels
//! here. It becomes the window (taskbar, Alt+Tab) and tray icon, and is remembered so the next launch
//! starts with it instead of waiting for the UI.

use std::fs;
use std::path::PathBuf;

use tauri::image::Image;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};

const SAVE_FILE: &str = "app-icon.rgba";
const MAX_SIDE: u32 = 256;

fn save_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(SAVE_FILE))
}

/// Checks that `rgba` is a plausible square-ish icon of the stated size.
fn valid(rgba: &[u8], w: u32, h: u32) -> bool {
    w > 0 && h > 0 && w <= MAX_SIDE && h <= MAX_SIDE && rgba.len() == (w as usize) * (h as usize) * 4
}

/// The remembered icon, when there is one.
pub fn saved(app: &AppHandle) -> Option<Image<'static>> {
    let bytes = fs::read(save_path(app)?).ok()?;
    let (head, rgba) = bytes.split_at_checked(8)?;
    let w = u32::from_le_bytes(head[0..4].try_into().ok()?);
    let h = u32::from_le_bytes(head[4..8].try_into().ok()?);
    valid(rgba, w, h).then(|| Image::new_owned(rgba.to_vec(), w, h))
}

fn apply(app: &AppHandle, icon: Image<'static>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_icon(icon.clone());
    }
    if let Some(tray) = app.tray_by_id(crate::launch::TRAY_ID) {
        let _ = tray.set_icon(Some(icon));
    }
}

/// Applies the remembered icon at startup, before the UI has loaded.
pub fn restore(app: &AppHandle) {
    if let Some(icon) = saved(app) {
        apply(app, icon);
    }
}

/// Receives the themed icon: raw RGBA bytes as the body, `width` and `height` as headers.
#[tauri::command]
pub fn set_app_icon(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(rgba) = request.body() else {
        return Err("Expected raw RGBA bytes".into());
    };
    let side = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u32>().ok());
    let (Some(w), Some(h)) = (side("width"), side("height")) else {
        return Err("Missing icon size".into());
    };
    if !valid(rgba, w, h) {
        return Err("The icon size does not match its pixels".into());
    }
    if let Some(path) = save_path(&app) {
        let mut out = Vec::with_capacity(8 + rgba.len());
        out.extend_from_slice(&w.to_le_bytes());
        out.extend_from_slice(&h.to_le_bytes());
        out.extend_from_slice(rgba);
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(path, out);
    }
    apply(&app, Image::new_owned(rgba.clone(), w, h));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::valid;

    #[test]
    fn accepts_only_matching_sizes() {
        assert!(valid(&[0; 16], 2, 2));
        assert!(!valid(&[0; 15], 2, 2));
        assert!(!valid(&[], 0, 0));
        assert!(!valid(&vec![0; 4 * 300 * 300], 300, 300));
    }
}
