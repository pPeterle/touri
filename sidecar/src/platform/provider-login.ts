export type ProviderLoginPty =
  | { supported: true; command: string; args: string[] }
  | { supported: false; message: string }
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
/** The desktop currently accepts imported login credentials. This adapter is for interactive login helpers. */
export const providerLoginPty = (platform: string, command: string, args: string[]): ProviderLoginPty => {
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
  return {
    supported: false,
    message:
      "Interactive provider login requires a ConPTY helper on Windows. Log in in your terminal and import credentials in the provider settings.",
  }
}
