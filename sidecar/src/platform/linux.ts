import { homedir } from "node:os"
import { join } from "node:path"
export const defaultDataRoot = (home = homedir(), env = process.env) =>
  join(env.XDG_DATA_HOME || join(home, ".local", "share"), "touri")
export const secretStoreLabel = "Secret Service"
export const secretStoreFix =
  "Unlock your desktop keyring and ensure a Secret Service (for example GNOME Keyring or KeePassXC) is running on the session D-Bus"
export const appOpenCommand = "touri"
export const installTools = [
  ["git", "Install git with your distribution package manager"],
  ["node", "Install Node.js 22 or newer"],
  ["pnpm", "npm install -g pnpm"],
  ["podman", "Install rootless Podman and enable unprivileged user namespaces"],
  ["docker", "Install Docker Engine or Docker Desktop"],
]

export const systemSettingsCommand = "Review system network and proxy settings"
