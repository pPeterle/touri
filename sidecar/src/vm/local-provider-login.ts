import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel } from "@touri/contracts"
import { loginTarget, readProviderLogin, redactProviderLogin, storedProviderLoginSource } from "./provider-login"

/** Materialize a bot's selected vault login only for the lifetime of its local CLI turn. */
export const prepareLocalProviderLogin = async (kernel: Kernel, bot: Bot, signal: AbortSignal) => {
  if (storedProviderLoginSource(kernel, bot) !== "vault") return { env: {}, release: () => {} }
  const login = await readProviderLogin(kernel, bot, homedir(), { signal })
  redactProviderLogin(kernel, login.value)
  if (bot.provider === "claude") return { env: { CLAUDE_CODE_OAUTH_TOKEN: login.value }, release: () => {} }
  const directory = mkdtempSync(join(kernel.paths.runDir, "provider-turn-"))
  chmodSync(directory, 0o700)
  try {
    const target = loginTarget(bot.provider)
    mkdirSync(join(directory, target.directory), { recursive: true, mode: 0o700 })
    writeFileSync(join(directory, target.directory, target.file), login.value, { mode: 0o600 })
    return {
      env:
        bot.provider === "codex"
          ? { CODEX_HOME: join(directory, ".codex") }
          : { XDG_DATA_HOME: join(directory, ".local/share") },
      release: () => rmSync(directory, { recursive: true, force: true }),
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
