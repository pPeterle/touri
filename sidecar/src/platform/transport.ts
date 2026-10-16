import { createHash } from "node:crypto"
import { join } from "node:path"
/** Internal endpoints never accept a remote TCP host. Token auth still runs above the transport. */
export const connectionOptions = (endpoint: string): { path: string } | { host: "127.0.0.1"; port: number } => {
  if (!endpoint.startsWith("tcp:")) return { path: endpoint }
  const url = new URL(endpoint)
  const port = Number(url.port)
  if (
    url.hostname !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    url.username ||
    url.password ||
    url.pathname ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid loopback bridge endpoint")
  return { host: "127.0.0.1", port }
}
export const mcpEndpoint = (runDir: string, platform = process.platform) =>
  platform === "win32"
    ? `\\\\.\\pipe\\touri-mcp-${createHash("sha256").update(runDir).digest("hex").slice(0, 32)}`
    : join(runDir, "mcp.sock")
