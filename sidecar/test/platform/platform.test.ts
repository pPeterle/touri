import { expect, test } from "bun:test"
import { posix } from "node:path"
import { ociEngine } from "../../src/platform"
import * as linux from "../../src/platform/linux"
import * as macos from "../../src/platform/macos"
import { connectionOptions, mcpEndpoint } from "../../src/platform/transport"
import * as windows from "../../src/platform/windows"

test("data paths follow each platform and XDG/AppData overrides", () => {
  expect(linux.defaultDataRoot("/test-home", {})).toBe("/test-home/.local/share/touri")
  expect(linux.defaultDataRoot("/test-home", { TOURI_HEADLESS: "1" })).toBe("/test-home/.touri")
  expect(linux.defaultDataRoot("/test-home", { XDG_DATA_HOME: "/data" })).toBe("/data/touri")
  expect(windows.defaultDataRoot("C:\\Users\\test", { APPDATA: "D:\\Data" })).toBe("D:\\Data\\touri")
  expect(macos.defaultDataRoot("/test-home")).toBe(posix.join("/test-home", "Library", "Application Support", "touri"))
})
test("prefer rootless Podman on Linux and Docker Desktop on Windows", () => {
  const which = (name: string) => name
  expect(ociEngine("linux", which)).toBe("podman")
  expect(ociEngine("win32", which)).toBe("docker")
  expect(ociEngine("darwin", which)).toBeNull()
  expect(ociEngine("linux", () => null)).toBeNull()
})
test("bridge TCP endpoint validation forbids remote hosts and URL credentials", () => {
  expect(connectionOptions("tcp://127.0.0.1:4321")).toEqual({ host: "127.0.0.1", port: 4321 })
  for (const value of [
    "tcp://example.test:12",
    "tcp://localhost:12",
    "tcp://127.0.0.1:0",
    "tcp://user@127.0.0.1:12",
    "tcp://127.0.0.1:12/path",
  ])
    expect(() => connectionOptions(value)).toThrow()
  expect(connectionOptions("/run/touri/host.sock")).toEqual({ path: "/run/touri/host.sock" })
})
test("MCP pipe names are stable and scoped to a data directory", () => {
  expect(mcpEndpoint("a", "win32")).toMatch(/^\\\\\.\\pipe\\touri-mcp-[a-f0-9]{32}$/)
  expect(mcpEndpoint("a", "win32")).not.toBe(mcpEndpoint("b", "win32"))
  expect(mcpEndpoint("a", "linux")).toBe("a/mcp.sock")
})

test("PTY adapters keep commands as arguments and explain the Windows limitation", async () => {
  const { providerLoginPty } = await import("../../src/platform/provider-login")
  const linux = providerLoginPty("linux", "example-provider", ["login", "literal;argument"])
  expect(linux).toMatchObject({ supported: true, command: "script" })
  if (linux.supported) expect(linux.args).toContain("'example-provider' 'login' 'literal;argument'")
  expect(providerLoginPty("darwin", "example-provider", ["login"])).toMatchObject({
    supported: true,
    command: "/usr/bin/expect",
  })
  expect(providerLoginPty("win32", "example-provider", [])).toMatchObject({
    supported: false,
    message: expect.stringContaining("ConPTY"),
  })
})

test("Linux process identity handles parenthesized names and refuses malformed/reused PIDs", () => {
  const fields = ["S", "7", ...Array(17).fill("0"), "123456"]
  const stat = `42 (process (with) spaces) ${fields.join(" ")}`
  expect(linux.parseProcessIdentity(42, stat)).toEqual({ startTime: "linux:123456", parentPid: 7, alive: true })
  expect(linux.parseProcessIdentity(43, stat)).toBeNull()
  expect(linux.parseProcessIdentity(42, "42 (broken) S 7")).toBeNull()
  expect(linux.parseProcessIdentity(42, stat.replace(") S", ") Z"))?.alive).toBe(false)
})
