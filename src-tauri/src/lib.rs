// fethr Tauri shell — the native window (v0.3), now with agent parity (v0.4+).
//
// The app no longer reimplements the file/agent API in Rust. Instead it
// spawns the exact same Node server CLI mode uses (bundled into the app as
// a "sidecar" under Resources/sidecar/) and points the native window's
// WebView at it. Same HTML/JS, same fetch()-based transport, same
// src/agent.js safety model (read-only tools, propose_edit-only writes) —
// nothing agent-side had to change to get here, only how the window boots.
//
// Tradeoff, stated plainly: this requires a system Node install (the
// sidecar is Node source + its runtime deps, not a bundled Node binary),
// and the Claude Agent SDK dependency alone is ~335MB, so this build is
// meaningfully heavier than the plain-editor v0.1 shell. Both are real
// costs of shipping the agent inside a native app; the CLI path
// (`npx @evojewel/fethr`) stays the lightweight option.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

struct Sidecar(Mutex<Option<Child>>);

// A CLI arg (`open fethr.app --args <dir>`) is one legitimate way in. But a
// double-click from Finder — the normal way anyone downloading the DMG
// launches it — passes no argument at all, and the previous version of
// this function silently fell back to $HOME. That's a bad default for a
// downloadable GUI app: the agent's Read/Grep/Glob tools would get the
// user's entire home directory as their scope (SSH key parent dirs, other
// projects, everything) with zero indication that happened. None is now
// the honest answer when there's no arg — the caller must ask.
fn resolve_root_from_args() -> Option<PathBuf> {
    std::env::args().nth(1).map(PathBuf::from).filter(|p| p.is_dir())
}

// Where node lives is a per-platform question.
//
// macOS: GUI-launched apps get launchd's bare-bones PATH, not the shell PATH a
// Terminal session has — so a plain `Command::new("node")` fails to find a
// Homebrew- or nvm-installed node even though `node` works fine for the same
// user in Terminal. Re-running through the user's login shell
// (`$SHELL -l -c ...`) was the first fix tried here, but it's unreliable: it
// sources the user's full profile, and anything slow or interactive in there
// (nvm lazy-load, prompt frameworks, update checks) can hang the spawn
// indefinitely with no useful error. Looking in the handful of places node
// actually lives is faster and has no such failure mode.
//
// Windows: the opposite. A GUI app inherits the user's real PATH, so PATH is
// searched first, then the installer's and the version managers' usual homes.
fn version_key(p: &Path) -> (u32, u32, u32) {
    p.file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.trim_start_matches('v').to_string())
        .map(|s| {
            let parts: Vec<u32> = s.split('.').filter_map(|x| x.parse().ok()).collect();
            (
                parts.first().copied().unwrap_or(0),
                parts.get(1).copied().unwrap_or(0),
                parts.get(2).copied().unwrap_or(0),
            )
        })
        .unwrap_or((0, 0, 0))
}

fn search_path(exe: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(exe)).find(|c| c.is_file())
}

#[cfg(windows)]
fn find_node() -> PathBuf {
    if let Some(p) = search_path("node.exe") {
        return p;
    }
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    let candidates = [
        env("ProgramFiles").map(|p| p.join("nodejs").join("node.exe")),
        env("ProgramFiles(x86)").map(|p| p.join("nodejs").join("node.exe")),
        env("LOCALAPPDATA").map(|p| p.join("Programs").join("nodejs").join("node.exe")),
        env("NVM_SYMLINK").map(|p| p.join("node.exe")),
        env("LOCALAPPDATA").map(|p| p.join("Volta").join("bin").join("node.exe")),
        env("USERPROFILE").map(|p| p.join("scoop").join("apps").join("nodejs").join("current").join("node.exe")),
    ];
    for c in candidates.into_iter().flatten() {
        if c.is_file() {
            return c;
        }
    }
    PathBuf::from("node.exe") // last resort
}

#[cfg(not(windows))]
fn find_node() -> PathBuf {
    for c in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
        if Path::new(c).is_file() {
            return PathBuf::from(c);
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let nvm_dir = PathBuf::from(home).join(".nvm/versions/node");
        if let Ok(entries) = fs::read_dir(&nvm_dir) {
            let mut versions: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
            versions.sort_by_key(|p| version_key(p));
            if let Some(latest) = versions.last() {
                let node_bin = latest.join("bin/node");
                if node_bin.is_file() {
                    return node_bin;
                }
            }
        }
    }
    search_path("node").unwrap_or_else(|| PathBuf::from("node"))
}

// Windows hands back resource paths in the verbatim form (\\?\C:\...). Node
// runs a script given that way, but resolving its ES module imports from a
// verbatim path is where it has broken before, so pass the plain form.
fn plain_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => p.to_path_buf(),
    }
}

fn spawn_sidecar(resource_dir: &Path, root: &Path) -> std::io::Result<(Child, String)> {
    let sidecar_dir = plain_path(&resource_dir.join("sidecar"));
    let entry = sidecar_dir.join("bin").join("fethr.js");
    let node = find_node();

    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        .arg(plain_path(root))
        .arg("--sidecar")
        .current_dir(&sidecar_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // Without this a console window flashes up behind the editor on Windows.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn()?;

    let stdout = child.stdout.take().expect("piped stdout");
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "sidecar exited before printing its URL",
            ));
        }
        if let Some(url) = line.trim().strip_prefix("FETHR_URL=") {
            let url = url.to_string();
            // Keep draining stdout on a background thread so the pipe never
            // fills up and blocks the sidecar's own writes.
            std::thread::spawn(move || {
                let mut buf = String::new();
                while reader.read_line(&mut buf).unwrap_or(0) > 0 {
                    buf.clear();
                }
            });
            return Ok((child, url));
        }
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn show_message(app: &tauri::AppHandle, title: &str, msg: &str) -> tauri::Result<()> {
    let html = format!(
        "data:text/html,<body style='font-family:-apple-system,sans-serif;\
         background:#101312;color:#e8ece9;padding:32px;white-space:pre-wrap'>{}</body>",
        html_escape(msg)
    );
    WebviewWindowBuilder::new(app, "message", WebviewUrl::External(html.parse().expect("valid data url")))
        .title(title)
        .inner_size(560.0, 320.0)
        .build()?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cli_root = resolve_root_from_args();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Sidecar(Mutex::new(None)))
        .setup(move |app| {
            let resource_dir = app.path().resource_dir().expect("resource dir");

            let root = match cli_root.clone() {
                Some(r) => r,
                None => {
                    // No CLI arg — the normal case for a Finder double-click.
                    // Ask, rather than silently defaulting to $HOME.
                    match app.dialog().file().blocking_pick_folder() {
                        Some(picked) => match picked.into_path() {
                            Ok(p) => p,
                            Err(_) => {
                                show_message(
                                    app.handle(),
                                    "fethr",
                                    "Couldn't resolve the folder you picked.",
                                )?;
                                return Ok(());
                            }
                        },
                        None => {
                            // User closed the picker without choosing — exit
                            // quietly rather than open anything by default.
                            show_message(
                                app.handle(),
                                "fethr",
                                "fethr needs a folder to open.\n\nRelaunch and choose one, or start it with a folder path as its argument.",
                            )?;
                            return Ok(());
                        }
                    }
                }
            };

            match spawn_sidecar(&resource_dir, &root) {
                Ok((child, url)) => {
                    *app.state::<Sidecar>().0.lock().unwrap() = Some(child);
                    WebviewWindowBuilder::new(
                        app,
                        "main",
                        WebviewUrl::External(url.parse().expect("sidecar printed a valid URL")),
                    )
                    .title("fethr")
                    .inner_size(1100.0, 720.0)
                    .min_inner_size(640.0, 400.0)
                    .resizable(true)
                    .maximizable(true)
                    .minimizable(true)
                    .build()?;
                }
                Err(e) => {
                    let msg = format!(
                        "fethr couldn't start its editor server.\n\n{e}\n\n\
                         fethr runs its editor server on Node.js and could not find it. \
                         Install it from nodejs.org, or run `npx @evojewel/fethr` instead."
                    );
                    show_message(app.handle(), "fethr — couldn't start", &msg)?;
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(mut child) = window.app_handle().state::<Sidecar>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running fethr");
}
