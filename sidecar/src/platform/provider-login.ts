import { win32 } from "node:path"
import type { Kernel } from "@touri/contracts"
import { buildChildEnv } from "../kernel/shell-env"
import { spawnTree } from "../kernel/spawn"

export type ProviderLoginPty =
  | { supported: true; command: string; args: string[] }
  | { supported: false; message: string }
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
/** Stdio stays a byte stream; the adapter supplies the provider's actual console. */
export const providerLoginPty = (
  platform: string,
  command: string,
  args: string[],
  helper = process.env.TOURI_DESKTOP_HELPER,
): ProviderLoginPty => {
  if (platform === "darwin")
    return {
      supported: true,
      command: "/usr/bin/expect",
      args: ["-c", "spawn -noecho {*}$argv; interact", "--", command, ...args],
    }
  if (platform === "linux")
    return {
      supported: true,
      command: "script",
      args: ["--quiet", "--return", "--flush", "--command", [command, ...args].map(quote).join(" "), "/dev/null"],
    }
  if (platform === "win32" && helper && win32.isAbsolute(helper))
    return { supported: true, command: helper, args: ["--provider-login-pty", "--", command, ...args] }
  return {
    supported: false,
    message:
      "The desktop ConPTY helper is unavailable. Start the installed desktop app, or log in in your terminal and import credentials in provider settings.",
  }
}

export const spawnProviderLoginPty = ({
  command,
  args,
  cwd,
  env = process.env,
  platform = process.platform,
  spawn = spawnTree,
}: {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  platform?: string
  spawn?: Kernel["spawnTree"]
}): ReturnType<Kernel["spawnTree"]> => {
  const pty = providerLoginPty(platform, command, args, env.TOURI_DESKTOP_HELPER)
  return pty.supported
    ? spawn({ cmd: pty.command, args: pty.args, cwd, env: buildChildEnv({ base: env }) })
    : { success: false, errorCode: "SPAWN_FAILED", error: pty.message }
}
