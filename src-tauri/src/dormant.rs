//! Lets the WebView give memory back while nobody can see the window, and keeps the page alive.
//!
//! Hidden to the tray or minimized, the page asks WebView2 for its low memory
//! target, which trims caches and the working set of its processes. Showing the
//! window again restores the normal target and makes the page paint again.
//!
//! Window events and the summon hotkey arrive on different threads, so nothing here
//! decides from the caller's point of view: every call queues one job on the UI thread,
//! and the job looks at the window as it is by then. Jobs run in order, so the last one
//! always reflects the latest state and a stale "hide" can never be applied after a "show".
//! A WebView2 process that dies or hangs is reloaded, so the window never stays blank.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};

/// Whether the WebView is on the low target. Only touched from the UI thread.
static LOW: AtomicBool = AtomicBool::new(false);

/// Matches the WebView's memory target to whether the main window can be seen.
/// Cheap to call on every window event.
pub fn sync(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    let hwnd = w.hwnd().map_or(0, |h| h.0 as isize);
    let _ = w.with_webview(move |wv| {
        // Looked at here, on the UI thread, at the moment the change is made (straight from Windows, so Tauri's own
        // window calls aren't re-entered from inside this one).
        let unseen = !window_visible(hwnd);
        let was_low = LOW.swap(unseen, Ordering::AcqRel);
        if unseen == was_low && unseen {
            return;
        }
        // A visible window always gets the normal target again, even when nothing seems to have changed:
        // setting it is harmless, and it repairs any state that went out of step.
        set_low_memory(&wv, unseen, was_low && !unseen);
    });
}

/// Whether the window is shown and not minimized.
#[cfg(windows)]
fn window_visible(hwnd: isize) -> bool {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn IsWindowVisible(hwnd: isize) -> i32;
        fn IsIconic(hwnd: isize) -> i32;
    }
    // SAFETY: both calls only read the state of a window handle; a stale handle just reports "not visible".
    hwnd != 0 && unsafe { IsWindowVisible(hwnd) != 0 && IsIconic(hwnd) == 0 }
}

#[cfg(not(windows))]
fn window_visible(_: isize) -> bool {
    true
}

#[cfg(windows)]
fn set_low_memory(wv: &tauri::webview::PlatformWebview, low: bool, repaint: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL, ICoreWebView2_19,
    };
    use windows_core::Interface;
    let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
    // SAFETY: plain COM calls on the live controller, made on the thread that owns it (with_webview runs there).
    // An older WebView2 runtime without ICoreWebView2_19 just keeps its normal target.
    unsafe {
        let controller = wv.controller();
        if let Ok(core) = controller.CoreWebView2()
            && let Ok(v19) = core.cast::<ICoreWebView2_19>()
        {
            let _ = v19.SetMemoryUsageTargetLevel(level);
        }
        if repaint {
            // Coming back from the low target can leave the page showing nothing until it is told to draw again.
            let _ = controller.SetIsVisible(false);
            let _ = controller.SetIsVisible(true);
            let _ = controller.NotifyParentWindowPositionChanged();
        }
    }
}

#[cfg(not(windows))]
fn set_low_memory(_: &tauri::webview::PlatformWebview, _: bool, _: bool) {}

/// Reloads the page when WebView2's renderer or browser process exits or stops responding,
/// instead of leaving a blank window until the app is restarted.
pub fn watch_failures(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    let _ = w.with_webview(watch);
}

#[cfg(windows)]
fn watch(wv: tauri::webview::PlatformWebview) {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED, COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE, ICoreWebView2Settings3, ICoreWebView2Settings6,
    };
    use webview2_com::ProcessFailedEventHandler;
    use windows_core::Interface;

    // A page that keeps failing is left alone after a few tries, so this can't loop.
    static RELOADS: Mutex<Vec<Instant>> = Mutex::new(Vec::new());

    // SAFETY: COM calls on the live controller, on the thread that owns it.
    unsafe {
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        if let Ok(settings) = core.Settings() {
            // Keep native browser shortcuts (Ctrl+P print, Ctrl+F find, Ctrl+S save, etc.) and browser controls off.
            if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
            }
            if let Ok(s6) = settings.cast::<ICoreWebView2Settings6>() {
                let _ = s6.SetIsSwipeNavigationEnabled(false);
            }
            let _ = settings.SetIsZoomControlEnabled(false);
            let _ = settings.SetAreDefaultContextMenusEnabled(false);
            let _ = settings.SetIsBuiltInErrorPageEnabled(false);
        }
        let handler = ProcessFailedEventHandler::create(Box::new(|sender, args| {
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            if let Some(a) = args {
                let _ = a.ProcessFailedKind(&mut kind);
            }
            let recoverable = kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED
                || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE;
            if !recoverable {
                return Ok(());
            }
            let mut recent = RELOADS.lock().unwrap_or_else(|e| e.into_inner());
            recent.retain(|t| t.elapsed() < Duration::from_secs(60));
            let reload = recent.len() < 3;
            if reload {
                recent.push(Instant::now());
            }
            drop(recent);
            crate::diag::write("warn", &format!("WebView2 process failed (kind {}); {}", kind.0, if reload { "reloading the page" } else { "not reloading again" }));
            if reload && let Some(core) = sender {
                let _ = core.Reload();
            }
            Ok(())
        }));
        let mut token = Default::default();
        let _ = core.add_ProcessFailed(&handler, &mut token);
    }
}

#[cfg(not(windows))]
fn watch(_: tauri::webview::PlatformWebview) {}
