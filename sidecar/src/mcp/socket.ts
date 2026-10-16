import { chmodSync, mkdirSync, unlinkSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import { dirname } from "node:path"
import type { Kernel, ToolRegistration } from "@touri/contracts"
import { mcpEndpoint } from "../platform/transport"
import { MCP_LIMITS, serveMcpConnection } from "./connection"

const unlinkIfPresent = (path: string): void => {
  try {
    unlinkSync(path)
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
  }
}

export const createMcpSocket = ({
  kernel,
  registrations,
}: {
  kernel: Kernel
  registrations: Map<string, ToolRegistration>
}) => {
  const socketPath = mcpEndpoint(kernel.paths.runDir)
  const tokenDir = `${kernel.paths.runDir}/mcp-tokens`
  const connections = new Set<Socket>()
  let server: Server | null = null

  const listen = async (): Promise<void> => {
    mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })
    mkdirSync(tokenDir, { recursive: true, mode: 0o700 })
    chmodSync(dirname(socketPath), 0o700)
    chmodSync(tokenDir, 0o700)
    if (process.platform !== "win32") unlinkIfPresent(socketPath)
    const candidate = createServer((socket) => {
      if (connections.size >= MCP_LIMITS.connections) {
        socket.destroy()
        return
      }
      connections.add(socket)
      socket.once("close", () => connections.delete(socket))
      serveMcpConnection({ socket, kernel, tokenDir, registrations })
    })
    server = candidate
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        candidate.off("listening", onListening)
        reject(error)
      }
      const onListening = (): void => {
        candidate.off("error", onError)
        if (process.platform !== "win32") chmodSync(socketPath, 0o600)
        resolve()
      }
      candidate.once("error", onError)
      candidate.once("listening", onListening)
      candidate.listen(socketPath)
      candidate.unref()
    })
  }

  const close = async (): Promise<void> => {
    const active = server
    server = null
    if (active) {
      for (const connection of connections) connection.destroy()
      await new Promise<void>((resolve) => {
        try {
          active.close(() => resolve())
        } catch {
          resolve()
        }
      })
    }
    if (process.platform !== "win32") unlinkIfPresent(socketPath)
  }

  return { listen, close, socketPath }
}
