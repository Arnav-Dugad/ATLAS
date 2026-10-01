//! Windows taskbar jump list: right-click the ATLAS icon for quick actions. Each task starts
//! ATLAS with `--action=…`; the single-instance plugin hands that to the running copy, which
//! performs it (or the new copy does, if ATLAS was not running). Failures are only logged:
//! a missing jump list must never stop the app.

use windows::core::{Interface, HSTRING};
use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{
    DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, SetCurrentProcessExplicitAppUserModelID, ShellLink,
};

/// Must match `identifier` in tauri.conf.json (the installer's shortcuts and notifications use it).
pub const APP_ID: &str = "org.atlas.planetary";

const TASKS: [(&str, &str, &str); 4] = [
    ("Play the planet story", "--action=story", "A one-minute guided tour of what is happening now"),
    ("New watch area", "--action=watch", "Get alerts for a place you care about"),
    ("Search incidents", "--action=search", "Open the command palette"),
    ("Settings", "--action=settings", "Keys, data packs, appearance and graphics"),
];

/// Call before any window exists, so the taskbar button, jump list and notifications share one identity.
pub fn claim_app_id() {
    if let Err(e) = unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(APP_ID)) } {
        eprintln!("jump list: could not set the app ID: {e}");
    }
}

/// Writes the list on its own thread (its own COM apartment, off the UI thread).
pub fn install() {
    std::thread::spawn(|| {
        if let Err(e) = unsafe { write_list() } {
            eprintln!("jump list: {e}");
        }
    });
}

unsafe fn write_list() -> windows::core::Result<()> {
    let exe = std::env::current_exe().map_err(|e| windows::core::Error::new(windows::Win32::Foundation::E_FAIL, e.to_string()))?;
    let exe = HSTRING::from(exe.as_os_str());
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.ok()?;
    let written = unsafe {
        (|| {
            let list: ICustomDestinationList = CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
            list.SetAppID(&HSTRING::from(APP_ID))?;
            let mut slots = 0u32;
            let _removed: IObjectArray = list.BeginList(&mut slots)?;
            let tasks: IObjectCollection = CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
            for (title, args, description) in TASKS {
                let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
                link.SetPath(&exe)?;
                link.SetArguments(&HSTRING::from(args))?;
                link.SetIconLocation(&exe, 0)?;
                link.SetDescription(&HSTRING::from(description))?;
                // a task's visible title lives in the link's property store
                let properties: IPropertyStore = link.cast()?;
                properties.SetValue(&PKEY_Title, &PROPVARIANT::from(title))?;
                properties.Commit()?;
                tasks.AddObject(&link)?;
            }
            list.AddUserTasks(&tasks.cast::<IObjectArray>()?)?;
            list.CommitList()
        })()
    };
    unsafe { CoUninitialize() };
    written
}
