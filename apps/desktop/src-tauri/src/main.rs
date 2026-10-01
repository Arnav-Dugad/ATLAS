// ATLAS desktop: a native window around the web interface, with the Python engine bundled as a
// sidecar (`atlas-engine`, built with PyInstaller). The engine serves on 127.0.0.1:8787 and is
// stopped when the app exits. Data lives in the user's application-data folder.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use tauri::{Manager, RunEvent};
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};

struct Engine(Mutex<Option<CommandChild>>);

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // The engine also watches this process and stops itself if the app exits without
            // the clean-up below (a crash), since a one-file sidecar runs the engine as a child.
            let (mut events, child) = app
                .shell()
                .sidecar("atlas-engine")
                .expect("the atlas-engine sidecar is bundled with the app")
                .env("ATLAS_PARENT_PID", std::process::id().to_string())
                .spawn()
                .expect("failed to start the ATLAS engine");
            // Drain the engine's output so its pipes never fill up.
            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    if let CommandEvent::Terminated(status) = event {
                        eprintln!("ATLAS engine exited: {status:?}");
                    }
                }
            });
            app.manage(Engine(Mutex::new(Some(child))));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building ATLAS");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(engine) = handle.try_state::<Engine>() {
                if let Some(child) = engine.0.lock().expect("engine lock").take() {
                    let _ = child.kill();
                }
            }
        }
    });
}
