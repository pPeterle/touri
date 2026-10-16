# Desktop platforms

The desktop shell and sidecar can be built on macOS and Linux. Windows has build targets and native shell boundaries, but its sidecar runtime port is incomplete.

## Linux

Use Bun 1.2.21+, Rust 1.90+, GTK 3, WebKitGTK 4.1, Ayatana AppIndicator, librsvg, D-Bus development headers, patchelf and xdg-utils. Debian packages include `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev patchelf xdg-utils`. AppImage bundling requires network access to Tauri's packaging tools. `APPIMAGE_EXTRACT_AND_RUN=1` supports build hosts without FUSE.

```sh
bun install --frozen-lockfile
bun run build:sidecar:linux
bunx tauri build --bundles appimage,deb
```

Artifacts are under `src-tauri/target/release/bundle/{appimage,deb}`. For ARM64, run `bun run build:sidecar:linux:arm64` and build the shell on an ARM64 Linux host with its native development libraries. Generating the ARM64 sidecar alone does not cross-compile GTK/WebKit.

Data uses `$XDG_DATA_HOME/touri`, defaulting to `~/.local/share/touri`. `TOURI_APP_DATA` isolates a development/test instance. Host and MCP bridges use Unix sockets in the private run directory. Linux single-instance handoff uses a private XDG runtime directory, with a private cache directory fallback.

Secrets require a session D-Bus and an unlocked Secret Service, such as GNOME Keyring or a configured KeePassXC. A missing/locked service is an error with a doctor explanation; the desktop never falls back to plaintext storage. The separate server CLI retains its own existing secret-store policy.

Local bots are the default. For isolated bot containers, configure rootless Podman (preferred) or Docker, and check `podman info` / `docker info` in your terminal. Podman needs subordinate user IDs, unprivileged user namespaces, slirp4netns and the kernel support needed by nftables. Merely installing a container binary is insufficient. If the engine is unusable, `/machines` reports it unavailable and doctor explains that local bots remain available.

OCI bots use the existing `touri-bot:8` image, persistent workspace/browser mounts, a guest network namespace, and the same root-owned nftables policy and DNS controls. Guest control/browser/display ports are reached through private exec relays, never published ports. Podman disables slirp host loopback. Startup/network policy failures stop the bot. These Linux containers share the host kernel; they do not provide the separate guest kernel of Apple's VM backend. Docker access inherits the privileges of the configured daemon.

The current login UI imports an existing host login file or stores pasted credentials in the native vault. The PTY command adapter uses util-linux `script` for future interactive helpers; this change does not add a terminal/login UI. No provider login is required for build or fake-provider tests.

Host computer control is currently macOS-only and is hidden on Linux/Windows. Linux notifications and login startup use the Tauri platform plugins. Links/folder reveal use xdg-open. Local browser automation uses distribution Chromium/Chrome or `TOURI_CHROME_BIN`; no macOS browser download is attempted.

On hosts with limited disk space, disable incremental/debug artifacts while compiling. Remove disposable `src-tauri/target` intermediates after preserving bundles. A first guest image build may need substantially more space than the desktop build.

## Windows: remaining runtime work

`bun run build:sidecar:windows` generates `touri-sidecar-x86_64-pc-windows-msvc.exe`; `bun run build:sidecar:windows:gnu` generates the GNU variant for cross-checking. The native Windows Tauri overlay selects MSI and NSIS and includes an ICO. Windows installer packaging requires a Windows toolchain/host and has not been exercised on Linux.

The Rust shell uses Credential Manager and token-authenticated ephemeral loopback TCP for its host bridge. Sidecar endpoint parsing accepts only loopback TCP; MCP has a data-directory-scoped named-pipe endpoint with the existing per-thread token protocol. Docker Desktop/WSL2 uses the OCI command provider.

Windows onboarding is **not ready**. Remaining work:

- Replace the sidecar's POSIX FFI file operations, flock ownership/parent/process checks, and Unix-oriented extra process descriptors with native handle/ACL/job-object implementations. Bun 1.2's FFI-dependent paths currently prevent a usable Windows runtime.
- Implement ConPTY. The PTY adapter explicitly reports unsupported and directs users to terminal login plus credential import.
- Implement native single-instance handoff and file identity for attachment grants. File drops fail closed until native identity is available.
- Validate named-pipe ACLs, per-user application directory ACLs, shell/PATH separators, native provider paths, child cancellation and Docker Desktop network isolation on Windows.
- Build/run MSI and NSIS on Windows and run the full test suites there. A Linux GNU cargo check is compile evidence only.

## Validation without provider accounts

```sh
TOURI_VM_INTEGRATION=0 TOURI_E2E_REAL_CLI=0 TOURI_OPENCODE_REAL=0 \
  TOURI_DOCTOR_SKIP_PROVIDER_PROBES=1 bun test sidecar/test
bun --cwd ui test --maxWorkers=1 --minWorkers=1
bun run typecheck
bun run lint
cargo test --manifest-path src-tauri/Cargo.toml
```

The native secret round-trip test is ignored by default because it requires an unlocked desktop service. In an isolated session with such a service, run `cargo test --manifest-path src-tauri/Cargo.toml native_secret_round_trip -- --ignored`. It uses a dedicated test service/account and deletes its fixture. Fake provider fixtures can exercise the first-message protocol without launching any real provider CLI.
