//! Platform facts provided by the backend, for module implementations.
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static APP_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Sets the application's private data directory (backends only: on Android
/// `Context.getFilesDir()/rnrs`, set by the framework before any module is created). The first
/// value wins; setting the same path again is accepted, a different one is an error.
pub fn set_app_data_dir(path: PathBuf) -> Result<(), String> {
    let stored = APP_DATA_DIR.get_or_init(|| path.clone());
    if *stored == path {
        Ok(())
    } else {
        Err(format!("application data directory already set to {}", stored.display()))
    }
}

/// The application's private data directory. Modules keep their files under their own
/// subdirectory of it. It is created here if missing, so a directory the platform could not
/// create is reported to the module that needs it (never a silently invalid path).
/// Unavailable on backends without app storage (the browser), where this returns an error
/// naming the platform's limitation.
pub fn app_data_dir() -> Result<&'static Path, String> {
    let dir = APP_DATA_DIR
        .get()
        .ok_or_else(|| "no application data directory: this platform backend does not provide app storage".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("application data directory {} is unavailable: {e}", dir.display()))?;
    Ok(dir.as_path())
}

#[cfg(test)]
mod tests {
    #[test]
    fn first_value_wins_and_conflicts_are_reported() {
        assert!(super::app_data_dir().is_err());
        // A path that cannot be created (below a regular file) is reported on use.
        let file = std::env::temp_dir().join(format!("rnrs-platform-test-{}", std::process::id()));
        std::fs::write(&file, b"").unwrap();
        let dir = file.join("rnrs");
        super::set_app_data_dir(dir.clone()).unwrap();
        super::set_app_data_dir(dir.clone()).unwrap();
        assert!(super::set_app_data_dir("/elsewhere".into()).unwrap_err().contains("already set to"));
        let e = super::app_data_dir().unwrap_err();
        assert!(e.starts_with(&format!("application data directory {} is unavailable", dir.display())), "{e}");
        std::fs::remove_file(&file).unwrap();
    }
}
