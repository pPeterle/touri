//! A stdio-to-ConPTY adapter, entered before initializing Tauri or a webview.
use std::ffi::OsString;
#[cfg(any(windows, test))]
use std::io::{self, Read, Write};

const FLAG: &str = "--provider-login-pty";

fn command(mut args: Vec<OsString>) -> Result<Option<Vec<OsString>>, &'static str> {
    if args.first().is_none_or(|arg| arg != FLAG) {
        return Ok(None);
    }
    if args.get(1).is_none_or(|arg| arg != "--") || args.get(2).is_none_or(|arg| arg.is_empty()) {
        return Err("Usage: touri --provider-login-pty -- executable [args...]");
    }
    Ok(Some(args.drain(2..).collect()))
}

/// Returns None for an ordinary desktop launch. Arguments never pass through a shell.
pub fn entry(args: Vec<OsString>) -> Option<i32> {
    let result = match command(args) {
        Ok(None) => return None,
        Ok(Some(args)) => run(args),
        Err(error) => Err(error.to_owned()),
    };
    Some(match result {
        Ok(code) => code,
        Err(error) => {
            eprintln!("ConPTY helper: {error}");
            2
        }
    })
}

// Flush prompts that do not end in a newline. No terminal output is logged here.
#[cfg(any(windows, test))]
fn copy_flushed(mut input: impl Read, mut output: impl Write) -> io::Result<()> {
    let mut bytes = [0; 8192];
    loop {
        let count = input.read(&mut bytes)?;
        if count == 0 {
            return Ok(());
        }
        output.write_all(&bytes[..count])?;
        output.flush()?;
    }
}

#[cfg(not(windows))]
fn run(_: Vec<OsString>) -> Result<i32, String> {
    Err("ConPTY is available on Windows; use the platform PTY adapter on this OS".into())
}

#[cfg(windows)]
fn run(args: Vec<OsString>) -> Result<i32, String> {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    // Install a job before spawning, so killing the helper also kills descendants.
    // The handle intentionally lives until process exit, including on error paths.
    let job = super::platform::windows_job::own_process_tree().map_err(|e| e.to_string())?;
    std::mem::forget(job);
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut command = CommandBuilder::new(&args[0]);
    command.args(&args[1..]);
    command.cwd(std::env::current_dir().map_err(|e| e.to_string())?);
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| e.to_string())?;
    drop(pair.slave);
    std::thread::spawn(move || {
        let _ = copy_flushed(io::stdin().lock(), writer);
    });
    let output = std::thread::spawn(move || copy_flushed(reader, io::stdout().lock()));
    let status = child.wait().map_err(|e| e.to_string())?;
    // Close the pseudoconsole while the output thread continues draining its pipe.
    drop(pair.master);
    let _ = output.join();
    Ok(i32::try_from(status.exit_code()).unwrap_or(1))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn helper_mode_preserves_arguments_and_does_not_intercept_desktop_launches() {
        assert_eq!(command(vec![]).unwrap(), None);
        assert_eq!(command(vec!["--other".into()]).unwrap(), None);
        let args = [
            FLAG,
            "--",
            "provider.exe",
            "login",
            "a & b",
            "\"quoted\"",
            "",
        ];
        assert_eq!(
            command(args.map(OsString::from).to_vec()).unwrap(),
            Some(args[2..].iter().map(OsString::from).collect())
        );
        for args in [
            vec![FLAG.into()],
            vec![FLAG.into(), "provider.exe".into()],
            vec![FLAG.into(), "--".into(), "".into()],
        ] {
            assert!(command(args).is_err());
        }
    }
    #[test]
    fn console_io_preserves_browser_code_bytes_and_flushes_prompts() {
        #[derive(Default)]
        struct Output {
            bytes: Vec<u8>,
            flushes: usize,
        }
        impl Write for Output {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.bytes.extend(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                self.flushes += 1;
                Ok(())
            }
        }
        let mut output = Output::default();
        let bytes = "browser-code-fixture\r\nUTF-8: café".as_bytes();
        copy_flushed(bytes, &mut output).unwrap();
        assert_eq!(output.bytes, bytes);
        assert!(output.flushes > 0);
    }
}
