//! Shell thumbnails and icons (`IShellItemImageFactory`), encoded as PNG.

use std::path::Path;

use crate::error::Result;

/// A PNG of the item's thumbnail, or just its icon when `icon_only` is set.
pub fn thumbnail_png(path: &Path, size: u32, icon_only: bool) -> Result<Vec<u8>> {
    imp::thumbnail_png(path, size, icon_only)
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
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_ICONONLY, SIIGBF_RESIZETOFIT,
    };
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

    pub fn thumbnail_png(path: &Path, size: u32, icon_only: bool) -> Result<Vec<u8>> {
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
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG_MAGIC: &[u8] = &[0x89, b'P', b'N', b'G'];

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
