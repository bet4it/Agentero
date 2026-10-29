//! One unnamed, non-inheritable Job Object per spawned command. Create the
//! child suspended so a launcher cannot spawn outside the job before
//! assignment. Closing our sole job handle kills the whole tree.

use std::io;
use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::process::Command as StdCommand;
use std::ptr;
use tokio::process::{Child, Command};
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    OpenThread, ResumeThread, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
};

pub(super) fn spawn(command: &mut Command) -> io::Result<(Child, Job)> {
    let job = Job::new()?;
    command
        .creation_flags(super::CREATE_NO_WINDOW | CREATE_SUSPENDED)
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    if let Err(error) = contain(&job, &child) {
        let _ = child.start_kill();
        return Err(error);
    }
    Ok((child, job))
}

pub(super) fn spawn_std(command: &mut StdCommand) -> io::Result<(std::process::Child, Job)> {
    let job = Job::new()?;
    command.creation_flags(super::CREATE_NO_WINDOW | CREATE_SUSPENDED);
    let mut child = command.spawn()?;
    let pid = child.id();
    if let Err(error) = job.contain(child.as_raw_handle(), pid) {
        let _ = child.kill();
        return Err(error);
    }
    Ok((child, job))
}

fn contain(job: &Job, child: &Child) -> io::Result<()> {
    let process = child
        .raw_handle()
        .ok_or_else(|| io::Error::other("child exited before job assignment"))?;
    let pid = child
        .id()
        .ok_or_else(|| io::Error::other("child exited before job assignment"))?;
    job.contain(process, pid)
}

pub(super) struct Job(OwnedHandle);

impl Job {
    fn new() -> io::Result<Self> {
        // SAFETY: null attributes create a non-inheritable handle; null name
        // creates a fresh job, never one owned by another invocation.
        let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful CreateJobObjectW returned a uniquely owned handle.
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the pointer and size describe the correct information class;
        // the structure and owned job handle remain valid throughout the call.
        let ok = unsafe {
            SetInformationJobObject(
                job.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                ptr::from_ref(&limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    fn contain(&self, process: std::os::windows::io::RawHandle, pid: u32) -> io::Result<()> {
        // SAFETY: both handles are live and the child has not been resumed.
        if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), process) } == 0 {
            return Err(io::Error::last_os_error());
        }
        resume_primary_thread(pid)
    }
}

fn resume_primary_thread(pid: u32) -> io::Result<()> {
    // Tokio exposes the process handle, not the primary thread handle. A child
    // created suspended has exactly one thread and cannot create more yet.
    // SAFETY: flags request only thread metadata, not remote memory access.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the snapshot is a newly created, valid kernel handle.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    // SAFETY: entry has the required size and the snapshot remains open.
    let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
    while found != 0 {
        if entry.th32OwnerProcessID == pid {
            // SAFETY: the thread ID belongs to our suspended child; request
            // only the access required to resume it, without handle inheritance.
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if thread.is_null() {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: OpenThread returned a uniquely owned valid handle.
            let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
            // SAFETY: our job already contains the child; resuming its primary
            // thread cannot create uncontained descendants.
            if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            return Ok(());
        }
        // SAFETY: entry and snapshot remain valid for the next record.
        found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
    }
    Err(io::Error::other(
        "suspended child's primary thread not found",
    ))
}

#[cfg(test)]
mod tests;
