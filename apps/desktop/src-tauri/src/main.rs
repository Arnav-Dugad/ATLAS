// ATLAS desktop: a native window around the web interface, with the Python engine bundled
// alongside it. The engine serves on 127.0.0.1 (8787, or a free port when 8787 is taken),
// and stops when the app exits. Data lives in the user's application-data folder.
//
// Windows: the engine is a PyInstaller folder in the app's resources (no unpacking on each
// start), the app lives in the tray when "keep running in the background" is on, and handles
// atlas:// links and jump-list actions. macOS/Linux keep the one-file sidecar.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
mod jumplist;

use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_shell::process::CommandChild;
#[cfg(not(windows))]
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

const DEFAULT_PORT: u16 = 8787;

enum EngineChild {
    #[cfg(windows)]
    Process(std::process::Child),
    #[cfg_attr(windows, allow(dead_code))]
    Sidecar(CommandChild),
}

struct Engine(Mutex<Option<EngineChild>>);
struct EngineUrl(String);

/// Things the web interface asks for once it has loaded: deep links and jump-list actions
/// that arrived before it was listening.
#[derive(Default, Clone, Serialize)]
struct Pending {
    links: Vec<String>,
    actions: Vec<String>,
}
struct PendingState(Mutex<Pending>);

/// Desktop-only preferences the native side needs before the web interface runs.
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct DesktopPrefs {
    /// closing the window keeps ATLAS (and watch alerts) running in the tray
    background: bool,
}
struct Prefs(Mutex<DesktopPrefs>);

fn prefs_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|dir| dir.join("desktop.json"))
}

fn load_prefs(app: &AppHandle) -> DesktopPrefs {
    prefs_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_prefs(app: &AppHandle, prefs: &DesktopPrefs) {
    if let Some(path) = prefs_path(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(prefs) {
            let _ = std::fs::write(path, json);
        }
    }
}

/// 8787 when it is free (so bookmarks and the docs stay right), otherwise any free port.
fn pick_port() -> u16 {
    if TcpListener::bind(("127.0.0.1", DEFAULT_PORT)).is_ok() {
        return DEFAULT_PORT;
    }
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .unwrap_or(DEFAULT_PORT)
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn actions_in(args: &[String]) -> Vec<String> {
    args.iter()
        .filter_map(|a| a.strip_prefix("--action="))
        .map(str::to_string)
        .collect()
}

#[cfg(windows)]
fn spawn_engine(app: &tauri::App, port: u16) -> Result<EngineChild, Box<dyn std::error::Error>> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let exe = app.path().resource_dir()?.join("engine").join("atlas-engine.exe");
    let child = Command::new(exe)
        .env("ATLAS_PARENT_PID", std::process::id().to_string())
        .env("ATLAS_PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()?;
    Ok(EngineChild::Process(child))
}

#[cfg(not(windows))]
fn spawn_engine(app: &tauri::App, port: u16) -> Result<EngineChild, Box<dyn std::error::Error>> {
    // The engine also watches this process and stops itself if the app exits without the
    // clean-up below (a crash), since a one-file sidecar runs the engine as a child.
    let (mut events, child) = app
        .shell()
        .sidecar("atlas-engine")?
        .env("ATLAS_PARENT_PID", std::process::id().to_string())
        .env("ATLAS_PORT", port.to_string())
        .spawn()?;
    // Drain the engine's output so its pipes never fill up.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            if let CommandEvent::Terminated(status) = event {
                eprintln!("ATLAS engine exited: {status:?}");
            }
        }
    });
    Ok(EngineChild::Sidecar(child))
}

fn stop_engine(app: &AppHandle) {
    if let Some(engine) = app.try_state::<Engine>() {
        if let Some(child) = engine.0.lock().expect("engine lock").take() {
            match child {
                #[cfg(windows)]
                EngineChild::Process(mut process) => {
                    let _ = process.kill();
                    let _ = process.wait();
                }
                EngineChild::Sidecar(sidecar) => {
                    let _ = sidecar.kill();
                }
            }
        }
    }
}

#[tauri::command]
fn engine_url(url: tauri::State<'_, EngineUrl>) -> String {
    url.0.clone()
}

#[tauri::command]
fn take_pending(pending: tauri::State<'_, PendingState>) -> Pending {
    std::mem::take(&mut *pending.0.lock().expect("pending lock"))
}

#[tauri::command]
fn desktop_prefs(prefs: tauri::State<'_, Prefs>) -> DesktopPrefs {
    prefs.0.lock().expect("prefs lock").clone()
}

#[tauri::command]
fn set_desktop_prefs(app: AppHandle, prefs: tauri::State<'_, Prefs>, value: DesktopPrefs) {
    *prefs.0.lock().expect("prefs lock") = value.clone();
    save_prefs(&app, &value);
}

#[cfg(windows)]
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "Show ATLAS", true, None::<&str>)?;
    let story = MenuItem::with_id(app, "story", "Play the planet story", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit ATLAS", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &story, &separator, &quit])?;
    let mut tray = TrayIconBuilder::with_id("atlas")
        .tooltip("ATLAS — planetary disaster intelligence")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "story" => {
                show_main(app);
                let _ = app.emit("jump-action", "story");
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn main() {
    #[cfg(windows)]
    jumplist::claim_app_id();
    let app = tauri::Builder::default()
        // must be first: a second launch (or an atlas:// link) focuses this instance instead
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            show_main(app);
            for action in actions_in(&args) {
                let _ = app.emit("jump-action", action);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![engine_url, take_pending, desktop_prefs, set_desktop_prefs])
        .setup(|app| {
            let handle = app.handle().clone();
            let prefs = load_prefs(&handle);
            let args: Vec<String> = std::env::args().collect();
            let minimized = args.iter().any(|a| a == "--minimized") && prefs.background;
            app.manage(Prefs(Mutex::new(prefs)));
            if !minimized {
                show_main(&handle); // the Windows window starts hidden so a tray start never flashes
            }

            let mut pending = Pending { links: Vec::new(), actions: actions_in(&args) };
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                pending.links.extend(urls.into_iter().map(|u| u.to_string()));
            }
            app.manage(PendingState(Mutex::new(pending)));
            {
                let handle = handle.clone();
                app.deep_link().on_open_url(move |event| {
                    show_main(&handle);
                    for url in event.urls() {
                        let _ = handle.emit("deep-link", url.to_string());
                    }
                });
            }
            #[cfg(windows)]
            {
                // installers register atlas:// too; this covers portable copies
                let _ = app.deep_link().register("atlas");
                let _ = build_tray(app);
                jumplist::install();
            }

            let port = pick_port();
            app.manage(EngineUrl(format!("http://127.0.0.1:{port}")));
            let child = spawn_engine(app, port).expect("failed to start the ATLAS engine");
            app.manage(Engine(Mutex::new(Some(child))));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let background = window
                    .app_handle()
                    .try_state::<Prefs>()
                    .map(|p| p.0.lock().map(|p| p.background).unwrap_or(false))
                    .unwrap_or(false);
                if background && cfg!(windows) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building ATLAS");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            stop_engine(handle);
        }
    });
}
