//! Private Unix sockets on Unix, token-authenticated loopback streams on Windows.
#[cfg(windows)]
pub use std::net::{TcpListener as Listener, TcpStream as Stream};
#[cfg(unix)]
pub use std::os::unix::net::{UnixListener as Listener, UnixStream as Stream};
use std::path::{Path, PathBuf};
#[cfg(unix)]
pub fn listen(path: &Path) -> Result<(Listener, PathBuf), String> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    let listener = Listener::bind(path).map_err(|e| format!("bind host socket failed: {e}"))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    Ok((listener, path.to_path_buf()))
}
#[cfg(windows)]
pub fn listen(_: &Path) -> Result<(Listener, PathBuf), String> {
    let listener = Listener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
    let endpoint = PathBuf::from(format!(
        "tcp://{}",
        listener.local_addr().map_err(|e| e.to_string())?
    ));
    Ok((listener, endpoint))
}
pub fn connect(path: &Path) -> std::io::Result<Stream> {
    #[cfg(unix)]
    {
        Stream::connect(path)
    }
    #[cfg(windows)]
    {
        let address = path
            .to_str()
            .and_then(|s| s.strip_prefix("tcp://"))
            .and_then(|s| s.parse::<std::net::SocketAddr>().ok())
            .filter(|address| address.ip() == std::net::Ipv4Addr::LOCALHOST && address.port() > 0)
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "invalid loopback host bridge endpoint",
                )
            })?;
        Stream::connect(address)
    }
}
pub fn wake(path: &Path) {
    let _ = connect(path);
}
pub fn cleanup(path: &Path) {
    #[cfg(unix)]
    let _ = std::fs::remove_file(path);
    #[cfg(windows)]
    let _ = path;
}
