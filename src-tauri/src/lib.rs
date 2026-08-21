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

struct Sidecar(Mutex<Option<Child>>);

fn resolve_root() -> PathBuf {
    std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/")))
}

// GUI-launched apps on macOS get launchd's bare-bones PATH, not the shell
// PATH a Terminal session has — so a plain `Command::new("node")` fails to
// find a Homebrew- or nvm-installed node even though `node` works fine for
// the same user in Terminal. Re-running through the user's login shell
// (`$SHELL -l -c ...`) was the first fix tried here, but it's unreliable:
// it sources the user's full profile, and anything slow or interactive in
// there (nvm lazy-load, prompt frameworks, update checks) can hang the
// spawn indefinitely with no useful error. Looking in the handful of places
// node actually lives is faster and has no such failure mode.
fn find_node() -> PathBuf {
    for c in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
        if Path::new(c).is_file() {
            return PathBuf::from(c);
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let nvm_dir = PathBuf::from(home).join(".nvm/versions/node");
        if let Ok(entries) = fs::read_dir(&nvm_dir) {
            let mut versions: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
            versions.sort_by_key(|p| {
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
            });
            if let Some(latest) = versions.last() {
                let node_bin = latest.join("bin/node");
                if node_bin.is_file() {
                    return node_bin;
                }
            }
        }
    }
    PathBuf::from("node") // last resort: relies on PATH already having it
}

fn spawn_sidecar(resource_dir: &Path, root: &Path) -> std::io::Result<(Child, String)> {
    let sidecar_dir = resource_dir.join("sidecar");
    let entry = sidecar_dir.join("bin").join("fethr.js");
    let node = find_node();

    let mut child = Command::new(&node)
        .arg(&entry)
        .arg(root)
        .arg("--sidecar")
        .current_dir(&sidecar_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let root = resolve_root();

    tauri::Builder::default()
        .manage(Sidecar(Mutex::new(None)))
        .setup(move |app| {
            let resource_dir = app.path().resource_dir().expect("resource dir");

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
                         The agent-enabled app shell needs Node.js on PATH (node). \
                         Install it from nodejs.org, or run `npx @evojewel/fethr` instead."
                    );
                    let html = format!(
                        "data:text/html,<body style='font-family:-apple-system,sans-serif;\
                         background:#101312;color:#e8ece9;padding:32px;white-space:pre-wrap'>{}</body>",
                        html_escape(&msg)
                    );
                    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(html.parse().expect("valid data url")))
                        .title("fethr — couldn't start")
                        .inner_size(560.0, 320.0)
                        .build()?;
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
