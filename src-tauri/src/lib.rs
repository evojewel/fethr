// fethr Tauri shell — the native window (v0.3).
//
// The file API is implemented as Tauri commands, mirroring src/server.js
// exactly: access is confined to the chosen root, same skip list, same
// size cap. The agent panel requires the CLI mode (Node); the app shell
// is a fully self-contained editor.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TREE_ENTRIES: usize = 5000;
const SKIP_DIRS: [&str; 7] = ["node_modules", ".git", "dist", "build", "__pycache__", "env", "venv"];

struct Root(Mutex<PathBuf>);

fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    let p = root.join(rel);
    let canon_root = root.canonicalize().ok()?;
    // Canonicalize the deepest existing ancestor so new files still validate.
    let check = if p.exists() { p.canonicalize().ok()? } else { p.parent()?.canonicalize().ok()?.join(p.file_name()?) };
    if check == canon_root || check.starts_with(&canon_root) {
        Some(check)
    } else {
        None
    }
}

#[derive(serde::Serialize)]
struct Entry {
    path: String,
    dir: bool,
}

fn walk(dir: &Path, rel: &str, out: &mut Vec<Entry>) {
    if out.len() >= MAX_TREE_ENTRIES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut items: Vec<_> = entries.flatten().collect();
    items.sort_by_key(|e| (!e.path().is_dir(), e.file_name()));
    for e in items {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        let p = e.path();
        if p.is_dir() {
            out.push(Entry { path: r.clone(), dir: true });
            walk(&p, &r, out);
        } else if p.is_file() {
            out.push(Entry { path: r, dir: false });
        }
    }
}

#[tauri::command]
fn meta(root: tauri::State<Root>) -> serde_json::Value {
    let r = root.0.lock().unwrap();
    serde_json::json!({
        "root": r.to_string_lossy(),
        "name": r.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        "app": true,
    })
}

#[tauri::command]
fn tree(root: tauri::State<Root>) -> Vec<Entry> {
    let r = root.0.lock().unwrap();
    let mut out = Vec::new();
    walk(&r, "", &mut out);
    out
}

#[tauri::command]
fn read_file(root: tauri::State<Root>, p: String) -> Result<String, String> {
    let r = root.0.lock().unwrap();
    let abs = safe_join(&r, &p).ok_or("path escapes root")?;
    let md = fs::metadata(&abs).map_err(|e| e.to_string())?;
    if md.len() > MAX_FILE_BYTES {
        return Err("file too large".into());
    }
    fs::read_to_string(&abs).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_file(root: tauri::State<Root>, p: String, content: String) -> Result<(), String> {
    let r = root.0.lock().unwrap();
    let abs = safe_join(&r, &p).ok_or("path escapes root")?;
    fs::write(&abs, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn choose_root(root: tauri::State<Root>, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err("not a directory".into());
    }
    *root.0.lock().unwrap() = p;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let start = std::env::args().nth(1).map(PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| dirs_home());
    tauri::Builder::default()
        .manage(Root(Mutex::new(start)))
        .invoke_handler(tauri::generate_handler![meta, tree, read_file, save_file, choose_root])
        .run(tauri::generate_context!())
        .expect("error while running fethr");
}

fn dirs_home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}
