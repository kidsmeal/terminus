mod project;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::Emitter;

struct PtyInstance {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

struct AppState {
    ptys: Mutex<HashMap<u32, PtyInstance>>,
    next_id: AtomicU32,
    initial_cwd: Mutex<Option<String>>,
}

#[derive(Clone, serde::Serialize)]
struct PtyOutput {
    id: u32,
    data: String,
}

fn find_utf8_safe_boundary(buf: &[u8]) -> usize {
    let len = buf.len();
    if len == 0 {
        return 0;
    }
    for i in 0..4.min(len) {
        let pos = len - 1 - i;
        let b = buf[pos];
        if b < 0x80 {
            return len;
        }
        if b >= 0xC0 {
            let char_len = if b < 0xE0 { 2 } else if b < 0xF0 { 3 } else { 4 };
            if pos + char_len <= len {
                return len;
            } else {
                return pos;
            }
        }
    }
    len
}

#[tauri::command]
fn pty_spawn(state: tauri::State<AppState>, app: tauri::AppHandle, cwd: Option<String>) -> Result<u32, String> {
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("failed to open pty: {e}"))?;

    let mut cmd = CommandBuilder::new("powershell.exe");
    cmd.arg("-NoLogo");

    // Set working directory: explicit cwd > initial_cwd from --cwd flag > default
    let dir = cwd.or_else(|| {
        let initial = state.initial_cwd.lock().unwrap();
        initial.clone()
    });
    if let Some(ref d) = dir {
        let path = std::path::Path::new(d);
        if path.is_dir() {
            cmd.cwd(path);
        }
    }

    let _child = pair.slave.spawn_command(cmd).map_err(|e| format!("failed to spawn shell: {e}"))?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| format!("failed to get writer: {e}"))?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("failed to get reader: {e}"))?;

    {
        let mut ptys = state.ptys.lock().unwrap();
        ptys.insert(id, PtyInstance {
            writer,
            master: pair.master,
        });
    }

    let handle = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 65536];
        let mut leftover = Vec::new();

        loop {
            let read_start = leftover.len();
            buf[..read_start].copy_from_slice(&leftover);
            leftover.clear();

            match reader.read(&mut buf[read_start..]) {
                Ok(0) => break,
                Ok(n) => {
                    let total = read_start + n;
                    let safe = find_utf8_safe_boundary(&buf[..total]);

                    if safe > 0 {
                        let text = String::from_utf8_lossy(&buf[..safe]).to_string();
                        let _ = handle.emit("pty-output", PtyOutput { id, data: text });
                    }

                    if safe < total {
                        leftover.extend_from_slice(&buf[safe..total]);
                    }
                }
                Err(_) => break,
            }
        }

        let _ = handle.emit("pty-exit", id);
    });

    Ok(id)
}

#[tauri::command]
fn get_initial_cwd(state: tauri::State<AppState>) -> Option<String> {
    state.initial_cwd.lock().unwrap().clone()
}

#[tauri::command]
fn pty_write(state: tauri::State<AppState>, id: u32, data: String) {
    if let Ok(mut ptys) = state.ptys.lock() {
        if let Some(pty) = ptys.get_mut(&id) {
            let _ = pty.writer.write_all(data.as_bytes());
        }
    }
}

#[tauri::command]
fn pty_resize(state: tauri::State<AppState>, id: u32, cols: u16, rows: u16) {
    if let Ok(ptys) = state.ptys.lock() {
        if let Some(pty) = ptys.get(&id) {
            let _ = pty.master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    }
}

#[tauri::command]
fn pty_kill(state: tauri::State<AppState>, id: u32) {
    if let Ok(mut ptys) = state.ptys.lock() {
        ptys.remove(&id);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Parse --cwd from command line args
    let args: Vec<String> = std::env::args().collect();
    let initial_cwd = args.windows(2)
        .find(|w| w[0] == "--cwd")
        .map(|w| w[1].clone());

    let state = AppState {
        ptys: Mutex::new(HashMap::new()),
        next_id: AtomicU32::new(1),
        initial_cwd: Mutex::new(initial_cwd),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .manage(state)
        .manage(project::ProjectWatcher::new())
        .invoke_handler(tauri::generate_handler![pty_spawn, pty_write, pty_resize, pty_kill, get_initial_cwd, project::project_scan, project::project_watch, project::project_unwatch])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
