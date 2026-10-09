use std::{
  fs,
  io::Read,
  net::{SocketAddr, TcpStream},
  path::{Path, PathBuf},
  process::{Child, Command, Stdio},
  sync::Mutex,
  thread,
  time::{Duration, Instant},
};

use tauri::{Manager, RunEvent};

/// The bundled web UI talks to the connector here (see src/lib/api-base.ts).
const CONNECTOR_PORT: u16 = 5174;
/// The bundle targets Node 22 (vite.connector.config.ts).
const MIN_NODE_MAJOR: u32 = 22;

/// The connector process started by this app, killed when the app exits.
struct Connector(Mutex<Option<Child>>);

fn home() -> PathBuf {
  PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".into()))
}

fn data_dir() -> PathBuf {
  home().join(".tech-lead-cockpit")
}

fn port_open() -> bool {
  let addr = SocketAddr::from(([127, 0, 0, 1], CONNECTOR_PORT));
  TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

/// Apps opened from Finder get a bare PATH, so ask the login shell for the one the terminal uses
/// (Homebrew, nvm, ~/.local/bin). The markers skip whatever the shell profile prints.
fn login_shell_path() -> Option<String> {
  let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
  let mut child = Command::new(shell)
    .args(["-ilc", "printf '__TLC__%s__TLC__' \"$PATH\""])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
    .ok()?;
  let started = Instant::now();
  loop {
    match child.try_wait() {
      Ok(Some(_)) => break,
      Ok(None) if started.elapsed() < Duration::from_secs(5) => thread::sleep(Duration::from_millis(50)),
      _ => {
        let _ = child.kill();
        return None;
      }
    }
  }
  let mut out = String::new();
  child.stdout.take()?.read_to_string(&mut out).ok()?;
  let start = out.find("__TLC__")? + "__TLC__".len();
  let end = start + out[start..].find("__TLC__")?;
  Some(out[start..end].to_string())
}

fn search_path(user_path: &str) -> String {
  let h = home();
  let extra = [
    h.join(".local/bin"),
    PathBuf::from("/opt/homebrew/bin"),
    PathBuf::from("/usr/local/bin"),
    PathBuf::from("/usr/bin"),
    PathBuf::from("/bin"),
  ];
  let mut dirs: Vec<String> = user_path.split(':').filter(|d| !d.is_empty()).map(String::from).collect();
  for d in extra {
    let d = d.to_string_lossy().to_string();
    if !dirs.contains(&d) {
      dirs.push(d);
    }
  }
  dirs.join(":")
}

fn node_major(node: &Path) -> Option<u32> {
  let out = Command::new(node).arg("--version").output().ok()?;
  let v = String::from_utf8_lossy(&out.stdout);
  v.trim().trim_start_matches('v').split('.').next()?.parse().ok()
}

/// First Node on the PATH that is new enough, then the newest nvm install.
fn find_node(path: &str) -> Option<PathBuf> {
  let on_path = path.split(':').map(|d| Path::new(d).join("node"));
  let mut nvm: Vec<PathBuf> = fs::read_dir(home().join(".nvm/versions/node"))
    .map(|it| it.filter_map(|e| e.ok()).map(|e| e.path().join("bin/node")).collect())
    .unwrap_or_default();
  nvm.sort();
  nvm.reverse();
  on_path
    .chain(nvm)
    .find(|p| p.is_file() && node_major(p).is_some_and(|m| m >= MIN_NODE_MAJOR))
}

fn start_connector(script: &Path) -> Result<Option<Child>, String> {
  if port_open() {
    // Another connector (e.g. `npm run connector`) already serves the app.
    log::info!("connector: port {CONNECTOR_PORT} already in use, reusing it");
    return Ok(None);
  }
  if !script.is_file() {
    return Err(format!("bundle connector tidak ditemukan: {}", script.display()));
  }

  let path = search_path(&login_shell_path().unwrap_or_default());
  let node = find_node(&path).ok_or_else(|| format!("Node.js >= {MIN_NODE_MAJOR} tidak ditemukan di PATH: {path}"))?;

  let dir = data_dir();
  fs::create_dir_all(dir.join("logs")).map_err(|e| e.to_string())?;
  let log = fs::File::create(dir.join("logs/connector.log")).map_err(|e| e.to_string())?;
  let log_err = log.try_clone().map_err(|e| e.to_string())?;

  let child = Command::new(&node)
    .arg(script)
    // .env.local for the desktop app lives here; the Koneksi page writes to it too.
    .current_dir(&dir)
    .env("PATH", &path)
    .env("CONNECTOR_PORT", CONNECTOR_PORT.to_string())
    // The connector exits when this pipe closes, even if the app is killed.
    .env("TLC_EXIT_WITH_STDIN", "1")
    .stdin(Stdio::piped())
    .stdout(log)
    .stderr(log_err)
    .spawn()
    .map_err(|e| format!("gagal menjalankan {}: {e}", node.display()))?;

  // Let the first requests from the UI find it ready.
  let started = Instant::now();
  while !port_open() && started.elapsed() < Duration::from_secs(10) {
    thread::sleep(Duration::from_millis(100));
  }
  log::info!("connector: started with {} (pid {})", node.display(), child.id());
  Ok(Some(child))
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
  log::info!("open_external: {url}");
  let trimmed = url.trim();
  if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") && !trimmed.starts_with("mailto:") {
    return Err("protocol not allowed".into());
  }
  #[cfg(target_os = "macos")]
  {
    Command::new("/usr/bin/open")
      .arg(trimmed)
      .spawn()
      .map_err(|e| format!("gagal membuka url di browser: {e}"))?;
  }
  #[cfg(target_os = "windows")]
  {
    Command::new("cmd")
      .args(["/c", "start", "", trimmed])
      .spawn()
      .map_err(|e| format!("gagal membuka url di browser: {e}"))?;
  }
  #[cfg(not(any(target_os = "macos", target_os = "windows")))]
  {
    Command::new("xdg-open")
      .arg(trimmed)
      .spawn()
      .map_err(|e| format!("gagal membuka url di browser: {e}"))?;
  }
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
    .manage(Connector(Mutex::new(None)))
    .invoke_handler(tauri::generate_handler![open_external])
    .setup(|app| {
      // `tauri dev` uses the Vite dev server, which already hosts the connector.
      if !cfg!(debug_assertions) {
        let script = app.path().resource_dir()?.join("connector/server.mjs");
        match start_connector(&script) {
          Ok(child) => *app.state::<Connector>().0.lock().unwrap() = child,
          Err(e) => {
            log::error!("connector: {e}");
            let _ = fs::create_dir_all(data_dir().join("logs"));
            let _ = fs::write(data_dir().join("logs/connector.log"), format!("[desktop] {e}\n"));
          }
        }
      }

      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      if let RunEvent::Exit = event {
        if let Some(mut child) = app.state::<Connector>().0.lock().unwrap().take() {
          // Closing stdin lets the connector exit cleanly (and release the WhatsApp lock).
          drop(child.stdin.take());
          let started = Instant::now();
          while matches!(child.try_wait(), Ok(None)) && started.elapsed() < Duration::from_secs(3) {
            thread::sleep(Duration::from_millis(50));
          }
          let _ = child.kill();
          let _ = child.wait();
        }
      }
    });
}
