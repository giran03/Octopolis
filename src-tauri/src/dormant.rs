//! Lets the WebView give memory back while nobody can see the window.
//!
//! Hidden to the tray or minimized, the page asks WebView2 for its low memory
//! target, which trims caches and the working set of its processes. Showing the
//! window again restores the normal target. Painting is left alone, so the
//! window comes back with its last frame and no flash.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};

static DORMANT: AtomicBool = AtomicBool::new(false);

/// Matches the WebView's memory target to whether the main window can be seen.
/// Cheap to call on every window event: it only acts when the state changes.
pub fn sync(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    let unseen = !w.is_visible().unwrap_or(true) || w.is_minimized().unwrap_or(false);
    if DORMANT.swap(unseen, Ordering::AcqRel) == unseen {
        return;
    }
    let _ = w.with_webview(move |wv| set_low_memory(&wv, unseen));
}

#[cfg(windows)]
fn set_low_memory(wv: &tauri::webview::PlatformWebview, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL, ICoreWebView2_19,
    };
    use windows_core::Interface;
    let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
    // SAFETY: plain COM calls on the live controller, made on the thread that owns it (with_webview runs there).
    // An older WebView2 runtime without ICoreWebView2_19 just keeps its normal target.
    unsafe {
        if let Ok(core) = wv.controller().CoreWebView2()
            && let Ok(v19) = core.cast::<ICoreWebView2_19>()
        {
            let _ = v19.SetMemoryUsageTargetLevel(level);
        }
    }
}

#[cfg(not(windows))]
fn set_low_memory(_: &tauri::webview::PlatformWebview, _: bool) {}
