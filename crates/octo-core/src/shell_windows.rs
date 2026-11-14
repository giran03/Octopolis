//! Lets other apps' "Show in folder" land in Octopolis. Each folder Octopolis
//! is showing is listed in the Windows shell windows table, the same table
//! File Explorer windows are in. When an app asks Windows to show a file in a
//! folder that is listed, Windows asks that window to select the file instead
//! of opening File Explorer.
//!
//! Everything here is the documented `IShellWindows` API and runs inside
//! Octopolis; nothing is loaded into other programs. A folder no Octopolis tab
//! is showing still opens in File Explorer: Windows does not consult the
//! folder-open setting for that.

use std::path::Path;

/// A file another app asked to be shown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selected {
    /// The folder as it was given to [`Registry::sync`].
    pub folder: String,
    /// Full path of the item to select.
    pub item: String,
    /// Replace the current selection (the first item of a request) rather than add to it.
    pub replace: bool,
}

/// Case-insensitive, trailing-slash-insensitive key for a folder.
pub fn folder_key(path: &str) -> String {
    let trimmed = path.trim_end_matches(['\\', '/']);
    // A bare drive ("C:") keeps its slash so it still names the root.
    let kept = if trimmed.len() == 2 && trimmed.ends_with(':') { format!("{trimmed}\\") } else { trimmed.to_string() };
    kept.replace('/', "\\").to_lowercase()
}

/// `file:` address of a folder, as File Explorer windows report theirs.
pub fn folder_url(path: &str) -> String {
    let mut out = String::from("file:///");
    let unc = path.strip_prefix("\\\\");
    if let Some(rest) = unc {
        out = String::from("file://");
        push_escaped(&mut out, rest);
    } else {
        push_escaped(&mut out, path);
    }
    out
}

fn push_escaped(out: &mut String, path: &str) {
    for b in path.bytes() {
        match b {
            b'\\' => out.push('/'),
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b':' | b'-' | b'_' | b'.' | b'~' | b'!' | b'$' | b'&' | b'\'' | b'(' | b')' | b'+' | b',' | b';' | b'=' | b'@' => {
                out.push(b as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
}

/// What to add and remove so the listed folders become `wanted`. Compared by [`folder_key`].
pub fn diff(current: &[String], wanted: &[String]) -> (Vec<String>, Vec<String>) {
    let cur: Vec<String> = current.iter().map(|p| folder_key(p)).collect();
    let mut seen = Vec::new();
    let mut add = Vec::new();
    for w in wanted {
        let key = folder_key(w);
        if seen.contains(&key) {
            continue;
        }
        if !cur.contains(&key) {
            add.push(w.clone());
        }
        seen.push(key);
    }
    let remove = current.iter().filter(|c| !seen.contains(&folder_key(c))).cloned().collect();
    (add, remove)
}

fn folder_name(path: &str) -> String {
    Path::new(path).file_name().map_or_else(|| path.to_string(), |n| n.to_string_lossy().into_owned())
}

/// Octopolis's entries in the shell windows table. Dropping it removes them.
pub struct Registry {
    inner: imp::Worker,
}

impl Registry {
    /// `hwnd` is the main window. `on_select` runs on a background thread each
    /// time another app asks for an item to be shown; keep it quick.
    pub fn start(hwnd: isize, on_select: impl Fn(Selected) + Send + Sync + 'static) -> Registry {
        Registry { inner: imp::Worker::start(hwnd, std::sync::Arc::new(on_select)) }
    }

    /// Sets the folders Octopolis is showing. Folders that are not real
    /// file-system folders are skipped.
    pub fn sync(&self, folders: Vec<String>) {
        self.inner.sync(folders);
    }
}

#[cfg(windows)]
mod imp {
    #![allow(non_snake_case)]

    use std::ffi::c_void;
    use std::sync::Arc;
    use std::sync::mpsc::{Sender, channel};

    use windows::Win32::Foundation::{
        DISP_E_UNKNOWNNAME, E_FAIL, E_NOTIMPL, HWND, LPARAM, LRESULT, RECT, SHANDLE_PTR, VARIANT_BOOL, VARIANT_FALSE, VARIANT_TRUE, WPARAM,
    };
    use windows::Win32::System::Com::{
        CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize, DISPATCH_FLAGS, DISPPARAMS, EXCEPINFO, IDispatch, IDispatch_Impl,
        IServiceProvider, IServiceProvider_Impl, IStream, ITypeInfo,
    };
    use windows::Win32::System::Ole::{
        IOleWindow_Impl, LoadRegTypeLib, OLEMENUGROUPWIDTHS, SafeArrayAccessData, SafeArrayCreateVector, SafeArrayUnaccessData,
    };
    use windows::Win32::System::Variant::{VARENUM, VARIANT, VT_ARRAY, VT_UI1, VariantClear};
    use windows::Win32::UI::Controls::{LPFNSVADDPROPSHEETPAGE, TBBUTTON};
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{
        _SVGIO, FOLDERSETTINGS, GPFIDL_DEFAULT, ILCombine, ILCreateFromPathW, ILFree, ILGetSize, IShellBrowser, IShellBrowser_Impl, IShellView, IShellView_Impl,
        IShellWindows, IWebBrowser_Impl, IWebBrowserApp, IWebBrowserApp_Impl, SHGetPathFromIDListEx, SVSI_DESELECTOTHERS, SWC_BROWSER, ShellWindows,
    };
    use windows::Win32::UI::WindowsAndMessaging::{HMENU, MSG};
    use windows::core::{BOOL, BSTR, GUID, HRESULT, IUnknownImpl, Interface, PCWSTR, Ref, Result, implement};

    use super::{Selected, diff, folder_key, folder_name, folder_url};

    type OnSelect = Arc<dyn Fn(Selected) + Send + Sync>;

    /// The type library that describes `IWebBrowserApp` ("Microsoft Internet Controls").
    const LIBID_SHDOCVW: GUID = GUID::from_u128(0xEAB22AC0_30C1_11CF_A7EB_0000C05BAE0B);

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn not_impl<T>() -> Result<T> {
        Err(E_NOTIMPL.into())
    }

    /// Frees an item id list when dropped.
    struct Pidl(*mut ITEMIDLIST);
    impl Pidl {
        fn from_path(path: &str) -> Option<Pidl> {
            // SAFETY: `path` is NUL-terminated; the result is freed in `drop`.
            let p = unsafe { ILCreateFromPathW(PCWSTR(wide(path).as_ptr())) };
            (!p.is_null()).then_some(Pidl(p))
        }
    }
    impl Drop for Pidl {
        fn drop(&mut self) {
            // SAFETY: allocated by the shell and not freed elsewhere.
            unsafe { ILFree(Some(self.0)) };
        }
    }

    /// The folder view: receives the items another app wants shown.
    #[implement(IShellView)]
    struct View {
        hwnd: HWND,
        folder: String,
        on_select: OnSelect,
    }

    impl IOleWindow_Impl for View_Impl {
        fn GetWindow(&self) -> Result<HWND> {
            Ok(self.hwnd)
        }
        fn ContextSensitiveHelp(&self, _: BOOL) -> Result<()> {
            not_impl()
        }
    }

    impl IShellView_Impl for View_Impl {
        fn TranslateAccelerator(&self, _: *const MSG) -> HRESULT {
            E_NOTIMPL
        }
        fn EnableModeless(&self, _: BOOL) -> Result<()> {
            not_impl()
        }
        fn UIActivate(&self, _: u32) -> Result<()> {
            Ok(())
        }
        fn Refresh(&self) -> Result<()> {
            Ok(())
        }
        fn CreateViewWindow(&self, _: Ref<IShellView>, _: *const FOLDERSETTINGS, _: Ref<IShellBrowser>, _: *const RECT) -> Result<HWND> {
            not_impl()
        }
        fn DestroyViewWindow(&self) -> Result<()> {
            not_impl()
        }
        fn GetCurrentInfo(&self) -> Result<FOLDERSETTINGS> {
            not_impl()
        }
        fn AddPropertySheetPages(&self, _: u32, _: LPFNSVADDPROPSHEETPAGE, _: LPARAM) -> Result<()> {
            not_impl()
        }
        fn SaveViewState(&self) -> Result<()> {
            not_impl()
        }
        fn SelectItem(&self, item: *const ITEMIDLIST, flags: u32) -> Result<()> {
            if item.is_null() {
                return Ok(());
            }
            let folder = Pidl::from_path(&self.folder).ok_or(E_FAIL)?;
            let mut buf = vec![0u16; 4096];
            // SAFETY: `item` is a child id list supplied by the caller for the duration of the call;
            // the combined list is freed by `Pidl`.
            let found = unsafe {
                let full = Pidl(ILCombine(Some(folder.0), Some(item)));
                !full.0.is_null() && SHGetPathFromIDListEx(full.0, &mut buf, GPFIDL_DEFAULT).as_bool()
            };
            if !found {
                return Err(E_FAIL.into());
            }
            let len = buf.iter().position(|&c| c == 0).unwrap_or(0);
            (self.on_select)(Selected {
                folder: self.folder.clone(),
                item: String::from_utf16_lossy(&buf[..len]),
                replace: flags & SVSI_DESELECTOTHERS.0 as u32 != 0,
            });
            Ok(())
        }
        fn GetItemObject(&self, _: &_SVGIO, _: *const GUID, _: *mut *mut c_void) -> Result<()> {
            not_impl()
        }
    }

    /// The frame around the view; only hands out the view.
    #[implement(IShellBrowser)]
    struct Browser {
        hwnd: HWND,
        view: IShellView,
    }

    impl IOleWindow_Impl for Browser_Impl {
        fn GetWindow(&self) -> Result<HWND> {
            Ok(self.hwnd)
        }
        fn ContextSensitiveHelp(&self, _: BOOL) -> Result<()> {
            not_impl()
        }
    }

    impl IShellBrowser_Impl for Browser_Impl {
        fn InsertMenusSB(&self, _: HMENU, _: *mut OLEMENUGROUPWIDTHS) -> Result<()> {
            not_impl()
        }
        fn SetMenuSB(&self, _: HMENU, _: isize, _: HWND) -> Result<()> {
            not_impl()
        }
        fn RemoveMenusSB(&self, _: HMENU) -> Result<()> {
            not_impl()
        }
        fn SetStatusTextSB(&self, _: &PCWSTR) -> Result<()> {
            not_impl()
        }
        fn EnableModelessSB(&self, _: BOOL) -> Result<()> {
            not_impl()
        }
        fn TranslateAcceleratorSB(&self, _: *const MSG, _: u16) -> Result<()> {
            not_impl()
        }
        fn BrowseObject(&self, _: *const ITEMIDLIST, _: u32) -> Result<()> {
            not_impl()
        }
        fn GetViewStateStream(&self, _: u32) -> Result<IStream> {
            not_impl()
        }
        fn GetControlWindow(&self, _: u32) -> Result<HWND> {
            not_impl()
        }
        fn SendControlMsg(&self, _: u32, _: u32, _: WPARAM, _: LPARAM, _: *mut LRESULT) -> Result<()> {
            not_impl()
        }
        fn QueryActiveShellView(&self) -> Result<IShellView> {
            Ok(self.view.clone())
        }
        fn OnViewWindowActive(&self, _: Ref<IShellView>) -> Result<()> {
            not_impl()
        }
        fn SetToolbarItems(&self, _: *const TBBUTTON, _: u32, _: u32) -> Result<()> {
            not_impl()
        }
    }

    /// Answers a service request with the browser or its view, whichever has the interface.
    fn service(browser: &IShellBrowser, riid: *const GUID, out: *mut *mut c_void) -> Result<()> {
        // SAFETY: `riid` and `out` come from COM and are valid for the call.
        unsafe {
            if browser.query(riid, out).is_ok() {
                return Ok(());
            }
            browser.QueryActiveShellView()?.query(riid, out).ok()
        }
    }

    /// The window's "document". Windows 11 reaches the view through it.
    #[implement(IDispatch, IServiceProvider)]
    struct Document {
        browser: IShellBrowser,
    }

    impl IDispatch_Impl for Document_Impl {
        fn GetTypeInfoCount(&self) -> Result<u32> {
            Ok(0)
        }
        fn GetTypeInfo(&self, _: u32, _: u32) -> Result<ITypeInfo> {
            not_impl()
        }
        fn GetIDsOfNames(&self, _: *const GUID, _: *const PCWSTR, _: u32, _: u32, _: *mut i32) -> Result<()> {
            Err(DISP_E_UNKNOWNNAME.into())
        }
        fn Invoke(&self, _: i32, _: *const GUID, _: u32, _: DISPATCH_FLAGS, _: *const DISPPARAMS, _: *mut VARIANT, _: *mut EXCEPINFO, _: *mut u32) -> Result<()> {
            not_impl()
        }
    }

    impl IServiceProvider_Impl for Document_Impl {
        fn QueryService(&self, _: *const GUID, riid: *const GUID, out: *mut *mut c_void) -> Result<()> {
            service(&self.browser, riid, out)
        }
    }

    /// One listed folder, as the shell windows table sees it: the same shape
    /// as a File Explorer window, with only the parts other apps read filled in.
    #[implement(IWebBrowserApp, IServiceProvider)]
    struct Window {
        hwnd: HWND,
        folder: String,
        browser: IShellBrowser,
        /// Describes `IWebBrowserApp`, so scripts can read the properties by name.
        type_info: Option<ITypeInfo>,
    }

    impl IDispatch_Impl for Window_Impl {
        fn GetTypeInfoCount(&self) -> Result<u32> {
            Ok(u32::from(self.type_info.is_some()))
        }
        fn GetTypeInfo(&self, index: u32, _: u32) -> Result<ITypeInfo> {
            if index != 0 {
                return not_impl();
            }
            self.type_info.clone().ok_or_else(|| E_NOTIMPL.into())
        }
        fn GetIDsOfNames(&self, _: *const GUID, names: *const PCWSTR, count: u32, _: u32, ids: *mut i32) -> Result<()> {
            let info = self.type_info.as_ref().ok_or(DISP_E_UNKNOWNNAME)?;
            // SAFETY: COM passes `count` names and room for as many ids.
            unsafe { info.GetIDsOfNames(names, count, ids) }
        }
        fn Invoke(&self, id: i32, _: *const GUID, _: u32, flags: DISPATCH_FLAGS, params: *const DISPPARAMS, result: *mut VARIANT, except: *mut EXCEPINFO, arg_err: *mut u32) -> Result<()> {
            let info = self.type_info.as_ref().ok_or(E_NOTIMPL)?;
            let this: IWebBrowserApp = self.to_interface();
            // SAFETY: the type description routes the call to this object's own methods; the pointers are COM's.
            unsafe { info.Invoke(this.as_raw(), id, flags, params.cast_mut(), result, except, arg_err) }
        }
    }

    impl IWebBrowser_Impl for Window_Impl {
        fn GoBack(&self) -> Result<()> {
            not_impl()
        }
        fn GoForward(&self) -> Result<()> {
            not_impl()
        }
        fn GoHome(&self) -> Result<()> {
            not_impl()
        }
        fn GoSearch(&self) -> Result<()> {
            not_impl()
        }
        fn Navigate(&self, _: &BSTR, _: *const VARIANT, _: *const VARIANT, _: *const VARIANT, _: *const VARIANT) -> Result<()> {
            not_impl()
        }
        fn Refresh(&self) -> Result<()> {
            not_impl()
        }
        fn Refresh2(&self, _: *const VARIANT) -> Result<()> {
            not_impl()
        }
        fn Stop(&self) -> Result<()> {
            not_impl()
        }
        fn Application(&self) -> Result<IDispatch> {
            not_impl()
        }
        fn Parent(&self) -> Result<IDispatch> {
            not_impl()
        }
        fn Container(&self) -> Result<IDispatch> {
            not_impl()
        }
        fn Document(&self) -> Result<IDispatch> {
            Ok(Document { browser: self.browser.clone() }.into())
        }
        fn TopLevelContainer(&self) -> Result<VARIANT_BOOL> {
            Ok(VARIANT_TRUE)
        }
        fn Type(&self) -> Result<BSTR> {
            not_impl()
        }
        fn Left(&self) -> Result<i32> {
            not_impl()
        }
        fn SetLeft(&self, _: i32) -> Result<()> {
            not_impl()
        }
        fn Top(&self) -> Result<i32> {
            not_impl()
        }
        fn SetTop(&self, _: i32) -> Result<()> {
            not_impl()
        }
        fn Width(&self) -> Result<i32> {
            not_impl()
        }
        fn SetWidth(&self, _: i32) -> Result<()> {
            not_impl()
        }
        fn Height(&self) -> Result<i32> {
            not_impl()
        }
        fn SetHeight(&self, _: i32) -> Result<()> {
            not_impl()
        }
        fn LocationName(&self) -> Result<BSTR> {
            Ok(BSTR::from(folder_name(&self.folder)))
        }
        fn LocationURL(&self) -> Result<BSTR> {
            Ok(BSTR::from(folder_url(&self.folder)))
        }
        fn Busy(&self) -> Result<VARIANT_BOOL> {
            Ok(VARIANT_FALSE)
        }
    }

    impl IWebBrowserApp_Impl for Window_Impl {
        /// Other tools use this to close File Explorer windows; Octopolis stays open.
        fn Quit(&self) -> Result<()> {
            not_impl()
        }
        fn ClientToWindow(&self, _: *mut i32, _: *mut i32) -> Result<()> {
            not_impl()
        }
        fn PutProperty(&self, _: &BSTR, _: &VARIANT) -> Result<()> {
            not_impl()
        }
        fn GetProperty(&self, _: &BSTR) -> Result<VARIANT> {
            Ok(VARIANT::default())
        }
        fn Name(&self) -> Result<BSTR> {
            Ok(BSTR::from("Octopolis"))
        }
        fn HWND(&self) -> Result<SHANDLE_PTR> {
            Ok(SHANDLE_PTR(self.hwnd.0 as isize))
        }
        fn FullName(&self) -> Result<BSTR> {
            let exe = std::env::current_exe().map_err(|_| E_FAIL)?;
            Ok(BSTR::from(exe.to_string_lossy().as_ref()))
        }
        fn Path(&self) -> Result<BSTR> {
            let exe = std::env::current_exe().map_err(|_| E_FAIL)?;
            Ok(BSTR::from(exe.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()))
        }
        fn Visible(&self) -> Result<VARIANT_BOOL> {
            Ok(VARIANT_TRUE)
        }
        fn SetVisible(&self, _: VARIANT_BOOL) -> Result<()> {
            not_impl()
        }
        fn StatusBar(&self) -> Result<VARIANT_BOOL> {
            Ok(VARIANT_FALSE)
        }
        fn SetStatusBar(&self, _: VARIANT_BOOL) -> Result<()> {
            not_impl()
        }
        fn StatusText(&self) -> Result<BSTR> {
            Ok(BSTR::new())
        }
        fn SetStatusText(&self, _: &BSTR) -> Result<()> {
            not_impl()
        }
        fn ToolBar(&self) -> Result<i32> {
            Ok(0)
        }
        fn SetToolBar(&self, _: i32) -> Result<()> {
            not_impl()
        }
        fn MenuBar(&self) -> Result<VARIANT_BOOL> {
            Ok(VARIANT_FALSE)
        }
        fn SetMenuBar(&self, _: VARIANT_BOOL) -> Result<()> {
            not_impl()
        }
        fn FullScreen(&self) -> Result<VARIANT_BOOL> {
            Ok(VARIANT_FALSE)
        }
        fn SetFullScreen(&self, _: VARIANT_BOOL) -> Result<()> {
            not_impl()
        }
    }

    /// Older Windows versions ask the window itself for the browser.
    impl IServiceProvider_Impl for Window_Impl {
        fn QueryService(&self, _: *const GUID, riid: *const GUID, out: *mut *mut c_void) -> Result<()> {
            service(&self.browser, riid, out)
        }
    }

    /// The folder's id list as the byte-array VARIANT the shell windows table expects.
    fn location(folder: &str) -> Option<VARIANT> {
        let pidl = Pidl::from_path(folder)?;
        // SAFETY: the array is created with the id list's size and filled while locked.
        unsafe {
            let size = ILGetSize(Some(pidl.0));
            let array = SafeArrayCreateVector(VT_UI1, 0, size);
            if array.is_null() {
                return None;
            }
            let mut data = std::ptr::null_mut();
            SafeArrayAccessData(array, &mut data).ok()?;
            std::ptr::copy_nonoverlapping(pidl.0.cast::<u8>(), data.cast::<u8>(), size as usize);
            SafeArrayUnaccessData(array).ok()?;
            let mut v = VARIANT::default();
            (*v.Anonymous.Anonymous).vt = VARENUM(VT_ARRAY.0 | VT_UI1.0);
            (*v.Anonymous.Anonymous).Anonymous.parray = array;
            Some(v)
        }
    }

    struct Table {
        hwnd: HWND,
        on_select: OnSelect,
        shell: IShellWindows,
        type_info: Option<ITypeInfo>,
        /// Listed folders with their cookies. The table itself keeps the window objects alive.
        listed: Vec<(String, i32)>,
    }

    impl Table {
        fn add(&mut self, folder: &str) {
            let Some(mut loc) = location(folder) else { return };
            let view: IShellView = View { hwnd: self.hwnd, folder: folder.to_string(), on_select: self.on_select.clone() }.into();
            let browser: IShellBrowser = Browser { hwnd: self.hwnd, view }.into();
            let window: IWebBrowserApp = Window { hwnd: self.hwnd, folder: folder.to_string(), browser, type_info: self.type_info.clone() }.into();
            // SAFETY: plain calls on the shell windows table; `loc` is cleared afterwards.
            unsafe {
                // Window handles fit in 32 bits, which is all this API takes.
                if let Ok(cookie) = self.shell.Register(&window, self.hwnd.0 as i32, SWC_BROWSER) {
                    if self.shell.OnNavigate(cookie, &loc).is_ok() {
                        self.listed.push((folder.to_string(), cookie));
                    } else {
                        let _ = self.shell.Revoke(cookie);
                    }
                }
                let _ = VariantClear(&mut loc);
            }
        }

        fn remove(&mut self, folder: &str) {
            let key = folder_key(folder);
            self.listed.retain(|(f, cookie)| {
                if folder_key(f) != key {
                    return true;
                }
                // SAFETY: the cookie came from `Register`.
                let _ = unsafe { self.shell.Revoke(*cookie) };
                false
            });
        }

        fn sync(&mut self, wanted: &[String]) {
            let current: Vec<String> = self.listed.iter().map(|(f, _)| f.clone()).collect();
            let (add, remove) = diff(&current, wanted);
            for f in &remove {
                self.remove(f);
            }
            for f in &add {
                self.add(f);
            }
        }
    }

    fn run(hwnd: isize, on_select: OnSelect, commands: std::sync::mpsc::Receiver<Vec<String>>) {
        // SAFETY: COM is set up for this thread and torn down when it ends. In the multithreaded
        // apartment, calls from other apps arrive on COM's own threads; this one only waits.
        unsafe {
            if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
                return;
            }
            if let Ok(shell) = CoCreateInstance::<_, IShellWindows>(&ShellWindows, None, CLSCTX_ALL) {
                let type_info = LoadRegTypeLib(&LIBID_SHDOCVW, 1, 1, 0).and_then(|lib| lib.GetTypeInfoOfGuid(&IWebBrowserApp::IID)).ok();
                let mut table = Table { hwnd: HWND(hwnd as *mut c_void), on_select, shell, type_info, listed: Vec::new() };
                // Ends when the `Registry` is dropped.
                while let Ok(wanted) = commands.recv() {
                    table.sync(&wanted);
                }
                table.sync(&[]);
            }
            CoUninitialize();
        }
    }

    pub struct Worker {
        commands: Sender<Vec<String>>,
    }

    impl Worker {
        pub fn start(hwnd: isize, on_select: OnSelect) -> Worker {
            let (commands, rx) = channel();
            std::thread::spawn(move || run(hwnd, on_select, rx));
            Worker { commands }
        }

        pub fn sync(&self, folders: Vec<String>) {
            let _ = self.commands.send(folders);
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use std::sync::Arc;

    use super::Selected;

    pub struct Worker;

    impl Worker {
        pub fn start(_: isize, _: Arc<dyn Fn(Selected) + Send + Sync>) -> Worker {
            Worker
        }
        pub fn sync(&self, _: Vec<String>) {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn folders_compare_without_case_or_trailing_slash() {
        assert_eq!(folder_key("C:\\Users\\Ann\\"), folder_key("c:/users/ann"));
        assert_eq!(folder_key("C:\\"), "c:\\");
        assert_eq!(folder_key("C:"), "c:\\");
    }

    #[test]
    fn diff_adds_new_folders_and_removes_closed_ones() {
        let (add, remove) = diff(&s(&["C:\\a", "C:\\b"]), &s(&["c:\\A\\", "C:\\c", "C:\\c"]));
        assert_eq!(add, s(&["C:\\c"]), "a folder open in two tabs is listed once");
        assert_eq!(remove, s(&["C:\\b"]));
        assert_eq!(diff(&s(&["C:\\a"]), &[]), (vec![], s(&["C:\\a"])));
    }

    #[test]
    fn folder_addresses_match_file_explorers() {
        assert_eq!(folder_url("C:\\Users\\Ann\\My Files"), "file:///C:/Users/Ann/My%20Files");
        assert_eq!(folder_url("\\\\nas\\share\\x"), "file://nas/share/x");
        assert_eq!(folder_url("D:\\caf\u{e9}"), "file:///D:/caf%C3%A9");
    }
}
