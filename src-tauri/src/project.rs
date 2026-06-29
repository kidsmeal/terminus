use notify_debouncer_mini::{new_debouncer, DebouncedEventKind};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Emitter;

pub struct ProjectWatcher {
    pub active_path: Mutex<Option<PathBuf>>,
    _watcher: Mutex<Option<notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>>>,
}

impl ProjectWatcher {
    pub fn new() -> Self {
        Self {
            active_path: Mutex::new(None),
            _watcher: Mutex::new(None),
        }
    }
}

#[derive(Clone, serde::Serialize)]
pub struct ProjectFiles {
    pub path: String,
    pub now_md: Option<String>,
    pub ideas_md: Option<String>,
    pub shipped_md: Option<String>,
    pub gantry_plan: Option<String>,
    pub gantry_design: Option<String>,
    pub gantry_conventions: Option<String>,
    pub has_claude_dir: bool,
    pub has_gantry: bool,
}

fn read_if_exists(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

fn find_gantry_file(dir: &Path, prefix: &str) -> Option<String> {
    let gantry_dir = dir.join(".gantry");
    let search_dirs = [gantry_dir.as_path(), dir];

    for search_dir in &search_dirs {
        if let Ok(entries) = std::fs::read_dir(search_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if name.starts_with(prefix) && name.ends_with(".md") {
                    if let Ok(content) = std::fs::read_to_string(entry.path()) {
                        return Some(content);
                    }
                }
            }
        }
    }
    None
}

#[tauri::command]
pub fn project_scan(path: String) -> ProjectFiles {
    let dir = Path::new(&path);

    let has_claude_dir = dir.join(".claude").is_dir();
    let has_gantry = dir.join(".gantry").is_dir()
        || find_gantry_file(dir, "plan").is_some();

    ProjectFiles {
        path: path.clone(),
        now_md: read_if_exists(&dir.join("NOW.md")),
        ideas_md: read_if_exists(&dir.join("IDEAS.md")),
        shipped_md: read_if_exists(&dir.join("SHIPPED.md")),
        gantry_plan: find_gantry_file(dir, "plan"),
        gantry_design: find_gantry_file(dir, "design"),
        gantry_conventions: find_gantry_file(dir, "conventions"),
        has_claude_dir,
        has_gantry,
    }
}

#[tauri::command]
pub fn project_watch(
    path: String,
    watcher_state: tauri::State<ProjectWatcher>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let dir = PathBuf::from(&path);

    // Build list of paths to watch
    let mut watch_paths: Vec<PathBuf> = vec![];

    let gantry_dir = dir.join(".gantry");
    if gantry_dir.is_dir() {
        watch_paths.push(gantry_dir);
    }

    // Watch plan/design files in root too
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if (name.starts_with("plan") || name.starts_with("design"))
                && name.ends_with(".md")
            {
                watch_paths.push(entry.path());
            }
        }
    }

    // Also watch NOW.md for hybrid coverage
    let now_path = dir.join("NOW.md");
    if now_path.exists() {
        watch_paths.push(now_path);
    }

    if watch_paths.is_empty() {
        return Ok(());
    }

    let scan_path = path.clone();
    let handle = app.clone();

    let debouncer = new_debouncer(Duration::from_millis(500), move |events: Result<Vec<notify_debouncer_mini::DebouncedEvent>, notify::Error>| {
        if let Ok(events) = events {
            let changed = events.iter().any(|e| e.kind == DebouncedEventKind::Any);
            if changed {
                let files = project_scan(scan_path.clone());
                let _ = handle.emit("project-updated", files);
            }
        }
    })
    .map_err(|e| format!("failed to create watcher: {e}"))?;

    // Store the new watcher
    {
        let mut active = watcher_state.active_path.lock().unwrap();
        *active = Some(dir);
    }
    {
        let mut w = watcher_state._watcher.lock().unwrap();
        *w = Some(debouncer);
    }

    // Add watch paths
    {
        let mut w = watcher_state._watcher.lock().unwrap();
        if let Some(ref mut debouncer) = *w {
            for wp in &watch_paths {
                let _ = debouncer.watcher().watch(
                    wp,
                    notify::RecursiveMode::NonRecursive,
                );
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub fn project_unwatch(watcher_state: tauri::State<ProjectWatcher>) {
    let mut w = watcher_state._watcher.lock().unwrap();
    *w = None;
    let mut active = watcher_state.active_path.lock().unwrap();
    *active = None;
}
