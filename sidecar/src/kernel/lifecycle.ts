import { dlopen, read } from "bun:ffi"
import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, openSync, readSync, writeSync } from "node:fs"
import { join } from "node:path"
import type { AppPaths } from "@touri/contracts"
import { closeOnExec, errnoSymbol, libcLibrary, wouldBlock } from "../platform/posix"
import { ensurePrivateDirectory } from "./files"

const native = dlopen(libcLibrary, {
  flock: { args: ["i32", "i32"], returns: "i32" },
  getppid: { args: [], returns: "i32" },
  [errnoSymbol]: { args: [], returns: "ptr" },
}).symbols

type Identity = { startTime: string; parentPid: number; alive: boolean }
type Owner = { pid: number; startTime: string; parentPid: number | null }

const signal = (pid: number, kind: "SIGTERM" | "SIGKILL") => {
  try {
    process.kill(pid, kind)
  } catch (error) {
    // The verified owner can exit between ps and kill; retry flock in that case.
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
  }
}

const identity = (pid: number): Identity | null => {
  const result = Bun.spawnSync({
    cmd: ["/bin/ps", "-o", "stat=,ppid=,lstart=", "-p", String(pid)],
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    stdout: "pipe",
    stderr: "ignore",
    timeout: 1000,
  })
  const match = result.stdout
    .toString()
    .trim()
    .match(/^(\S+)\s+(\d+)\s+(.+)$/)
  return result.exitCode === 0 && match
    ? { startTime: match[3] ?? "", parentPid: Number(match[2]), alive: !/^[ZX]/.test(match[1] ?? "") }
    : null
}

/** Never unlink this file: flock pins its inode until every runtime operation has ended. */
export const acquireRuntimeLock = async (
  paths: AppPaths,
  {
    timeoutMs = 10_000,
    parentPid = Number(process.env.TOURI_PARENT_PID ?? native.getppid()),
  }: { timeoutMs?: number; parentPid?: number | null } = {},
): Promise<{ release: () => void }> => {
  ensurePrivateDirectory({ root: paths.appData, path: paths.runDir })
  const fd = openSync(
    join(paths.runDir, "runtime.lock"),
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | closeOnExec,
    0o600,
  )
  const started = Date.now()
  let signaled: Owner | null = null
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Lock do runtime inválido")
    fchmodSync(fd, 0o600)
    while (native.flock(fd, 2 | 4) !== 0) {
      const pointer = native[errnoSymbol]?.()
      const errno = pointer ? read.i32(pointer) : 0
      if (errno !== wouldBlock) throw new Error(`Falha no lock do runtime (${errno})`)
      let owner: Owner | null = null
      try {
        const bytes = Buffer.alloc(4096)
        const count = readSync(fd, bytes, 0, bytes.length, 0)
        const value = JSON.parse(bytes.subarray(0, count).toString()) as Owner
        if (Number.isSafeInteger(value.pid) && value.pid > 1 && typeof value.startTime === "string") owner = value
      } catch {
        /* Another process may still be writing its ownership record. */
      }
      const current = owner ? identity(owner.pid) : null
      if (owner && current?.alive && current.startTime === owner.startTime) {
        // A headless daemon deliberately has no supervising shell; PPID 1 is valid for it.
        if (
          current.parentPid !== 1 ||
          owner.parentPid === null ||
          !Number.isSafeInteger(owner.parentPid) ||
          owner.parentPid <= 1
        )
          throw new Error(`Já existe um runtime ativo para esta pasta (PID ${owner.pid})`)
        // Only a verified orphan holding this data directory's lock can be signaled.
        if (!signaled) {
          signal(owner.pid, "SIGTERM")
          signaled = owner
        } else if (
          Date.now() - started >= timeoutMs / 2 &&
          signaled.pid === owner.pid &&
          signaled.startTime === owner.startTime
        ) {
          signal(owner.pid, "SIGKILL")
        }
      }
      if (Date.now() - started >= timeoutMs) throw new Error("O runtime anterior não liberou a pasta de dados")
      await Bun.sleep(50)
    }
    const current = identity(process.pid)
    if (!current) throw new Error("Não foi possível identificar o runtime")
    ftruncateSync(fd, 0)
    writeSync(fd, JSON.stringify({ pid: process.pid, startTime: current.startTime, parentPid }), 0, "utf8")
    let released = false
    return {
      release: () => {
        if (!released) {
          released = true
          closeSync(fd)
        }
      },
    }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

export const watchParent = (
  shutdown: () => void,
  parentPid = Number(process.env.TOURI_PARENT_PID ?? process.ppid),
): (() => void) => {
  const check = () => {
    // Bun's process.ppid can retain the launch-time value after reparenting.
    if (parentPid <= 1 || native.getppid() !== parentPid) shutdown()
  }
  const timer = setInterval(check, 250)
  timer.unref()
  check()
  return () => clearInterval(timer)
}
