//! Shared preflight and rollback for Doctor's planned Markdown edits.
use super::DoctorRepairError;
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) struct PlannedNoteWrite {
    pub path: String,
    pub absolute: PathBuf,
    pub original: String,
    pub rewritten: String,
}

pub(crate) fn commit_note_writes(
    planned: &[PlannedNoteWrite],
    source_label: &str,
) -> Result<(), DoctorRepairError> {
    // Keep in-place writes: tmp+rename can be reported by FSEvents as an
    // incomplete external rename even though no wiki target has moved.
    commit_with_writer(planned, source_label, |path, contents| {
        fs::write(path, contents).map_err(|error| error.to_string())
    })
}

fn commit_with_writer(
    planned: &[PlannedNoteWrite],
    source_label: &str,
    mut write_note_bytes: impl FnMut(&Path, &[u8]) -> Result<(), String>,
) -> Result<(), DoctorRepairError> {
    for write in planned {
        let current = fs::read_to_string(&write.absolute).map_err(|error| {
            DoctorRepairError::new(
                "readFailed",
                format!("could not re-read {}: {error}", write.path),
                vec![write.path.clone()],
            )
        })?;
        if current != write.original {
            return Err(DoctorRepairError::new(
                "sourceChanged",
                format!("{source_label} changed after preflight: {}", write.path),
                vec![write.path.clone()],
            ));
        }
    }

    let mut written: Vec<&PlannedNoteWrite> = Vec::new();
    for write in planned {
        if let Err(error) = write_note_bytes(&write.absolute, write.rewritten.as_bytes()) {
            let mut rollback_complete = true;
            for previous in written.iter().rev() {
                if write_note_bytes(&previous.absolute, previous.original.as_bytes()).is_err() {
                    rollback_complete = false;
                }
            }
            let mut failure = DoctorRepairError::new(
                "writeFailed",
                format!("could not write {}: {error}", write.path),
                planned.iter().map(|item| item.path.clone()).collect(),
            );
            failure.rollback = if rollback_complete {
                "completed"
            } else {
                "manualRecoveryRequired"
            }
            .into();
            return Err(failure);
        }
        written.push(write);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, Vec<PlannedNoteWrite>) {
        let root = std::env::temp_dir().join(format!("doctor-writes-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let planned = ["a.md", "b.md", "c.md"]
            .into_iter()
            .map(|path| {
                let absolute = root.join(path);
                fs::write(&absolute, "original").unwrap();
                PlannedNoteWrite {
                    path: path.into(),
                    absolute,
                    original: "original".into(),
                    rewritten: "changed".into(),
                }
            })
            .collect();
        (root, planned)
    }

    #[test]
    fn preflight_checks_all_sources_before_writing() {
        let (root, planned) = fixture();
        fs::write(&planned[2].absolute, "external edit").unwrap();
        let failure = commit_with_writer(&planned, "paper note", |_, _| panic!("must not write"))
            .unwrap_err();
        assert_eq!(failure.code, "sourceChanged");
        assert_eq!(failure.message, "paper note changed after preflight: c.md");
        assert_eq!(failure.rollback, "notNeeded");
        assert_eq!(failure.paths, ["c.md"]);
        assert_eq!(
            fs::read_to_string(&planned[0].absolute).unwrap(),
            "original"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_write_rolls_back_in_reverse_and_reports_recovery_failures() {
        for fail_rollback in [false, true] {
            let (root, planned) = fixture();
            let mut calls = Vec::new();
            let failure = commit_with_writer(&planned, "source", |path, bytes| {
                let name = path.file_name().unwrap().to_str().unwrap();
                calls.push((name.to_string(), String::from_utf8_lossy(bytes).to_string()));
                if name == "c.md" || (fail_rollback && name == "b.md" && bytes == b"original") {
                    return Err("injected failure".into());
                }
                fs::write(path, bytes).map_err(|error| error.to_string())
            })
            .unwrap_err();
            assert_eq!(failure.code, "writeFailed");
            assert_eq!(failure.paths, ["a.md", "b.md", "c.md"]);
            assert_eq!(
                failure.rollback,
                if fail_rollback {
                    "manualRecoveryRequired"
                } else {
                    "completed"
                }
            );
            assert_eq!(
                calls
                    .iter()
                    .map(|(name, _)| name.as_str())
                    .collect::<Vec<_>>(),
                ["a.md", "b.md", "c.md", "b.md", "a.md"]
            );
            assert_eq!(
                fs::read_to_string(&planned[0].absolute).unwrap(),
                "original"
            );
            assert_eq!(
                fs::read_to_string(&planned[1].absolute).unwrap(),
                if fail_rollback { "changed" } else { "original" }
            );
            fs::remove_dir_all(root).unwrap();
        }
    }
}
