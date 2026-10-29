use std::fs;
use std::io::Write;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Command as StdCommand, Stdio};
use std::time::{Duration, Instant};
use tokio::process::Command;
use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::{
    OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};

const DIR_ENV: &str = "AGENTERO_JOB_TEST_DIR";
const ROLE_ENV: &str = "AGENTERO_JOB_TEST_ROLE";
const EXIT_ENV: &str = "AGENTERO_JOB_TEST_EXIT_ROOT";

fn fixture_args() -> [&'static str; 4] {
    let name = concat!(module_path!(), "::process_tree_fixture");
    [
        "--exact",
        name.split_once("::").unwrap().1,
        "--ignored",
        "--nocapture",
    ]
}

/// Run only in subprocesses; no shell, network, installed Git or global env
/// mutations. Even a failed cleanup test cannot leave these fixtures forever.
#[test]
#[ignore = "subprocess fixture for process-tree regression tests"]
fn process_tree_fixture() {
    let Some(dir) = std::env::var_os(DIR_ENV) else {
        return;
    };
    let dir = Path::new(&dir);
    let role = std::env::var(ROLE_ENV).unwrap();
    fs::write(
        dir.join(format!("{role}.pid")),
        std::process::id().to_string(),
    )
    .unwrap();
    if role == "grandchild" {
        std::thread::sleep(Duration::from_secs(30));
        return;
    }
    let next_role = if role == "root" {
        "child"
    } else {
        "grandchild"
    };
    let mut child = StdCommand::new(std::env::current_exe().unwrap())
        .args(fixture_args())
        .env(ROLE_ENV, next_role)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(super::super::CREATE_NO_WINDOW)
        .spawn()
        .unwrap();
    if role == "root" && std::env::var_os(EXIT_ENV).is_some() {
        let deadline = Instant::now() + Duration::from_secs(15);
        while !dir.join("release-root").exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        // Exceed a pipe buffer: output readers must drain while the root is
        // running, rather than wait for exit before reading either stream.
        let payload = vec![b'x'; 128 * 1024];
        std::io::stdout().write_all(&payload).unwrap();
        std::io::stderr().write_all(&payload).unwrap();
        println!("root stdout");
        eprintln!("root stderr");
        // Deliberately leave child + grandchild running, like a launcher that
        // exits before its transport helper. Preserve the real exit code too.
        std::process::exit(23);
    }
    child.wait().unwrap();
}

fn command(dir: &Path) -> Command {
    let mut cmd = Command::new(std::env::current_exe().unwrap());
    cmd.args(fixture_args())
        .env(DIR_ENV, dir)
        .env(ROLE_ENV, "root")
        .env_remove(EXIT_ENV)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

// Keep handles rather than checking PIDs after termination (PID reuse). Also
// clean up only our fixtures if an assertion fails with the old broken code.
#[derive(Default)]
struct Processes(Vec<OwnedHandle>);

impl Drop for Processes {
    fn drop(&mut self) {
        for handle in &self.0 {
            // SAFETY: these are handles opened to this test's own fixtures.
            unsafe { TerminateProcess(handle.as_raw_handle(), 1) };
        }
    }
}

async fn fixture_processes(dir: &Path) -> Processes {
    let mut processes = Processes::default();
    for role in ["root", "child", "grandchild"] {
        let pid = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some(pid) = fs::read_to_string(dir.join(format!("{role}.pid")))
                    .ok()
                    .and_then(|s| s.parse::<u32>().ok())
                {
                    break pid;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("fixture did not start");
        // SAFETY: the fixture is held alive until the test triggers cleanup.
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, pid) };
        assert!(
            !handle.is_null(),
            "could not open {role} process: {}",
            std::io::Error::last_os_error()
        );
        // SAFETY: OpenProcess returned a uniquely owned valid handle.
        processes
            .0
            .push(unsafe { OwnedHandle::from_raw_handle(handle) });
        // SAFETY: the owned process handle is valid and wait timeout is zero.
        assert_eq!(unsafe { WaitForSingleObject(handle, 0) }, WAIT_TIMEOUT);
    }
    processes
}

async fn assert_tree_exited(processes: &Processes) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if processes.0.iter().all(|handle| {
                // SAFETY: each process handle remains owned by this test.
                unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) == WAIT_OBJECT_0 }
            }) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("process tree survived command cleanup");
}

#[tokio::test]
async fn drop_blocking_tree_kills_descendants() {
    let dir = tempfile::Builder::new()
        .prefix("agentero job blocking ")
        .tempdir()
        .unwrap();
    let mut cmd = StdCommand::new(std::env::current_exe().unwrap());
    cmd.args(fixture_args())
        .env(DIR_ENV, dir.path())
        .env(ROLE_ENV, "root")
        .env_remove(EXIT_ENV)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let tree = crate::process::BlockingProcessTree::spawn(&mut cmd).unwrap();
    let processes = fixture_processes(dir.path()).await;
    drop(tree);
    assert_tree_exited(&processes).await;
}

#[tokio::test]
async fn timeout_kills_child_and_grandchild() {
    let dir = tempfile::Builder::new()
        .prefix("agentero job timeout ")
        .tempdir()
        .unwrap();
    let mut cmd = command(dir.path());
    let (expire, expired) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let output = crate::process::command_output(&mut cmd);
        tokio::pin!(output);
        tokio::select! {
            result = &mut output => panic!("fixture exited before timeout: {result:?}"),
            _ = expired => tokio::time::timeout(Duration::ZERO, output).await,
        }
    });
    let processes = fixture_processes(dir.path()).await;
    expire.send(()).unwrap();
    assert!(task.await.unwrap().is_err());
    assert_tree_exited(&processes).await;
}

#[tokio::test]
async fn abort_kills_child_and_grandchild() {
    let dir = tempfile::Builder::new()
        .prefix("agentero job abort ")
        .tempdir()
        .unwrap();
    let mut cmd = command(dir.path());
    let task = tokio::spawn(async move { crate::process::command_output(&mut cmd).await });
    let processes = fixture_processes(dir.path()).await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_tree_exited(&processes).await;
}

#[tokio::test]
async fn normal_exit_preserves_output_and_removes_leftover_descendants() {
    let dir = tempfile::Builder::new()
        .prefix("agentero job exit ")
        .tempdir()
        .unwrap();
    let mut cmd = command(dir.path());
    cmd.env(EXIT_ENV, "1");
    let task = tokio::spawn(async move { crate::process::command_output(&mut cmd).await });
    let processes = fixture_processes(dir.path()).await;
    fs::write(dir.path().join("release-root"), "exit").unwrap();
    let output = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(output.status.code(), Some(23));
    assert!(output.stdout.len() > 128 * 1024);
    assert!(output.stderr.len() > 128 * 1024);
    assert!(String::from_utf8_lossy(&output.stdout).contains("root stdout"));
    assert!(String::from_utf8_lossy(&output.stderr).contains("root stderr"));
    assert_tree_exited(&processes).await;
}
