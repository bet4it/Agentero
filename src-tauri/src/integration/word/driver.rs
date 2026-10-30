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
    let native =
        std::path::PathBuf::from(&root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    if cfg!(not(target_pointer_width = "64")) {
        return native;
    }
    let wow64 =
        std::path::PathBuf::from(&root).join(r"SysWOW64\WindowsPowerShell\v1.0\powershell.exe");
    if use_wow64_powershell(
        running_winword_is_32bit(),
        word_server_registered(false),
        word_server_registered(true),
    ) && wow64.is_file()
    {
        wow64
    } else {
        native
    }
}

/// `running_is_32bit` comes from the live WINWORD.EXE. Registry views are the
/// fallback when Word is not running or its process cannot be opened.
#[cfg(windows)]
fn use_wow64_powershell(running_is_32bit: Option<bool>, office64: bool, office32: bool) -> bool {
    match running_is_32bit {
        Some(value) => value,
        None => office32 && !office64,
    }
}

#[cfg(windows)]
fn word_server_registered(wow64_view: bool) -> bool {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY};
    use winreg::RegKey;
    let flags = KEY_READ
        | if wow64_view {
            KEY_WOW64_32KEY
        } else {
            KEY_WOW64_64KEY
        };
    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(
            r"Software\Classes\CLSID\{000209FF-0000-0000-C000-000000000046}\LocalServer32",
            flags,
        )
        .and_then(|key| key.get_value::<String, _>(""))
        .is_ok()
}

#[cfg(windows)]
fn running_winword_is_32bit() -> Option<bool> {
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap.is_null() || snap == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry = PROCESSENTRY32W {
            dwSize: u32::try_from(size_of::<PROCESSENTRY32W>()).unwrap_or(0),
            ..PROCESSENTRY32W::default()
        };
        let mut saw_32 = false;
        let mut saw_64 = false;
        let mut more = Process32FirstW(snap, &mut entry);
        while more != 0 {
            let end = entry
                .szExeFile
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..end]);
            if name.eq_ignore_ascii_case("WINWORD.EXE") {
                match process_is_wow64(entry.th32ProcessID) {
                    Some(true) => saw_32 = true,
                    Some(false) => saw_64 = true,
                    None => {}
                }
            }
            more = Process32NextW(snap, &mut entry);
        }
        CloseHandle(snap);
        if saw_32 && !saw_64 {
            Some(true)
        } else if saw_64 {
            Some(false)
        } else {
            None
        }
    }
}

#[cfg(windows)]
fn process_is_wow64(pid: u32) -> Option<bool> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        IsWow64Process, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut wow64 = 0;
        let ok = IsWow64Process(handle, &mut wow64);
        CloseHandle(handle);
        if ok == 0 {
            None
        } else {
            Some(wow64 != 0)
        }
    }
}

#[cfg(all(windows, test))]
mod windows_tests {
    use super::use_wow64_powershell;

    #[test]
    fn powershell_follows_the_running_word_process() {
        assert!(use_wow64_powershell(Some(true), true, true));
        assert!(!use_wow64_powershell(Some(false), false, true));
        assert!(use_wow64_powershell(None, false, true));
        assert!(!use_wow64_powershell(None, true, true));
        assert!(!use_wow64_powershell(None, false, false));
    }
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
