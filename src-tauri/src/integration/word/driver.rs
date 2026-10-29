use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Field {
    pub index: usize,
    pub code: String,
    pub text: String,
    pub start: i64,
    pub end: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub name: String,
    pub path: String,
    pub content: String,
    pub fields: Vec<Field>,
    pub start: i64,
    pub end: i64,
    pub story: String,
}

#[cfg(target_os = "macos")]
pub async fn execute(input: serde_json::Value) -> Result<serde_json::Value, String> {
    use std::io::Write;
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    let mut file = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(&input).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut child = tokio::process::Command::new("/usr/bin/osascript")
        .args([
            "-l",
            "JavaScript",
            "-",
            file.path().to_str().ok_or("word.invalidPath")?,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or("word.driverFailed")?
        .write_all(include_bytes!("mac-word.js"))
        .await
        .map_err(|e| e.to_string())?;
    let output = tokio::time::timeout(std::time::Duration::from_secs(45), child.wait_with_output())
        .await
        .map_err(|_| "word.timeout".to_string())?
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())
}

#[cfg(windows)]
pub async fn execute(input: serde_json::Value) -> Result<serde_json::Value, String> {
    use std::io::Write;
    let mut json_file = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    json_file
        .write_all(&serde_json::to_vec(&input).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let script_path = std::env::temp_dir().join(format!(
        "agentero-word-{}.ps1",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&script_path, include_str!("win-word.ps1")).map_err(|e| e.to_string())?;
    let _script = ScriptFile(script_path.clone());
    let mut command = tokio::process::Command::new(powershell_exe());
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ]);
    command.arg(&script_path).arg(json_file.path());
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(45),
        crate::core::process::command_output(&mut command),
    )
    .await
    .map_err(|_| "word.timeout".to_string())?
    .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "word.driverFailed".into()
        } else {
            err
        });
    }
    let stdout = strip_bom(&output.stdout);
    serde_json::from_slice(stdout.trim_ascii()).map_err(|e| e.to_string())
}

#[cfg(windows)]
struct ScriptFile(std::path::PathBuf);

#[cfg(windows)]
impl Drop for ScriptFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(windows)]
fn powershell_exe() -> std::path::PathBuf {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    std::path::PathBuf::from(root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe")
}

#[cfg(windows)]
fn strip_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub async fn execute(_: serde_json::Value) -> Result<serde_json::Value, String> {
    Err("word.platformUnsupported".into())
}

pub async fn read() -> Result<Snapshot, String> {
    serde_json::from_value(execute(serde_json::json!({"action":"read"})).await?)
        .map_err(|e| e.to_string())
}
