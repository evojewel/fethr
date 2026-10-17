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
//
// Windows (docs/plans/home-screen.md, "Native shell"): every window has its
// own sidecar, so each keeps its own root, token and URL. `home` is the
// launcher (one at most); editor windows are `w1`, `w2`, …. A sidecar asks
// for another window by printing a `FETHR_OPEN=<json>` line on stdout.

use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

const HOME_LABEL: &str = "home";
const OPEN_PREFIX: &str = "FETHR_OPEN=";
const EDITOR_SIZE: (f64, f64) = (1100.0, 720.0);
const HOME_SIZE: (f64, f64) = (900.0, 620.0);
const MIN_SIZE: (f64, f64) = (640.0, 400.0);

/// What the shell knows about its windows, keyed by window label.
#[derive(Default)]
struct Windows {
    /// The sidecar behind each window, killed on that window's Destroyed event.
    children: HashMap<String, Child>,
    /// Folder (canonical form) of each editor window opened WITHOUT a session,
    /// so opening that folder again focuses the window instead of a twin.
    folder_roots: HashMap<String, PathBuf>,
    /// Session id of each window opened to RESUME a session (forks excluded:
    /// every fork is a new session), so resuming it again focuses the window
    /// instead of appending to one transcript from two places.
    resumed: HashMap<String, String>,
    /// Labels whose sidecar is starting or whose window isn't built yet. Stops
    /// a double-click from starting two sidecars for one window, and keeps the
    /// app alive while the last window closes before a new one appears.
    pending: HashSet<String>,
}

#[derive(Default)]
struct Shell {
    windows: Mutex<Windows>,
    next_window: AtomicU32,
    next_message: AtomicU32,
    /// Folder pickers currently open. Like `pending`, keeps the app alive.
    picking: AtomicU32,
}

fn shell(app: &AppHandle) -> &Shell {
    app.state::<Shell>().inner()
}

impl Shell {
    fn lock(&self) -> MutexGuard<'_, Windows> {
        // A panic on some other thread must not take window bookkeeping with it.
        self.windows.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// True while a window is on its way: a sidecar starting, a window not yet
    /// built, or a folder picker open.
    fn busy(&self) -> bool {
        !self.lock().pending.is_empty() || self.picking.load(Ordering::SeqCst) > 0
    }
}

struct ResumeSession {
    id: String,
    fork: bool,
}

/// A window the shell has been asked to open.
enum Target {
    Home,
    Pick,
    Folder {
        root: PathBuf,
        session: Option<ResumeSession>,
    },
}

/// The JSON after `FETHR_OPEN=`. One of `{root, session?, fork?}`,
/// `{pick:true}`, `{home:true}`; unknown fields are ignored.
#[derive(Deserialize)]
struct OpenRequest {
    root: Option<String>,
    session: Option<String>,
    fork: Option<bool>,
    pick: Option<bool>,
    home: Option<bool>,
}

// Same shape the server enforces (`^[0-9a-f-]{36}$`). The id becomes a
// sidecar argument, so anything else (say, a value starting with `--`) is
// refused here as well.
fn is_session_id(s: &str) -> bool {
    s.len() == 36 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
}

/// Parses one stdout line. Anything that isn't a well-formed `FETHR_OPEN`
/// request gives None and is ignored.
fn parse_open_line(line: &str) -> Option<Target> {
    let json = line.trim().strip_prefix(OPEN_PREFIX)?;
    let req: OpenRequest = serde_json::from_str(json).ok()?;
    if let Some(root) = req.root {
        let root = PathBuf::from(root);
        if !root.is_absolute() {
            return None;
        }
        let session = match req.session {
            Some(id) if is_session_id(&id) => Some(ResumeSession {
                id,
                fork: req.fork.unwrap_or(false),
            }),
            Some(_) => return None,
            None => None,
        };
        return Some(Target::Folder { root, session });
    }
    if req.pick == Some(true) {
        return Some(Target::Pick);
    }
    if req.home == Some(true) {
        return Some(Target::Home);
    }
    None
}

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

/// Why a window didn't open.
enum OpenError {
    /// The sidecar's own `FETHR_ERROR` text (bad args, session gone, …). Node
    /// did run, so the startup "install Node" hint would be wrong for it.
    Server(String),
    /// Everything else: spawn failure, early exit, a read error, a bad URL.
    Other(String),
}

impl OpenError {
    fn message(&self) -> &str {
        match self {
            OpenError::Server(m) | OpenError::Other(m) => m,
        }
    }
}

impl From<std::io::Error> for OpenError {
    fn from(e: std::io::Error) -> Self {
        OpenError::Other(e.to_string())
    }
}

/// One line of the sidecar's startup handshake.
#[derive(Debug, PartialEq)]
enum Handshake<'a> {
    /// `FETHR_URL=<url>`: up and listening.
    Url(&'a str),
    /// `FETHR_ERROR=<message>`: it refused to start and is about to exit.
    Error(&'a str),
}

fn parse_handshake(line: &str) -> Option<Handshake<'_>> {
    let line = line.trim();
    if let Some(url) = line.strip_prefix("FETHR_URL=") {
        return Some(Handshake::Url(url));
    }
    line.strip_prefix("FETHR_ERROR=").map(|m| Handshake::Error(m.trim()))
}

// The message is shown to the user as-is (escaped). Bound it so a runaway
// line can't produce a wall of text.
const MAX_SERVER_ERROR_CHARS: usize = 500;

fn server_error_text(msg: &str) -> String {
    if msg.is_empty() {
        return "the editor server stopped without saying why".to_string();
    }
    msg.chars().take(MAX_SERVER_ERROR_CHARS).collect()
}

/// Kill (a no-op if it already exited) and reap, so a failed start leaves no
/// process and no zombie behind. Blocks briefly; not for the main thread.
fn stop(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

// `args` is everything after the entry script:
// `<root> --sidecar [--session <id> [--fork]]` or `--home --sidecar`.
// Blocks until the sidecar prints its URL, so never call it on the main thread.
fn spawn_sidecar(app: &AppHandle, args: &[OsString]) -> Result<(Child, String), OpenError> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| OpenError::Other(e.to_string()))?;
    let sidecar_dir = plain_path(&resource_dir.join("sidecar"));
    let entry = sidecar_dir.join("bin").join("fethr.js");
    let node = find_node();

    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        .args(args)
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
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = match reader.read_until(b'\n', &mut buf) {
            Ok(n) => n,
            Err(e) => {
                stop(child);
                return Err(e.into());
            }
        };
        if n == 0 {
            stop(child);
            return Err(OpenError::Other("sidecar exited before printing its URL".to_string()));
        }
        let line = String::from_utf8_lossy(&buf);
        match parse_handshake(&line) {
            Some(Handshake::Error(msg)) => {
                let msg = server_error_text(msg);
                stop(child);
                return Err(OpenError::Server(msg));
            }
            Some(Handshake::Url(url)) => {
                let url = url.to_string();
                // Keep draining stdout on a background thread so the pipe never
                // fills up and blocks the sidecar's own writes. This is also where
                // the page's requests for other windows arrive (FETHR_OPEN lines).
                // Bytes, not read_line: one non-UTF-8 line must not end the drain.
                let app = app.clone();
                std::thread::spawn(move || {
                    let mut buf = Vec::new();
                    while reader.read_until(b'\n', &mut buf).unwrap_or(0) > 0 {
                        if let Some(target) = parse_open_line(&String::from_utf8_lossy(&buf)) {
                            // Opening blocks on the new sidecar's startup; do it
                            // off this thread so draining never stalls.
                            let app = app.clone();
                            std::thread::spawn(move || open_target(&app, target));
                        }
                        buf.clear();
                    }
                });
                return Ok((child, url));
            }
            None => {}
        }
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

// Messages can now carry folder paths, and a `#` or `%` in one would cut the
// data: URL short. Percent-encoding every byte outside the unreserved set
// makes the URL valid whatever the text holds.
fn data_url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

// Each message gets its own label (`message-1`, `message-2`, …): a second
// error while the first is still open must not fail on a duplicate label.
fn show_message(app: &AppHandle, title: &str, msg: &str) -> tauri::Result<()> {
    let html = format!(
        "<body style='font-family:-apple-system,sans-serif;\
         background:#101312;color:#e8ece9;padding:32px;white-space:pre-wrap'>{}</body>",
        html_escape(msg)
    );
    let url = format!("data:text/html;charset=utf-8,{}", data_url_encode(&html));
    let n = shell(app).next_message.fetch_add(1, Ordering::Relaxed) + 1;
    WebviewWindowBuilder::new(
        app,
        format!("message-{n}"),
        WebviewUrl::External(url.parse().expect("percent-encoded data url")),
    )
    .title(title)
    .inner_size(560.0, 320.0)
    .build()?;
    Ok(())
}

/// The exit that ExitRequested held back, once nothing is on its way. Main
/// thread only. Without it, a launch that fails after the last window closed
/// (and whose message can't be shown) would leave the app running windowless.
fn exit_if_idle(app: &AppHandle) {
    if !shell(app).busy() && app.webview_windows().is_empty() {
        app.exit(0);
    }
}

/// show_message from any thread.
fn report(app: &AppHandle, title: &str, msg: String) {
    let handle = app.clone();
    let title = title.to_string();
    let _ = app.run_on_main_thread(move || {
        if show_message(&handle, &title, &msg).is_err() {
            exit_if_idle(&handle);
        }
    });
}

fn focus(app: &AppHandle, label: &str) {
    let handle = app.clone();
    let label = label.to_string();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window(&label) {
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    });
}

/// Forgets a window and kills its sidecar, if it has one. Message windows
/// have no entries, so releasing one touches nothing.
fn release(app: &AppHandle, label: &str) {
    let child = {
        let mut w = shell(app).lock();
        w.pending.remove(label);
        w.folder_roots.remove(label);
        w.resumed.remove(label);
        w.children.remove(label)
    };
    if let Some(child) = child {
        // Reap off the calling (often main) thread; stop() waits.
        std::thread::spawn(move || stop(child));
    }
}

fn next_editor_label(shell: &Shell) -> String {
    format!("w{}", shell.next_window.fetch_add(1, Ordering::Relaxed) + 1)
}

fn find_label<V: PartialEq>(map: &HashMap<String, V>, value: &V) -> Option<String> {
    map.iter().find(|(_, v)| *v == value).map(|(label, _)| label.clone())
}

/// Starts the sidecar for an already-reserved `label`, then builds its window
/// on the main thread. The label stays in `pending` until the window exists.
/// On failure the reservation is released and the error returned for the
/// caller to word. Never call this on the main thread.
fn launch(
    app: &AppHandle,
    label: &str,
    args: &[OsString],
    title: &str,
    size: (f64, f64),
) -> Result<(), OpenError> {
    let (child, url) = match spawn_sidecar(app, args) {
        Ok(v) => v,
        Err(e) => {
            release(app, label);
            return Err(e);
        }
    };
    let url: tauri::Url = match url.parse() {
        Ok(u) => u,
        Err(e) => {
            stop(child);
            release(app, label);
            return Err(OpenError::Other(format!("the editor server printed an invalid URL ({e})")));
        }
    };
    shell(app).lock().children.insert(label.to_string(), child);

    let handle = app.clone();
    let (label_owned, title) = (label.to_string(), title.to_string());
    let scheduled = app.run_on_main_thread(move || {
        let built = WebviewWindowBuilder::new(&handle, &label_owned, WebviewUrl::External(url))
            .title(&title)
            .inner_size(size.0, size.1)
            .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
            .resizable(true)
            .maximizable(true)
            .minimizable(true)
            .build();
        match built {
            Ok(_) => {
                shell(&handle).lock().pending.remove(&label_owned);
            }
            Err(e) => {
                release(&handle, &label_owned);
                if show_message(&handle, "fethr — couldn't open a window", &e.to_string()).is_err() {
                    exit_if_idle(&handle);
                }
            }
        }
    });
    if let Err(e) = scheduled {
        release(app, label);
        return Err(OpenError::Other(e.to_string()));
    }
    Ok(())
}

/// Opens the home window, or focuses it if it already exists.
fn open_home(app: &AppHandle) -> Result<(), OpenError> {
    {
        let mut w = shell(app).lock();
        if w.children.contains_key(HOME_LABEL) {
            drop(w);
            focus(app, HOME_LABEL);
            return Ok(());
        }
        if !w.pending.insert(HOME_LABEL.to_string()) {
            return Ok(()); // already starting
        }
    }
    let args = [OsString::from("--home"), OsString::from("--sidecar")];
    launch(app, HOME_LABEL, &args, "fethr", HOME_SIZE)
}

/// Opens `root` in a new editor window, optionally resuming or forking a
/// session. A folder already open without a session, or a session already
/// open for resume, is focused instead. Forks always get a new window.
fn open_folder(app: &AppHandle, root: PathBuf, session: Option<ResumeSession>) -> Result<(), OpenError> {
    if !root.is_dir() {
        return Err(OpenError::Other(format!(
            "{} is not a folder (or no longer exists).",
            root.display()
        )));
    }
    // Canonical form so `/a/b` and `/a/b/` (or a symlink) count as one folder.
    // Computed before taking the lock: it touches the filesystem.
    let key = fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
    let shell = shell(app);
    let label = {
        let mut w = shell.lock();
        let existing = match &session {
            None => find_label(&w.folder_roots, &key),
            Some(s) if !s.fork => find_label(&w.resumed, &s.id),
            Some(_) => None,
        };
        if let Some(existing) = existing {
            drop(w);
            focus(app, &existing);
            return Ok(());
        }
        let label = next_editor_label(shell);
        match &session {
            None => {
                w.folder_roots.insert(label.clone(), key);
            }
            Some(s) if !s.fork => {
                w.resumed.insert(label.clone(), s.id.clone());
            }
            Some(_) => {}
        }
        w.pending.insert(label.clone());
        label
    };

    let mut args = vec![plain_path(&root).into_os_string(), OsString::from("--sidecar")];
    if let Some(s) = &session {
        args.push(OsString::from("--session"));
        args.push(OsString::from(&s.id));
        if s.fork {
            args.push(OsString::from("--fork"));
        }
    }
    let title = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.display().to_string());
    launch(app, &label, &args, &title, EDITOR_SIZE)
}

/// Native folder picker, then the same as `{root}`. pick_folder doesn't block:
/// the plugin shows the dialog from the main thread and runs this callback on
/// a thread of its own, where starting a sidecar is fine. `picking` keeps the
/// app alive if its last window closes while the dialog is up.
fn pick_folder(app: &AppHandle) {
    let handle = app.clone();
    shell(app).picking.fetch_add(1, Ordering::SeqCst);
    app.dialog().file().set_title("Open folder").pick_folder(move |picked| {
        let result = match picked.map(|p| p.into_path()) {
            None => Ok(()), // cancelled
            Some(Ok(root)) => open_folder(&handle, root, None),
            Some(Err(_)) => Err(OpenError::Other("Couldn't resolve the folder you picked.".to_string())),
        };
        if let Err(e) = result {
            let msg = format!("fethr couldn't open that folder.\n\n{}", e.message());
            report(&handle, "fethr — couldn't open", msg);
        }
        shell(&handle).picking.fetch_sub(1, Ordering::SeqCst);
        // Cancelled after the last window closed: nothing left to wait for.
        let main = handle.clone();
        let _ = handle.run_on_main_thread(move || exit_if_idle(&main));
    });
}

/// Handles a FETHR_OPEN request. Runs on a background thread.
fn open_target(app: &AppHandle, target: Target) {
    let result = match target {
        Target::Home => open_home(app)
            .map_err(|e| format!("fethr couldn't open its home screen.\n\n{}", e.message())),
        Target::Pick => {
            pick_folder(app);
            Ok(())
        }
        Target::Folder { root, session } => {
            let shown = root.display().to_string();
            open_folder(app, root, session)
                .map_err(|e| format!("fethr couldn't open {shown}.\n\n{}", e.message()))
        }
    };
    if let Err(msg) = result {
        report(app, "fethr — couldn't open", msg);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cli_root = resolve_root_from_args();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Shell::default())
        .setup(move |app| {
            // No CLI arg — the normal case for a Finder double-click — opens
            // the home screen, where the user picks a folder or a session.
            // Still never a silent default to $HOME.
            let handle = app.handle().clone();
            let first = cli_root.clone();
            // The first sidecar's startup blocks too, so it runs off the main
            // thread like every other window; the app has no window until then.
            std::thread::spawn(move || {
                let result = match first {
                    Some(root) => open_folder(&handle, root, None),
                    None => open_home(&handle),
                };
                let msg = match result {
                    Ok(()) => return,
                    Err(OpenError::Server(m)) => format!("fethr couldn't start.\n\n{m}"),
                    Err(OpenError::Other(e)) => format!(
                        "fethr couldn't start its editor server.\n\n{e}\n\n\
                         fethr runs its editor server on Node.js and could not find it. \
                         Install it from nodejs.org, or run `npx @evojewel/fethr` instead."
                    ),
                };
                report(&handle, "fethr — couldn't start", msg);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Kill only the sidecar that belongs to the window being destroyed,
            // matched by label. An earlier version killed on *any* window-destroy
            // event, which is wrong as soon as there is a second window — and
            // now there are many (home, w1, w2, …, plus message windows).
            if matches!(event, tauri::WindowEvent::Destroyed) {
                release(window.app_handle(), window.label());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building fethr");

    app.run(|handle, event| {
        // The app quits when its last window closes (`code: None`; an explicit
        // `exit()` carries Some). Not while another window is on its way,
        // though: closing home right after choosing a folder would otherwise
        // quit before that folder's window appears. exit_if_idle() finishes
        // the job if the pending launch then fails.
        if let tauri::RunEvent::ExitRequested { code: None, api, .. } = &event {
            if shell(handle).busy() {
                api.prevent_exit();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0";

    #[test]
    fn parses_root_with_and_without_session() {
        match parse_open_line(r#"FETHR_OPEN={"root":"/tmp/x"}"#) {
            Some(Target::Folder { root, session: None }) => assert_eq!(root, PathBuf::from("/tmp/x")),
            _ => panic!("plain root"),
        }
        let line = format!(r#"FETHR_OPEN={{"root":"/tmp/x","session":"{ID}","fork":true}}"#);
        match parse_open_line(&line) {
            Some(Target::Folder { session: Some(s), .. }) => assert!(s.id == ID && s.fork),
            _ => panic!("root + session"),
        }
        let line = format!("FETHR_OPEN={{\"root\":\"/tmp/x\",\"session\":\"{ID}\"}}\n");
        match parse_open_line(&line) {
            Some(Target::Folder { session: Some(s), .. }) => assert!(!s.fork),
            _ => panic!("session without fork, trailing newline"),
        }
    }

    #[test]
    fn parses_pick_and_home() {
        assert!(matches!(parse_open_line(r#"FETHR_OPEN={"pick":true}"#), Some(Target::Pick)));
        assert!(matches!(parse_open_line(r#"FETHR_OPEN={"home":true}"#), Some(Target::Home)));
    }

    #[test]
    fn ignores_malformed() {
        for line in [
            "FETHR_URL=http://127.0.0.1:1/",
            "FETHR_OPEN=",
            "FETHR_OPEN={not json",
            r#"FETHR_OPEN={"root":"relative/dir"}"#,
            r#"FETHR_OPEN={"root":"/tmp/x","session":"--inspect"}"#,
            r#"FETHR_OPEN={"root":"/tmp/x","session":"0B1C2D3E-4F50-6172-8394-A5B6C7D8E9F0"}"#,
            r#"FETHR_OPEN={"root":"/tmp/x","fork":"yes"}"#,
            r#"FETHR_OPEN={"pick":false}"#,
            r#"FETHR_OPEN={"home":1}"#,
            r#"FETHR_OPEN={}"#,
            r#"FETHR_OPEN=[]"#,
        ] {
            assert!(parse_open_line(line).is_none(), "{line}");
        }
    }

    #[test]
    fn parses_handshake_lines() {
        assert_eq!(
            parse_handshake("FETHR_URL=http://127.0.0.1:5123/?t=abc\n"),
            Some(Handshake::Url("http://127.0.0.1:5123/?t=abc"))
        );
        assert_eq!(
            parse_handshake("FETHR_ERROR=session folder no longer exists: /tmp/x\r\n"),
            Some(Handshake::Error("session folder no longer exists: /tmp/x"))
        );
        assert_eq!(parse_handshake("FETHR_ERROR=\n"), Some(Handshake::Error("")));
        assert_eq!(parse_handshake("FETHR_OPEN={\"home\":true}"), None);
        assert_eq!(parse_handshake("some log line"), None);
        assert_eq!(parse_handshake(" FETHR_ERRORS=x"), None);
    }

    #[test]
    fn server_error_text_is_bounded_and_never_empty() {
        assert!(!server_error_text("").is_empty());
        assert_eq!(server_error_text("bad args"), "bad args");
        let long = "é".repeat(MAX_SERVER_ERROR_CHARS + 50);
        assert_eq!(server_error_text(&long).chars().count(), MAX_SERVER_ERROR_CHARS);
    }

    #[test]
    fn data_url_survives_hash_and_percent() {
        let url = format!("data:text/html;charset=utf-8,{}", data_url_encode("a #b %c é"));
        let parsed: tauri::Url = url.parse().unwrap();
        assert!(parsed.fragment().is_none());
    }
}
