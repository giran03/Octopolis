//! The Windows file clipboard (`CF_HDROP` + "Preferred DropEffect"), so files
//! copied or cut in Octopolis paste in Explorer and other apps, and the reverse.

use std::path::PathBuf;

use crate::error::Result;

/// Whether pasted files should be copied or moved (a cut).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipEffect {
    Copy,
    Move,
}

/// Files on the clipboard and what the app that put them there wants done.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClipFiles {
    pub paths: Vec<PathBuf>,
    pub effect: ClipEffect,
}

/// Puts `paths` on the clipboard as files. `owner` is the window handle that
/// owns the clipboard data.
pub fn write_files(owner: isize, paths: &[PathBuf], effect: ClipEffect) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    imp::write_files(owner, paths, effect)
}

/// Files currently on the clipboard, if any.
pub fn read_files(owner: isize) -> Result<Option<ClipFiles>> {
    imp::read_files(owner)
}

/// Empties the clipboard (after a cut has been pasted, as Explorer does).
pub fn clear(owner: isize) -> Result<()> {
    imp::clear(owner)
}

/// Increases each time anything changes the clipboard; tells whether our own
/// copy is still the latest one.
pub fn sequence() -> u32 {
    imp::sequence()
}

/// A picture on the clipboard as PNG bytes, if any (screenshots, copied images).
pub fn read_image_png(owner: isize) -> Result<Option<Vec<u8>>> {
    imp::read_image_png(owner)
}

/// Text on the clipboard, if any.
pub fn read_text(owner: isize) -> Result<Option<String>> {
    imp::read_text(owner)
}

/// Decodes a `CF_DIB` block (BITMAPINFOHEADER + pixels, 24 or 32 bits per
/// pixel, uncompressed or bit fields) into width, height and RGBA rows, top first.
pub fn dib_to_rgba(dib: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    let u32_at = |o: usize| dib.get(o..o + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    let i32_at = |o: usize| u32_at(o).map(|v| v as i32);
    let header = u32_at(0)? as usize;
    let width = i32_at(4)?;
    let height = i32_at(8)?;
    let bits = dib.get(14..16).map(|b| u16::from_le_bytes([b[0], b[1]]))?;
    let compression = u32_at(16)?;
    const BI_RGB: u32 = 0;
    const BI_BITFIELDS: u32 = 3;
    if width <= 0 || height == 0 || !(bits == 24 || bits == 32) || !(compression == BI_RGB || compression == BI_BITFIELDS) {
        return None;
    }
    let (w, h) = (width as usize, height.unsigned_abs() as usize);
    if w.checked_mul(h)? > 100_000_000 {
        return None; // refuse absurd sizes instead of allocating gigabytes
    }
    // Bit-field masks follow a plain 40-byte header; larger headers carry them inside.
    let pixels_at = header + if compression == BI_BITFIELDS && header == 40 { 12 } else { 0 };
    let stride = (w * bits as usize).div_ceil(32) * 4;
    let data = dib.get(pixels_at..pixels_at + stride * h)?;
    let mut rgba = vec![0u8; w * h * 4];
    // A 32-bit image whose alpha is all zero means "no alpha": show it opaque.
    let alpha_used = bits == 32 && (0..h).any(|y| (0..w).any(|x| data[y * stride + x * 4 + 3] != 0));
    for y in 0..h {
        let src_row = if height > 0 { h - 1 - y } else { y }; // positive height is bottom-up
        let row = &data[src_row * stride..];
        for x in 0..w {
            let (b, g, r, a) = if bits == 32 {
                let p = &row[x * 4..x * 4 + 4];
                (p[0], p[1], p[2], if alpha_used { p[3] } else { 255 })
            } else {
                let p = &row[x * 3..x * 3 + 3];
                (p[0], p[1], p[2], 255)
            };
            rgba[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&[r, g, b, a]);
        }
    }
    Some((w as u32, h as u32, rgba))
}

/// PNG-encodes RGBA rows.
pub fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(out)
}

/// The DROPEFFECT value Windows uses for "Preferred DropEffect".
pub fn effect_code(effect: ClipEffect) -> u32 {
    match effect {
        ClipEffect::Copy => 1, // DROPEFFECT_COPY
        ClipEffect::Move => 2, // DROPEFFECT_MOVE
    }
}

/// Encodes paths as the double-NUL-terminated UTF-16 list `DROPFILES` expects.
#[cfg(windows)]
pub fn encode_file_list(paths: &[PathBuf]) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    let mut out: Vec<u16> = Vec::new();
    for p in paths {
        out.extend(p.as_os_str().encode_wide());
        out.push(0);
    }
    out.push(0);
    out
}

#[cfg(windows)]
mod imp {
    use std::path::PathBuf;

    use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber, IsClipboardFormatAvailable, OpenClipboard,
        RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GMEM_MOVEABLE, GMEM_ZEROINIT, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock};
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::{DROPFILES, DragQueryFileW, HDROP};
    use windows::core::w;

    use super::{ClipEffect, ClipFiles, effect_code, encode_file_list};
    use crate::error::{Error, Result};

    fn fail(what: &str, e: windows::core::Error) -> Error {
        Error::io(std::path::Path::new("clipboard"), std::io::Error::other(format!("{what} ({})", e.message())))
    }

    /// Closes the clipboard when dropped.
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            // SAFETY: only constructed after a successful OpenClipboard.
            let _ = unsafe { CloseClipboard() };
        }
    }

    /// Opens the clipboard, retrying briefly because other apps hold it for short moments.
    fn open(owner: isize) -> Result<Guard> {
        let mut last = None;
        for _ in 0..10 {
            // SAFETY: plain Win32 call; closed by `Guard`.
            match unsafe { OpenClipboard(Some(HWND(owner as *mut _))) } {
                Ok(()) => return Ok(Guard),
                Err(e) => last = Some(e),
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        Err(fail("the clipboard is busy", last.expect("at least one attempt")))
    }

    fn drop_effect_format() -> u32 {
        // SAFETY: constant NUL-terminated string.
        unsafe { RegisterClipboardFormatW(w!("Preferred DropEffect")) }
    }

    /// Copies `bytes` into a movable global block for SetClipboardData.
    fn global_from(bytes: &[u8]) -> Result<HGLOBAL> {
        // SAFETY: the block is allocated with the needed size and written while locked.
        unsafe {
            let block = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.len()).map_err(|e| fail("out of memory", e))?;
            let ptr = GlobalLock(block) as *mut u8;
            if ptr.is_null() {
                let _ = GlobalFree(Some(block));
                return Err(Error::io(std::path::Path::new("clipboard"), std::io::Error::other("out of memory")));
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
            let _ = GlobalUnlock(block);
            Ok(block)
        }
    }

    fn set(format: u32, block: HGLOBAL) -> Result<()> {
        // SAFETY: on success the clipboard owns the block; on failure we free it.
        unsafe {
            if let Err(e) = SetClipboardData(format, Some(HANDLE(block.0))) {
                let _ = GlobalFree(Some(block));
                return Err(fail("the clipboard refused the data", e));
            }
        }
        Ok(())
    }

    pub fn write_files(owner: isize, paths: &[PathBuf], effect: ClipEffect) -> Result<()> {
        let list = encode_file_list(paths);
        let header = DROPFILES { pFiles: size_of::<DROPFILES>() as u32, fWide: true.into(), ..Default::default() };
        let mut bytes = Vec::with_capacity(size_of::<DROPFILES>() + list.len() * 2);
        // SAFETY: DROPFILES is a plain C struct; viewing it as bytes is sound.
        bytes.extend_from_slice(unsafe { std::slice::from_raw_parts(&header as *const DROPFILES as *const u8, size_of::<DROPFILES>()) });
        for unit in &list {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let files = global_from(&bytes)?;
        let effect_block = match global_from(&effect_code(effect).to_le_bytes()) {
            Ok(b) => b,
            Err(e) => {
                // SAFETY: not yet handed to the clipboard.
                let _ = unsafe { GlobalFree(Some(files)) };
                return Err(e);
            }
        };
        let guard = open(owner);
        let Ok(_guard) = guard else {
            // SAFETY: neither block was handed to the clipboard.
            unsafe {
                let _ = GlobalFree(Some(files));
                let _ = GlobalFree(Some(effect_block));
            }
            return guard.map(|_| ());
        };
        // SAFETY: the clipboard is open.
        unsafe { EmptyClipboard() }.map_err(|e| fail("the clipboard could not be cleared", e))?;
        set(CF_HDROP.0 as u32, files)?;
        set(drop_effect_format(), effect_block)
    }

    pub fn read_files(owner: isize) -> Result<Option<ClipFiles>> {
        // SAFETY: plain query.
        if unsafe { IsClipboardFormatAvailable(CF_HDROP.0 as u32) }.is_err() {
            return Ok(None);
        }
        let _guard = open(owner)?;
        // SAFETY: the clipboard is open; its handles stay owned by the clipboard and are only read.
        unsafe {
            let Ok(handle) = GetClipboardData(CF_HDROP.0 as u32) else { return Ok(None) };
            let drop = HDROP(handle.0);
            let count = DragQueryFileW(drop, u32::MAX, None);
            let mut paths = Vec::with_capacity(count as usize);
            for i in 0..count {
                let len = DragQueryFileW(drop, i, None) as usize;
                let mut buf = vec![0u16; len + 1];
                let got = DragQueryFileW(drop, i, Some(&mut buf)) as usize;
                paths.push(PathBuf::from(String::from_utf16_lossy(&buf[..got])));
            }
            let mut effect = ClipEffect::Copy;
            if let Ok(h) = GetClipboardData(drop_effect_format()) {
                let block = HGLOBAL(h.0);
                let ptr = GlobalLock(block) as *const u8;
                if !ptr.is_null() {
                    if GlobalSize(block) >= 4 {
                        let value = u32::from_le_bytes([*ptr, *ptr.add(1), *ptr.add(2), *ptr.add(3)]);
                        if value & 2 != 0 && value & 1 == 0 {
                            effect = ClipEffect::Move;
                        }
                    }
                    let _ = GlobalUnlock(block);
                }
            }
            Ok((!paths.is_empty()).then_some(ClipFiles { paths, effect }))
        }
    }

    /// A copy of the clipboard's data in `format`, if present. The clipboard must be open.
    unsafe fn raw(format: u32) -> Option<Vec<u8>> {
        // SAFETY: the caller holds the clipboard open; the block is only read while locked.
        unsafe {
            let h = GetClipboardData(format).ok()?;
            let block = HGLOBAL(h.0);
            let ptr = GlobalLock(block) as *const u8;
            if ptr.is_null() {
                return None;
            }
            let bytes = std::slice::from_raw_parts(ptr, GlobalSize(block)).to_vec();
            let _ = GlobalUnlock(block);
            Some(bytes)
        }
    }

    pub fn read_image_png(owner: isize) -> Result<Option<Vec<u8>>> {
        // SAFETY: plain format queries.
        let png_format = unsafe { RegisterClipboardFormatW(w!("PNG")) };
        const CF_DIB: u32 = 8;
        let has_png = unsafe { IsClipboardFormatAvailable(png_format) }.is_ok();
        let has_dib = unsafe { IsClipboardFormatAvailable(CF_DIB) }.is_ok();
        if !has_png && !has_dib {
            return Ok(None);
        }
        let _guard = open(owner)?;
        // SAFETY: the clipboard is open for both reads.
        if has_png && let Some(bytes) = unsafe { raw(png_format) }.filter(|b| b.starts_with(b"\x89PNG")) {
            return Ok(Some(bytes));
        }
        let png = unsafe { raw(CF_DIB) }.and_then(|dib| super::dib_to_rgba(&dib)).and_then(|(w, h, rgba)| super::encode_png(w, h, &rgba));
        Ok(png)
    }

    pub fn read_text(owner: isize) -> Result<Option<String>> {
        const CF_UNICODETEXT: u32 = 13;
        // SAFETY: plain format query.
        if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT) }.is_err() {
            return Ok(None);
        }
        let _guard = open(owner)?;
        // SAFETY: the clipboard is open.
        let Some(bytes) = (unsafe { raw(CF_UNICODETEXT) }) else { return Ok(None) };
        let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).take_while(|&u| u != 0).collect();
        let text = String::from_utf16_lossy(&units);
        Ok((!text.trim().is_empty()).then_some(text))
    }

    pub fn clear(owner: isize) -> Result<()> {
        let _guard = open(owner)?;
        // SAFETY: the clipboard is open.
        unsafe { EmptyClipboard() }.map_err(|e| fail("the clipboard could not be cleared", e))
    }

    pub fn sequence() -> u32 {
        // SAFETY: plain query.
        unsafe { GetClipboardSequenceNumber() }
    }
}

#[cfg(not(windows))]
mod imp {
    use std::path::PathBuf;

    use super::{ClipEffect, ClipFiles};
    use crate::error::Result;

    pub fn write_files(_: isize, _: &[PathBuf], _: ClipEffect) -> Result<()> {
        Ok(())
    }
    pub fn read_files(_: isize) -> Result<Option<ClipFiles>> {
        Ok(None)
    }
    pub fn clear(_: isize) -> Result<()> {
        Ok(())
    }
    pub fn sequence() -> u32 {
        0
    }
    pub fn read_image_png(_: isize) -> Result<Option<Vec<u8>>> {
        Ok(None)
    }
    pub fn read_text(_: isize) -> Result<Option<String>> {
        Ok(None)
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn file_list_is_double_nul_terminated() {
        let list = encode_file_list(&[PathBuf::from("C:\\a"), PathBuf::from("D:\\bé")]);
        assert_eq!(String::from_utf16_lossy(&list), "C:\\a\0D:\\bé\0\0");
    }

    #[test]
    fn decodes_bottom_up_24_bit_and_top_down_32_bit_bitmaps() {
        // 2x2, 24 bpp, bottom-up: rows are padded to 4 bytes (6 -> 8).
        let mut dib = vec![0u8; 40];
        dib[0..4].copy_from_slice(&40u32.to_le_bytes());
        dib[4..8].copy_from_slice(&2i32.to_le_bytes());
        dib[8..12].copy_from_slice(&2i32.to_le_bytes());
        dib[14..16].copy_from_slice(&24u16.to_le_bytes());
        // bottom row: blue, green   top row: red, white (stored as B, G, R)
        dib.extend_from_slice(&[255, 0, 0, 0, 255, 0, 0, 0]);
        dib.extend_from_slice(&[0, 0, 255, 255, 255, 255, 0, 0]);
        let (w, h, rgba) = dib_to_rgba(&dib).unwrap();
        assert_eq!((w, h), (2, 2));
        assert_eq!(&rgba[0..4], &[255, 0, 0, 255], "top-left is red");
        assert_eq!(&rgba[8..12], &[0, 0, 255, 255], "bottom-left is blue");

        let mut top_down = vec![0u8; 40];
        top_down[0..4].copy_from_slice(&40u32.to_le_bytes());
        top_down[4..8].copy_from_slice(&1i32.to_le_bytes());
        top_down[8..12].copy_from_slice(&(-1i32).to_le_bytes());
        top_down[14..16].copy_from_slice(&32u16.to_le_bytes());
        top_down.extend_from_slice(&[10, 20, 30, 0]); // alpha 0 everywhere means opaque
        let (_, _, px) = dib_to_rgba(&top_down).unwrap();
        assert_eq!(px, vec![30, 20, 10, 255]);
        assert!(encode_png(1, 1, &px).unwrap().starts_with(&[0x89, b'P', b'N', b'G']));
    }

    #[test]
    fn rejects_unsupported_or_truncated_bitmaps() {
        assert!(dib_to_rgba(&[0u8; 10]).is_none());
        let mut dib = vec![0u8; 40];
        dib[0..4].copy_from_slice(&40u32.to_le_bytes());
        dib[4..8].copy_from_slice(&100i32.to_le_bytes());
        dib[8..12].copy_from_slice(&100i32.to_le_bytes());
        dib[14..16].copy_from_slice(&24u16.to_le_bytes());
        assert!(dib_to_rgba(&dib).is_none(), "pixel data missing");
    }

    #[test]
    fn effects_match_windows_codes() {
        assert_eq!(effect_code(ClipEffect::Copy), 1);
        assert_eq!(effect_code(ClipEffect::Move), 2);
    }
}
