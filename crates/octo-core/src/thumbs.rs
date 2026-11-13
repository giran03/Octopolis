//! Shell thumbnails and icons (`IShellItemImageFactory`), encoded as PNG.

use std::path::Path;

use crate::error::Result;

/// The system files whose icons can be borrowed, in the order they are offered.
pub const ICON_DLLS: &[&str] = &["imageres", "shell32", "ddores", "moricons", "pifmgr"];
const MAX_ICON_INDEX: u32 = 20_000;

/// "res:imageres,123" → the file (one of [`ICON_DLLS`]) and the icon's number in it.
pub fn parse_resource_ref(text: &str) -> Option<(&'static str, u32)> {
    let rest = text.strip_prefix("res:")?;
    let (name, index) = rest.split_once(',')?;
    let dll = ICON_DLLS.iter().find(|d| d.eq_ignore_ascii_case(name))?;
    let index: u32 = index.parse().ok()?;
    (index < MAX_ICON_INDEX).then_some((dll, index))
}

/// A PNG of the item's thumbnail, or just its icon when `icon_only` is set. A path of the form
/// "res:imageres,123" is icon number 123 inside that system file.
pub fn thumbnail_png(path: &Path, size: u32, icon_only: bool) -> Result<Vec<u8>> {
    if let Some((dll, index)) = path.to_str().and_then(parse_resource_ref) {
        return imp::resource_icon_png(dll, index, size);
    }
    imp::thumbnail_png(path, size, icon_only)
}

/// Whether text is the id of an app in the Start menu ("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", a path
/// to a program...): printable text without anything that could steer the shell somewhere else.
pub fn is_app_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 260 && !id.contains("..") && !id.contains('/') && id.chars().all(|c| c.is_alphanumeric() || " ._!{}-\\:()&'+,".contains(c))
}

/// How many icons a system file holds (0 when it is missing).
pub fn resource_icon_count(dll: &str) -> u32 {
    ICON_DLLS.iter().find(|d| d.eq_ignore_ascii_case(dll)).map_or(0, |d| imp::resource_icon_count(d))
}

/// Encodes straight-alpha RGBA pixels as PNG.
pub fn rgba_to_png(rgba: &[u8], width: u32, height: u32) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut w = enc.write_header().map_err(std::io::Error::other)?;
        w.write_image_data(rgba).map_err(std::io::Error::other)?;
    }
    Ok(out)
}

/// True for a bare drive root such as `C:` followed by a backslash, or just `C:`.
pub fn is_drive_root(path: &Path) -> bool {
    let s = path.to_string_lossy();
    let b = s.as_bytes();
    (b.len() == 2 || (b.len() == 3 && (b[2] == b'\\' || b[2] == b'/'))) && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// Encodes BGRA pixels (top-down, as GDI returns them) as PNG. Thumbnails with
/// an all-zero alpha channel have no real alpha and are made opaque; others
/// are premultiplied and are converted to straight alpha.
pub fn bgra_to_png(bgra: &[u8], width: u32, height: u32) -> std::io::Result<Vec<u8>> {
    let opaque = bgra.chunks_exact(4).all(|p| p[3] == 0);
    let mut rgba = Vec::with_capacity(bgra.len());
    for p in bgra.chunks_exact(4) {
        let (b, g, r, a) = (p[0] as u32, p[1] as u32, p[2] as u32, p[3] as u32);
        if opaque {
            rgba.extend_from_slice(&[r as u8, g as u8, b as u8, 255]);
        } else if a == 0 {
            rgba.extend_from_slice(&[0, 0, 0, 0]);
        } else {
            let un = |c: u32| ((c * 255 + a / 2) / a).min(255) as u8;
            rgba.extend_from_slice(&[un(r), un(g), un(b), a as u8]);
        }
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut w = enc.write_header().map_err(std::io::Error::other)?;
        w.write_image_data(&rgba).map_err(std::io::Error::other)?;
    }
    Ok(out)
}

#[cfg(windows)]
mod imp {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDIBits, GetObjectW,
        HBITMAP, HGDIOBJ,
    };
    use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize};
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
    use windows::Win32::UI::Shell::{
        ExtractIconExW, IShellItemImageFactory, SHCreateItemFromParsingName, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGetFileInfoW, SIIGBF_BIGGERSIZEOK,
        SIIGBF_ICONONLY, SIIGBF_RESIZETOFIT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO, PrivateExtractIconsW};
    use windows::core::PCWSTR;

    use super::bgra_to_png;
    use crate::error::{Error, Result};

    struct Com(bool);
    impl Drop for Com {
        fn drop(&mut self) {
            if self.0 {
                // SAFETY: balances the successful CoInitializeEx on this thread.
                unsafe { CoUninitialize() };
            }
        }
    }

    /// The shell answers "not yet available" while it is busy (many requests at once, a drive waking up).
    const E_PENDING: i32 = 0x8000_000Au32 as i32;
    const RETRIES: u32 = 8;

    /// Windows' own icon or thumbnail, trying the best source the running Windows has:
    /// 1. a bare drive root: `SHGetFileInfo`, which asks the drive itself (works on every Windows version);
    /// 2. `IShellItemImageFactory` (Vista and later), retried while the shell says "not yet";
    /// 3. `SHGetFileInfo` as the last resort (also covers Windows versions or items the factory rejects).
    ///
    /// The caller falls back to Octopolis' drawn icons only when all of these fail.
    pub fn thumbnail_png(path: &Path, size: u32, icon_only: bool) -> Result<Vec<u8>> {
        // A drive's own icon (system drive logo, removable, network...) comes from the drive itself.
        // Asking the shell namespace for a bare root can return a generic folder or file icon instead.
        if icon_only
            && super::is_drive_root(path)
            && let Some(png) = sh_file_info_icon(path, true)
        {
            return Ok(png);
        }
        let mut result = fetch(path, size, icon_only);
        for attempt in 1..RETRIES {
            match &result {
                Err(Error::Io { source, .. }) if source.raw_os_error() == Some(E_PENDING) => {
                    std::thread::sleep(std::time::Duration::from_millis(40 * attempt as u64));
                    result = fetch(path, size, icon_only);
                }
                _ => break,
            }
        }
        if result.is_err()
            && icon_only
            && let Some(png) = sh_file_info_icon(path, false)
        {
            return Ok(png);
        }
        result
    }

    /// The full path of a system file, as the fixed-size wide string the icon functions take.
    fn system_file(dll: &str) -> [u16; 260] {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let path = std::path::PathBuf::from(root).join("System32").join(format!("{dll}.dll"));
        let mut out = [0u16; 260];
        for (slot, unit) in out.iter_mut().zip(path.as_os_str().encode_wide().take(259)) {
            *slot = unit;
        }
        out
    }

    pub fn resource_icon_count(dll: &str) -> u32 {
        let file = system_file(dll);
        // SAFETY: `file` is NUL-terminated; an index of -1 only asks how many icons there are.
        let n = unsafe { ExtractIconExW(PCWSTR(file.as_ptr()), -1, None, None, 0) };
        if n == u32::MAX { 0 } else { n }
    }

    /// Icon number `index` of a system file, drawn at `size` pixels.
    pub fn resource_icon_png(dll: &str, index: u32, size: u32) -> Result<Vec<u8>> {
        let file = system_file(dll);
        let side = size.clamp(16, 256) as i32;
        let mut icons = [HICON::default()];
        let name = std::path::PathBuf::from(format!("{dll}.dll"));
        // SAFETY: `file` is NUL-terminated and `icons` holds the one icon asked for.
        let got = unsafe { PrivateExtractIconsW(&file, index as i32, side, side, Some(&mut icons), None, 0) };
        if got == 0 || got == u32::MAX || icons[0].is_invalid() {
            return Err(Error::io(&name, std::io::Error::other("that icon does not exist")));
        }
        let png = hicon_to_png(icons[0]);
        // SAFETY: the icon was created for us by PrivateExtractIconsW.
        let _ = unsafe { DestroyIcon(icons[0]) };
        png.ok_or_else(|| Error::io(&name, std::io::Error::other("could not read the icon")))
    }

    /// The icon `SHGetFileInfo` reports for a path, as PNG. `None` when it cannot be read.
    fn sh_file_info_icon(path: &Path, root_only: bool) -> Option<Vec<u8>> {
        let mut wide: Vec<u16> = if root_only { path.as_os_str().encode_wide().take(2).collect() } else { path.as_os_str().encode_wide().collect() };
        if root_only {
            wide.push(u16::from(b'\\'));
        }
        wide.push(0);
        let mut info = SHFILEINFOW::default();
        // SAFETY: `wide` is NUL-terminated; `info` is the struct size passed.
        let got = unsafe {
            SHGetFileInfoW(PCWSTR(wide.as_ptr()), FILE_FLAGS_AND_ATTRIBUTES(0), Some(&mut info), size_of::<SHFILEINFOW>() as u32, SHGFI_ICON | SHGFI_LARGEICON)
        };
        if got == 0 || info.hIcon.is_invalid() {
            return None;
        }
        let png = hicon_to_png(info.hIcon);
        // SAFETY: the icon was created for us by SHGetFileInfoW.
        let _ = unsafe { DestroyIcon(info.hIcon) };
        png
    }

    fn hicon_to_png(icon: HICON) -> Option<Vec<u8>> {
        let mut ii = ICONINFO::default();
        // SAFETY: `ii` is a valid out-parameter; both bitmaps are ours to delete.
        unsafe { GetIconInfo(icon, &mut ii) }.ok()?;
        let result = (|| {
            let (w, h, color) = read_bitmap(ii.hbmColor, false)?;
            let mut rgba = Vec::with_capacity(color.len());
            let has_alpha = color.chunks_exact(4).any(|p| p[3] != 0);
            let mask = if has_alpha { None } else { Some(read_bitmap(ii.hbmMask, false)?.2) };
            for (i, p) in color.chunks_exact(4).enumerate() {
                let a = match &mask {
                    None => p[3],
                    Some(m) => if m[i * 4] == 0 { 255 } else { 0 },
                };
                rgba.extend_from_slice(&[p[2], p[1], p[0], a]);
            }
            super::rgba_to_png(&rgba, w, h).ok()
        })();
        // SAFETY: GetIconInfo handed us ownership of these bitmaps.
        unsafe {
            if !ii.hbmColor.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(ii.hbmColor.0));
            }
            if !ii.hbmMask.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(ii.hbmMask.0));
            }
        }
        result
    }

    /// Top-down BGRA pixels of a bitmap, with its size.
    fn read_bitmap(bitmap: HBITMAP, _unused: bool) -> Option<(u32, u32, Vec<u8>)> {
        let mut info = BITMAP::default();
        // SAFETY: `info` is a BITMAP of the size passed.
        let got = unsafe { GetObjectW(HGDIOBJ(bitmap.0), size_of::<BITMAP>() as i32, Some((&mut info as *mut BITMAP).cast())) };
        if got == 0 || info.bmWidth <= 0 || info.bmHeight == 0 {
            return None;
        }
        let (w, h) = (info.bmWidth, info.bmHeight.abs());
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (w as usize) * (h as usize) * 4];
        // SAFETY: the buffer holds w*h 32-bit pixels, as described by `bmi`.
        let lines = unsafe {
            let dc = CreateCompatibleDC(None);
            let n = GetDIBits(dc, bitmap, 0, h as u32, Some(pixels.as_mut_ptr().cast()), &mut bmi, DIB_RGB_COLORS);
            let _ = DeleteDC(dc);
            n
        };
        (lines != 0).then_some((w as u32, h as u32, pixels))
    }

    fn fetch(path: &Path, size: u32, icon_only: bool) -> Result<Vec<u8>> {
        // SAFETY: COM init on this thread; balanced by `Com::drop` when it succeeded.
        let _com = Com(unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok());
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let fail = |e: windows::core::Error| Error::io(path, e.into());
        // SAFETY: `wide` is NUL-terminated and outlives the call.
        let factory: IShellItemImageFactory = unsafe { SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None) }.map_err(fail)?;
        let flags = if icon_only { SIIGBF_ICONONLY } else { SIIGBF_BIGGERSIZEOK | SIIGBF_RESIZETOFIT };
        let side = size as i32;
        // SAFETY: valid COM interface; we own and delete the returned bitmap.
        let bitmap = unsafe { factory.GetImage(SIZE { cx: side, cy: side }, flags) }.map_err(fail)?;
        let result = encode(bitmap).map_err(|e| Error::io(path, e));
        // SAFETY: the bitmap was returned to us by GetImage.
        let _ = unsafe { DeleteObject(HGDIOBJ(bitmap.0)) };
        result
    }

    fn encode(bitmap: HBITMAP) -> std::io::Result<Vec<u8>> {
        let mut info = BITMAP::default();
        // SAFETY: `info` is a BITMAP of the size passed.
        let got = unsafe { GetObjectW(HGDIOBJ(bitmap.0), size_of::<BITMAP>() as i32, Some((&mut info as *mut BITMAP).cast())) };
        if got == 0 || info.bmWidth <= 0 || info.bmHeight == 0 {
            return Err(std::io::Error::other("the shell returned an empty image"));
        }
        let (w, h) = (info.bmWidth, info.bmHeight.abs());
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // negative: top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (w as usize) * (h as usize) * 4];
        // SAFETY: the buffer holds w*h 32-bit pixels, as described by `bmi`.
        let lines = unsafe {
            let dc = CreateCompatibleDC(None);
            let n = GetDIBits(dc, bitmap, 0, h as u32, Some(pixels.as_mut_ptr().cast()), &mut bmi, DIB_RGB_COLORS);
            let _ = DeleteDC(dc);
            n
        };
        if lines == 0 {
            return Err(std::io::Error::other("could not read the shell image"));
        }
        bgra_to_png(&pixels, w as u32, h as u32)
    }
}

#[cfg(not(windows))]
mod imp {
    use crate::error::{Error, Result};
    use std::path::Path;
    pub fn thumbnail_png(path: &Path, _: u32, _: bool) -> Result<Vec<u8>> {
        Err(Error::NotFound(path.into()))
    }
    pub fn resource_icon_png(dll: &str, _: u32, _: u32) -> Result<Vec<u8>> {
        Err(Error::NotFound(dll.into()))
    }
    pub fn resource_icon_count(_: &str) -> u32 {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG_MAGIC: &[u8] = &[0x89, b'P', b'N', b'G'];

    #[test]
    fn parses_resource_references() {
        assert_eq!(parse_resource_ref("res:imageres,123"), Some(("imageres", 123)));
        assert_eq!(parse_resource_ref("res:SHELL32,0"), Some(("shell32", 0)));
        for bad in ["res:evil,1", "res:imageres,-1", "res:imageres,x", "res:imageres,20000", "res:..\\imageres,1", "C:\\a.png", "res:imageres", "res:C:\\x.dll,1"] {
            assert_eq!(parse_resource_ref(bad), None, "{bad}");
        }
    }

    #[test]
    fn checks_app_ids() {
        for ok in ["Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\notepad.exe", "Microsoft.Windows.Explorer", "C:\\Program Files\\App\\a.lnk"] {
            assert!(is_app_id(ok), "{ok}");
        }
        for bad in ["", "..\\x", "a/b", "a|b", "a<b", "a\"b"] {
            assert!(!is_app_id(bad), "{bad}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn draws_icons_from_the_system_files() {
        assert!(resource_icon_count("imageres") > 100);
        assert_eq!(resource_icon_count("not-allowed"), 0);
        let png = thumbnail_png(std::path::Path::new("res:imageres,3"), 64, true).unwrap();
        assert!(png.starts_with(PNG_MAGIC));
        assert!(thumbnail_png(std::path::Path::new("res:imageres,19999"), 64, true).is_err());
    }

    #[test]
    fn encodes_bgra_as_png() {
        let png = bgra_to_png(&[10, 20, 30, 255, 0, 0, 0, 0], 2, 1).unwrap();
        assert!(png.starts_with(PNG_MAGIC));
    }

    #[cfg(windows)]
    #[test]
    fn shell_gives_an_icon_for_a_real_file() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("doc.txt");
        std::fs::write(&f, b"hi").unwrap();
        let png = thumbnail_png(&f, 32, true).unwrap();
        assert!(png.starts_with(PNG_MAGIC));
    }

    #[cfg(windows)]
    #[test]
    fn missing_file_is_an_error() {
        assert!(thumbnail_png(Path::new(r"C:\definitely\not\here.txt"), 32, true).is_err());
    }
}
