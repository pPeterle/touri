mod keychain;
pub mod window;
pub use keychain::{KeychainStore, PRODUCTION_SERVICE};
use std::process::Command;
pub const HOST_COMPUTER: bool = true;
pub fn open_external(url: &str) -> Result<(), String> {
    Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("open external URL failed: {error}"))
}
pub fn reveal(path: &str) -> Result<(), String> {
    Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("reveal in Finder failed: {error}"))
}
pub fn permission_settings(permission: &str) -> Result<(), String> {
    let url = match permission {
        "accessibility" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
        "screen-recording" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        }
        _ => return Err("unknown permission".to_string()),
    };
    Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("open permission settings failed: {error}"))
}
