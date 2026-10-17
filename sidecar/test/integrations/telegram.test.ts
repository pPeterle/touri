import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel, NotificationRecord, Routine, RoutineRun, Run, TelegramIntegration } from "@touri/contracts"
import { createFakeTelegram } from "../../../test/fakes/fake-telegram"
import { createTelegramIntegrations } from "../../src/integrations/telegram"
import { splitMessage } from "../../src/integrations/telegram/text"
import { createKernel } from "../../src/kernel"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { init as initStore } from "../../src/store"

const TOKEN = "123456789:AAExampleTokenForTouriTests_123456"
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.()
})

const until = async (check: () => boolean, label = "condition") => {
  for (let i = 0; i < 400; i++) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const fixture = async ({ token = TOKEN }: { token?: string } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "touri-telegram-"))
  const runtime = createKernel({ appData: root })
  const kernel = runtime.kernel
  const vault = new Map<string, string>()
  const host = kernel.callHost
  kernel.callHost = (async (method, input) => {
    const body = input as { account: string; value: string }
    if (method === "keychain.get") return { success: true, value: { value: vault.get(body.account) ?? null } }
    if (method === "keychain.set") {
      vault.set(body.account, body.value)
      return { success: true, value: {} }
    }
    if (method === "keychain.delete") {
      vault.delete(body.account)
      return { success: true, value: {} }
    }
    return host(method, input)
  }) as Kernel["callHost"]
  await initStore(kernel)
  const store = kernel.services.use("store.api")
  if (!store) throw new Error("store missing")
  const persistence = createRuntimePersistence({ database: kernel.db as Database })
  const runs: Array<Run> = []
  kernel.services.provide("runtime.enqueue", ({ threadId, requestMessageId, trigger }) => {
    const thread = store.getThread({ threadId })
    const run: Run = {
      id: kernel.newId(),
      threadId,
      botId: thread?.botId ?? "",
      provider: "codex",
      trigger,
      requestMessageId,
      replyMessageId: null,
      externalTurnId: null,
      status: "running",
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
      queuedAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: null,
    }
    persistence.saveRun(run)
    runs.push(run)
    kernel.publish({ type: "run.updated", run })
    return { success: true, run }
  })
  const canceled: Array<string> = []
  kernel.services.provide(
    "runtime.activeRun",
    ({ threadId }) => runs.find((run) => run.threadId === threadId && run.status === "running") ?? null,
  )
  kernel.services.provide("runtime.cancelRun", ({ runId }) => {
    canceled.push(runId)
    return true
  })
  const answers: Array<{ approvalId: string; decision: string; message?: string }> = []
  kernel.services.provide("runtime.answerApproval", async (args) => {
    answers.push(args)
    return { success: true }
  })
  const resolved: Array<{ requestId: string; resolution: string }> = []
  kernel.services.provide("notify.resolve", (args) => {
    resolved.push(args)
  })
  const fake = createFakeTelegram({ token })
  const integrations = createTelegramIntegrations({ kernel, apiBase: fake.url, pollTimeoutSec: 0 })
  kernel.registerRoutes(integrations.routes)
  cleanup.push(async () => {
    await integrations.stopAll()
    fake.stop()
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: "Bearer dev-ui-token",
        "x-touri-client": "telegram-test",
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const created = await request("POST", "/bots", { name: "Email", provider: "codex", instructions: "Ajude." })
  const bot = created.body.bot as Bot
  const telegram = async () =>
    ((await request("GET", `/bots/${bot.id}/integrations/telegram`)).body as { telegram: TelegramIntegration }).telegram
  const configure = async (body: Record<string, unknown>) => {
    const response = await request("PUT", `/bots/${bot.id}/integrations/telegram`, body)
    if (response.status !== 200) throw new Error(JSON.stringify(response.body))
    return (response.body as { telegram: TelegramIntegration }).telegram
  }
  const finish = (run: Run, text: string) => {
    const reply = store.insertMessage({
      message: {
        id: kernel.newId(),
        threadId: run.threadId,
        parentId: run.requestMessageId,
        role: "assistant",
        kind: "text",
        status: "complete",
        runId: run.id,
        text,
        parts: [{ type: "text", text }],
        sender: null,
        source: "local",
      },
    })
    if (!reply.success) throw new Error(reply.error)
    Object.assign(run, { status: "succeeded", replyMessageId: reply.message.id, finishedAt: Date.now() })
    persistence.saveRun(run)
    kernel.publish({ type: "run.updated", run: { ...run } })
  }
  return { kernel, store, fake, runs, canceled, answers, resolved, bot, telegram, configure, finish, vault, request }
}

const notification = (patch: Partial<NotificationRecord>): NotificationRecord => ({
  id: 1,
  kind: "approval",
  level: "warning",
  botId: null,
  botName: "Email",
  botColor: "#000",
  avatarShape: "cercle",
  threadId: null,
  title: "Aprovar comando",
  body: "rm -rf /tmp/x",
  requestId: "request-1",
  createdAt: Date.now(),
  resolvedAt: null,
  resolution: null,
  ...patch,
})

test("Telegram is off by default, keeps the token secret and ignores senders outside the allowlist", async () => {
  const f = await fixture()
  expect(await f.telegram()).toMatchObject({
    config: { enabled: false, allowedUserIds: [], homeChatId: null, forwardRoutines: false },
    tokenSaved: false,
    status: { state: "off" },
  })
  const saved = await f.configure({ token: TOKEN, enabled: true })
  expect(saved.tokenSaved).toBe(true)
  expect(JSON.stringify(saved)).not.toContain(TOKEN)
  expect(f.kernel.redact(`token ${TOKEN}`)).not.toContain(TOKEN)
  await until(() => f.fake.sent("getUpdates").length > 0, "polling")
  expect((await f.telegram()).status).toEqual({ state: "connected", username: "touri_test_bot", error: null })
  f.fake.message({ from: 77, name: "Estranho", text: "oi" })
  await until(() => f.fake.sent("getUpdates").some((call) => Number(call.params.offset) === 2), "offset")
  expect(f.runs).toEqual([])
  expect(f.fake.sent()).toEqual([])
  expect((await f.telegram()).lastRejected).toMatchObject({ userId: "77", name: "Estranho" })
  expect(
    (f.kernel.db as Database).query("SELECT COUNT(*) AS n FROM threads WHERE title LIKE 'Telegram%'").get(),
  ).toEqual({ n: 0 })
})

test("an allowed private chat maps to one thread, gets typing and receives the reply split under the limit", async () => {
  const f = await fixture()
  await f.configure({ token: TOKEN, enabled: true, allowedUserIds: ["42"] })
  f.fake.message({ text: "Resuma meus e-mails" })
  await until(() => f.runs.length === 1, "first run")
  const run = f.runs[0] as Run
  const thread = f.store.getThread({ threadId: run.threadId })
  expect(thread?.title).toBe("Telegram · Ana")
  expect(f.store.activePath({ threadId: run.threadId }).at(-1)?.text).toBe("Resuma meus e-mails")
  await until(() => f.fake.sent("sendChatAction").length > 0, "typing")
  const long = `Resumo:\n\`\`\`\n${"linha de código\n".repeat(400)}\`\`\`\nFim.`
  f.finish(run, long)
  await until(() => f.fake.sent().length >= 2, "reply chunks")
  const chunks = f.fake.sent().map((call) => String(call.params.text))
  expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true)
  for (const chunk of chunks) expect((chunk.match(/```/g) ?? []).length % 2).toBe(0)
  expect(chunks.join("\n")).toContain("Fim.")
  f.fake.message({ text: "E os de ontem?" })
  await until(() => f.runs.length === 2, "second run")
  expect(f.runs[1]?.threadId).toBe(run.threadId)
  f.fake.message({ text: "grupo", chatType: "group" })
  await until(() => f.fake.sent("getUpdates").some((call) => Number(call.params.offset) === 4), "group update")
  expect(f.runs).toHaveLength(2)
})

test("/stop cancels the active run and /new starts another thread", async () => {
  const f = await fixture()
  await f.configure({ token: TOKEN, enabled: true, allowedUserIds: ["42"] })
  f.fake.message({ text: "Começa" })
  await until(() => f.runs.length === 1, "run")
  f.fake.message({ text: "/stop" })
  await until(() => f.canceled.length === 1, "cancel")
  expect(f.canceled).toEqual([f.runs[0]?.id ?? ""])
  await until(() => f.fake.sent().some((call) => call.params.text === "Parei a resposta em andamento."), "stop reply")
  f.fake.message({ text: "/new" })
  await until(() => f.fake.sent().some((call) => String(call.params.text).startsWith("Nova conversa")), "new reply")
  f.fake.message({ text: "Outro assunto" })
  await until(() => f.runs.length === 2, "second run")
  expect(f.runs[1]?.threadId).not.toBe(f.runs[0]?.threadId)
})

test("approval buttons answer once, only for allowed users, and expire afterwards", async () => {
  const f = await fixture()
  await f.configure({ token: TOKEN, enabled: true, allowedUserIds: ["42"] })
  f.fake.message({ text: "Apague o arquivo" })
  await until(() => f.runs.length === 1, "run")
  f.kernel.publish({
    type: "notification.created",
    notification: notification({ botId: f.bot.id, threadId: f.runs[0]?.threadId ?? null }),
  })
  await until(() => f.fake.sent().some((call) => call.params.reply_markup), "prompt")
  const prompt = f.fake.sent().find((call) => call.params.reply_markup)
  const keyboard = prompt?.params.reply_markup as {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
  }
  const [approve] = keyboard.inline_keyboard[0] ?? []
  expect(approve?.text).toBe("Aprovar")
  expect(Buffer.byteLength(approve?.callback_data ?? "")).toBeLessThanOrEqual(64)
  f.fake.tap({ from: 99, name: "Outro", data: approve?.callback_data ?? "" })
  await until(() => f.fake.sent("answerCallbackQuery").length === 1, "denied tap")
  expect(f.fake.sent("answerCallbackQuery")[0]?.params.text).toBe("Sem permissão.")
  expect(f.answers).toEqual([])
  f.fake.tap({ data: approve?.callback_data ?? "" })
  await until(() => f.answers.length === 1, "answer")
  expect(f.answers[0]).toEqual({ approvalId: "request-1", decision: "approved" })
  expect(f.resolved).toEqual([{ requestId: "request-1", resolution: "allow" }])
  await until(() => f.fake.sent("editMessageText").length === 1, "edit")
  expect(String(f.fake.sent("editMessageText")[0]?.params.text)).toContain("Aprovado por Ana.")
  f.fake.tap({ data: approve?.callback_data ?? "" })
  await until(() => f.fake.sent("answerCallbackQuery").length === 3, "second tap")
  expect(f.fake.sent("answerCallbackQuery")[2]?.params.text).toBe("Pedido expirado.")
  expect(f.answers).toHaveLength(1)
})

test("routine results reach the home chat only when forwarding is on", async () => {
  const f = await fixture()
  await f.configure({ token: TOKEN, enabled: true, allowedUserIds: ["42"] })
  await until(() => f.fake.sent("getUpdates").length > 0, "polling")
  const routine = { id: "routine-1", botId: f.bot.id, name: "E-mails das 8h" } as Routine
  const finished = (id: string): RoutineRun => ({
    id,
    routineId: routine.id,
    scheduledFor: Date.now(),
    status: "succeeded",
    threadId: null,
    runId: null,
    triggerSource: "cron",
    summary: "3 e-mails importantes",
    startedAt: Date.now(),
    finishedAt: Date.now(),
  })
  f.kernel.publish({ type: "routine.updated", routine, lastRun: finished("run-a") })
  await Bun.sleep(30)
  expect(f.fake.sent()).toEqual([])
  await f.configure({ forwardRoutines: true, homeChatId: "42" })
  f.kernel.publish({ type: "routine.updated", routine, lastRun: finished("run-b") })
  f.kernel.publish({ type: "routine.updated", routine, lastRun: finished("run-b") })
  await until(() => f.fake.sent().length === 1, "routine delivery")
  expect(f.fake.sent()[0]?.params).toMatchObject({ chat_id: "42", text: "E-mails das 8h: 3 e-mails importantes" })
  await Bun.sleep(30)
  expect(f.fake.sent()).toHaveLength(1)
})

test("a revoked token stops polling with a clear status, and invalid input is rejected", async () => {
  const f = await fixture({ token: "999999:SomeOtherTokenThatTheFakeExpects_1" })
  const saved = await f.configure({ token: TOKEN, enabled: true })
  expect(saved.tokenSaved).toBe(true)
  for (let i = 0; i < 100 && (await f.telegram()).status.state !== "error"; i++) await Bun.sleep(5)
  expect((await f.telegram()).status).toEqual({ state: "error", username: null, error: "Token inválido ou revogado." })
  const invalid = await f.request("PUT", `/bots/${f.bot.id}/integrations/telegram`, { token: "não é token" })
  expect(invalid.status).toBe(400)
  await f.configure({ allowedUserIds: ["42", "abc", "-100", "42"] })
  expect((await f.telegram()).config.allowedUserIds).toEqual(["42"])
  await f.configure({ token: null, enabled: false })
  expect(await f.telegram()).toMatchObject({ tokenSaved: false, status: { state: "off" } })
})

test("splitMessage keeps short text whole and never breaks a code fence or the limit", () => {
  expect(splitMessage("oi")).toEqual(["oi"])
  expect(splitMessage("")).toEqual([])
  const text = [
    "Antes",
    "```ts",
    ...Array.from({ length: 300 }, (_, i) => `const value${i} = ${i}`),
    "```",
    "Depois",
  ].join("\n")
  const chunks = splitMessage(text, 500)
  expect(chunks.length).toBeGreaterThan(1)
  for (const chunk of chunks) {
    expect(chunk.length).toBeLessThanOrEqual(500)
    expect((chunk.match(/```/g) ?? []).length % 2).toBe(0)
  }
  expect(chunks.at(-1)).toContain("Depois")
  const wide = splitMessage("x".repeat(1200), 500)
  expect(wide.map((chunk) => chunk.length)).toEqual([500, 500, 200])
})
