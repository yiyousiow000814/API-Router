use std::path::PathBuf;
use std::process::Command;

#[cfg(any(target_os = "windows", windows))]
fn windows_git_path_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for base in [
        std::env::var_os("ProgramFiles"),
        std::env::var_os("ProgramFiles(x86)"),
        std::env::var_os("LocalAppData"),
    ]
    .into_iter()
    .flatten()
    {
        let base = PathBuf::from(base);
        for suffix in [
            ["Git", "cmd", "git.exe"].as_slice(),
            ["Git", "bin", "git.exe"].as_slice(),
            ["Programs", "Git", "cmd", "git.exe"].as_slice(),
            ["Programs", "Git", "bin", "git.exe"].as_slice(),
        ] {
            let mut path = base.clone();
            for segment in suffix {
                path.push(segment);
            }
            if !candidates.iter().any(|existing| existing == &path) {
                candidates.push(path);
            }
        }
    }
    candidates
}

#[cfg(not(any(target_os = "windows", windows)))]
fn windows_git_path_candidates() -> Vec<PathBuf> {
    Vec::new()
}

pub fn resolve_git_executable() -> Option<PathBuf> {
    windows_git_path_candidates()
        .into_iter()
        .find(|path| path.is_file())
}

fn git_command_base() -> Command {
    if let Some(path) = resolve_git_executable() {
        Command::new(path)
    } else {
        Command::new("git")
    }
}

#[cfg(any(target_os = "windows", windows))]
pub fn new_git_command() -> Command {
    use std::os::windows::process::CommandExt;

    let mut cmd = git_command_base();
    cmd.creation_flags(0x08000000);
    cmd
}

#[cfg(not(any(target_os = "windows", windows)))]
pub fn new_git_command() -> Command {
    let cmd = git_command_base();
    cmd
}

#[cfg(test)]
mod tests {
    use super::windows_git_path_candidates;

    #[test]
    fn windows_candidates_include_program_files_git_cmd_first() {
        let candidates = windows_git_path_candidates();
        if cfg!(windows) {
            assert!(candidates
                .first()
                .is_some_and(|path| path.ends_with(r"Git\cmd\git.exe")));
        } else {
            assert!(candidates.is_empty());
        }
    }
}
