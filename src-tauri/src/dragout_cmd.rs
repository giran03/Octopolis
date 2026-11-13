//! Dragging files out of the app. The page cannot start a drag that other programs understand, so the drag is
//! started here with Windows' own drag and drop: Explorer, browsers, chat and mail apps then see real files.

use std::path::PathBuf;
use std::sync::mpsc;

use drag::{DragItem, DragResult, Image, Options};
use tauri::WebviewWindow;

/// Starts a native drag of `paths` from the window and returns when it ends: true if the items were dropped
/// somewhere, false if the drag was cancelled. The mouse button must still be down when this is called.
#[tauri::command]
pub async fn start_native_drag(window: WebviewWindow, paths: Vec<PathBuf>) -> Result<bool, String> {
    let (paths, image) = crate::off_main(move || {
        let paths: Vec<PathBuf> = paths.into_iter().filter(|p| p.exists()).collect();
        // The picture under the cursor: the first item's thumbnail or icon (none is fine too).
        let image = paths.first().and_then(|p| octo_core::thumbs::thumbnail_png(p, 96, false).ok()).unwrap_or_default();
        Ok((paths, image))
    })
    .await?;
    if paths.is_empty() {
        return Err("There is nothing to drag".into());
    }
    let (tx, rx) = mpsc::channel::<Result<bool, String>>();
    let handle = window.clone();
    let failed = tx.clone();
    window
        .run_on_main_thread(move || {
            // Runs the drag's own loop on the UI thread; this returns once the button is released or Esc is pressed.
            let ended = tx;
            let result = drag::start_drag(
                &handle,
                DragItem::Files(paths),
                Image::Raw(image),
                move |r, _| {
                    let _ = ended.send(Ok(matches!(r, DragResult::Dropped)));
                },
                Options::default(),
            );
            if let Err(e) = result {
                let _ = failed.send(Err(e.to_string()));
            }
        })
        .map_err(|e| e.to_string())?;
    crate::off_main(move || rx.recv().map_err(|_| "The drag ended unexpectedly".to_string())?).await
}
