#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = touri_lib::provider_login_pty::entry(std::env::args_os().skip(1).collect())
    {
        std::process::exit(code);
    }
    touri_lib::run();
}
