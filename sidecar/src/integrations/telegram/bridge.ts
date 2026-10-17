import type {
  Id,
  Kernel,
  NotificationRecord,
  Routine,
  RoutineRun,
  Run,
  TelegramIntegrationStatus,
  Thread,
  UiEvent,
} from "@touri/contracts"
import {
  createTelegramApi,
  type TelegramApi,
  TelegramApiError,
  type TelegramCallbackQuery,
  type TelegramMessage,
  type TelegramUpdate,
  type TelegramUser,
} from "./api"
import type { TelegramStore } from "./store"
import { splitMessage } from "./text"

const ACTIVE: ReadonlyArray<Run["status"]> = ["queued", "starting", "running"]
const TYPING_EVERY_MS = 4_000
const TYPING_MAX_MS = 15 * 60_000
const ROUTINE_FRESH_MS = 10 * 60_000
const MAX_PENDING_PROMPTS = 200
const BACKOFF_MS = [2_000, 5_000, 15_000, 60_000]

type Prompt = {
  requestId: string
  kind: "approval" | "question"
  chatId: string
  messageId: number
  text: string
  settled: boolean
}

const displayName = (user: TelegramUser | undefined): string =>
  [user?.first_name, user?.last_name].filter(Boolean).join(" ") ||
  (user?.username ? `@${user.username}` : String(user?.id ?? ""))

/** One long-polling connection between a bot and its Telegram account. */
export const createTelegramBridge = ({
  kernel,
  botId,
  token,
  store,
  apiBase,
  pollTimeoutSec = 25,
  onStatus,
}: {
  kernel: Kernel
  botId: Id
  token: string
  store: TelegramStore
  apiBase?: string
  pollTimeoutSec?: number
  onStatus: (status: TelegramIntegrationStatus) => void
}) => {
  const api: TelegramApi = createTelegramApi({ token, ...(apiBase ? { base: apiBase } : {}) })
  const controller = new AbortController()
  const typing = new Map<string, { timer: ReturnType<typeof setInterval>; started: number }>()
  const forwarded = new Set<Id>()
  const routinesSent = new Set<Id>()
  const prompts = new Map<string, Prompt>()
  let promptSeq = 0
  let stopped = false
  let loop: Promise<void> = Promise.resolve()

  const log = (msg: string, data?: Record<string, unknown>) =>
    kernel.log({ level: "warn", module: "telegram", msg, ...(data ? { data } : {}) })
  const errorText = (error: unknown): string =>
    kernel.redact(error instanceof TelegramApiError ? error.description : String(error))

  const storeApi = () => kernel.services.use("store.api")
  const config = () => store.config(botId)
  const allowed = (userId: number | undefined): boolean =>
    userId !== undefined && config().allowedUserIds.includes(String(userId))
  const chatForThread = (threadId: Id): string | null => {
    for (const [chatId, linked] of Object.entries(store.state(botId).chats)) if (linked === threadId) return chatId
    return null
  }

  const send = async (chatId: string, text: string): Promise<void> => {
    for (const chunk of splitMessage(text)) await api.sendMessage({ chat_id: chatId, text: chunk })
  }
  const safeSend = (chatId: string, text: string): Promise<void> =>
    send(chatId, text).catch((error) => log("Falha ao enviar mensagem ao Telegram", { error: errorText(error) }))

  const stopTyping = (chatId: string) => {
    const entry = typing.get(chatId)
    if (entry) clearInterval(entry.timer)
    typing.delete(chatId)
  }
  const startTyping = (chatId: string) => {
    if (typing.has(chatId) || stopped) return
    const tick = () => {
      const entry = typing.get(chatId)
      if (entry && Date.now() - entry.started > TYPING_MAX_MS) {
        stopTyping(chatId)
        return
      }
      void api.sendChatAction({ chat_id: chatId, action: "typing" }).catch(() => undefined)
    }
    typing.set(chatId, { timer: setInterval(tick, TYPING_EVERY_MS), started: Date.now() })
    tick()
  }

  const linkedThread = (chatId: string): Thread | null => {
    const threadId = store.state(botId).chats[chatId]
    const thread = threadId ? storeApi()?.getThread({ threadId }) : null
    return thread && thread.botId === botId && !thread.archivedAt ? thread : null
  }
  const newThread = (message: TelegramMessage): Thread | null => {
    const created = storeApi()?.createThread({
      botId,
      kind: "chat",
      title: `Telegram · ${displayName(message.from)}`.slice(0, 80),
    })
    if (!created?.success) return null
    const state = store.state(botId)
    store.saveState(botId, { ...state, chats: { ...state.chats, [String(message.chat.id)]: created.thread.id } })
    return created.thread
  }

  const command = async (message: TelegramMessage, name: string): Promise<boolean> => {
    const chatId = String(message.chat.id)
    const bot = storeApi()?.getBot({ botId })
    if (name === "/start") {
      await send(chatId, `Conectado a ${bot?.name ?? "touri"}. Mande uma mensagem para começar.`)
      return true
    }
    if (name === "/new") {
      const thread = newThread(message)
      await send(chatId, thread ? `Nova conversa: ${thread.title}` : "Não consegui criar uma conversa.")
      return true
    }
    if (name === "/stop" || name === "/status") {
      const thread = linkedThread(chatId)
      const active = thread ? kernel.services.use("runtime.activeRun")?.({ threadId: thread.id }) : null
      if (name === "/status") {
        await send(
          chatId,
          thread
            ? `Conversa: ${thread.title}. ${active ? "Respondendo agora." : "Nada em andamento."}`
            : "Nenhuma conversa ainda. Mande uma mensagem para começar.",
        )
        return true
      }
      const canceled = active ? (kernel.services.use("runtime.cancelRun")?.({ runId: active.id }) ?? false) : false
      if (canceled) stopTyping(chatId)
      await send(chatId, canceled ? "Parei a resposta em andamento." : "Nada em andamento.")
      return true
    }
    return false
  }

  const onMessage = async (update: TelegramUpdate, message: TelegramMessage): Promise<void> => {
    if (message.chat.type !== "private" || message.from?.is_bot) return
    if (!allowed(message.from?.id)) {
      const state = store.state(botId)
      store.saveState(botId, {
        ...state,
        lastRejected: { userId: String(message.from?.id ?? ""), name: displayName(message.from), at: Date.now() },
      })
      return
    }
    const chatId = String(message.chat.id)
    const text = message.text?.trim() ?? ""
    if (!text) {
      await send(chatId, "Por enquanto só leio mensagens de texto.")
      return
    }
    if (text.startsWith("/") && (await command(message, text.split(/\s/)[0]?.split("@")[0] ?? ""))) return
    const thread = linkedThread(chatId) ?? newThread(message)
    const api = storeApi()
    if (!thread || !api?.sendMessage) {
      await send(chatId, "Não consegui entregar a mensagem ao bot.")
      return
    }
    const response = api.sendMessage({
      threadId: thread.id,
      parentId: thread.activeLeafId,
      text,
      attachmentIds: [],
      clientNonce: `tg-${botId}-${update.update_id}`,
    })
    if (response.status >= 400) await send(chatId, "Não consegui entregar a mensagem ao bot.")
  }

  const onCallback = async (query: TelegramCallbackQuery): Promise<void> => {
    const [, id, choice] = query.data?.split(":") ?? []
    const prompt = id ? prompts.get(id) : undefined
    if (!allowed(query.from.id)) {
      await api.answerCallbackQuery({ callback_query_id: query.id, text: "Sem permissão." })
      return
    }
    if (!prompt || prompt.settled) {
      await api.answerCallbackQuery({ callback_query_id: query.id, text: "Pedido expirado." })
      return
    }
    prompt.settled = true
    const allow = choice === "y"
    const question = prompt.kind === "question"
    const answer = kernel.services.use("runtime.answerApproval")
    const result = answer
      ? await answer({
          approvalId: prompt.requestId,
          decision: !question && allow ? "approved" : "denied",
          ...(question ? { message: `User answered: ${allow ? "yes" : "no"}` } : {}),
        })
      : { success: false as const }
    kernel.services.use("notify.resolve")?.({
      requestId: prompt.requestId,
      resolution: result.success ? (allow ? "allow" : "deny") : "expired",
    })
    const outcome = !result.success
      ? "Pedido expirado."
      : question
        ? `Resposta: ${allow ? "sim" : "não"}.`
        : allow
          ? `Aprovado por ${displayName(query.from)}.`
          : `Negado por ${displayName(query.from)}.`
    await api.answerCallbackQuery({ callback_query_id: query.id, text: outcome })
    await api
      .editMessageText({ chat_id: prompt.chatId, message_id: prompt.messageId, text: `${prompt.text}\n\n${outcome}` })
      .catch(() => undefined)
  }

  const onRun = (run: Run): void => {
    if (run.botId !== botId) return
    const chatId = chatForThread(run.threadId)
    if (!chatId) return
    if (ACTIVE.includes(run.status)) {
      startTyping(chatId)
      return
    }
    stopTyping(chatId)
    if (run.status === "interrupted" || forwarded.has(run.id)) return
    forwarded.add(run.id)
    if (run.status === "canceled") {
      void safeSend(chatId, "Resposta cancelada.")
      return
    }
    if (run.status === "failed") {
      const detail = run.errorMessage ? ` ${kernel.redact(run.errorMessage).slice(0, 300)}` : ""
      void safeSend(chatId, `Não consegui concluir esta resposta.${detail}`)
      return
    }
    const path = storeApi()?.activePath({ threadId: run.threadId }) ?? []
    const reply =
      path.find((message) => message.id === run.replyMessageId) ??
      [...path].reverse().find((message) => message.role === "assistant")
    if (reply?.text.trim()) void safeSend(chatId, reply.text)
  }

  const onNotification = async (notification: NotificationRecord): Promise<void> => {
    if (notification.botId !== botId || !notification.requestId || !notification.threadId) return
    if (notification.kind !== "approval" && notification.kind !== "question") return
    const chatId = chatForThread(notification.threadId)
    if (!chatId) return
    const id = (++promptSeq).toString(36)
    const text = [notification.title, notification.body].filter(Boolean).join("\n")
    const labels = notification.kind === "approval" ? ["Aprovar", "Negar"] : ["Sim", "Não"]
    try {
      const sent = await api.sendMessage({
        chat_id: chatId,
        text: text.slice(0, 3_500),
        reply_markup: {
          inline_keyboard: [
            [
              { text: labels[0] ?? "", callback_data: `tg:${id}:y` },
              { text: labels[1] ?? "", callback_data: `tg:${id}:n` },
            ],
          ],
        },
      })
      prompts.set(id, {
        requestId: notification.requestId,
        kind: notification.kind,
        chatId,
        messageId: sent.message_id,
        text: text.slice(0, 3_500),
        settled: false,
      })
      for (const key of prompts.keys()) {
        if (prompts.size <= MAX_PENDING_PROMPTS) break
        prompts.delete(key)
      }
    } catch (error) {
      log("Falha ao enviar aprovação ao Telegram", { error: errorText(error) })
    }
  }

  const onResolved = (notification: NotificationRecord): void => {
    for (const prompt of prompts.values()) {
      if (prompt.requestId !== notification.requestId || prompt.settled) continue
      prompt.settled = true
      void api
        .editMessageText({
          chat_id: prompt.chatId,
          message_id: prompt.messageId,
          text: `${prompt.text}\n\nRespondido no touri.`,
        })
        .catch(() => undefined)
    }
  }

  const onRoutine = (routine: Routine, run: RoutineRun | null): void => {
    const { forwardRoutines, homeChatId } = config()
    if (routine.botId !== botId || !forwardRoutines || !homeChatId || !run) return
    if (run.status !== "succeeded" && run.status !== "failed") return
    if (routinesSent.has(run.id) || Date.now() - (run.finishedAt ?? 0) > ROUTINE_FRESH_MS) return
    routinesSent.add(run.id)
    const path = run.threadId ? (storeApi()?.activePath({ threadId: run.threadId }) ?? []) : []
    const reply = [...path].reverse().find((message) => message.role === "assistant" && message.text.trim())
    const body = run.status === "succeeded" ? (reply?.text ?? run.summary ?? "") : `falhou. ${run.summary ?? ""}`
    void safeSend(homeChatId, `${routine.name}: ${body}`.trim())
  }

  const onEvent = (event: UiEvent): void => {
    if (stopped) return
    if (event.type === "run.updated") onRun(event.run)
    else if (event.type === "notification.created") void onNotification(event.notification)
    else if (event.type === "notification.resolved") onResolved(event.notification)
    else if (event.type === "routine.updated") onRoutine(event.routine, event.lastRun)
  }

  const poll = async (): Promise<void> => {
    let failures = 0
    let handshake = true
    while (!stopped) {
      try {
        if (handshake) {
          onStatus({ state: "connecting", username: null, error: null })
          const me = await api.getMe(controller.signal)
          onStatus({ state: "connected", username: me.username ?? null, error: null })
          handshake = false
        }
        const updates = await api.getUpdates(
          { offset: store.state(botId).offset, timeout: pollTimeoutSec },
          controller.signal,
        )
        failures = 0
        for (const update of updates) {
          if (stopped) return
          try {
            if (update.message) await onMessage(update, update.message)
            else if (update.callback_query) await onCallback(update.callback_query)
          } catch (error) {
            log("Falha ao tratar atualização do Telegram", { error: errorText(error) })
          }
          store.saveState(botId, { ...store.state(botId), offset: update.update_id + 1 })
        }
      } catch (error) {
        if (stopped || controller.signal.aborted) return
        const unauthorized = error instanceof TelegramApiError && error.unauthorized
        onStatus({
          state: "error",
          username: null,
          error: unauthorized ? "Token inválido ou revogado." : errorText(error),
        })
        if (unauthorized) return
        const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)] ?? 60_000
        failures += 1
        handshake = true
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, wait)
          controller.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer)
              resolve()
            },
            { once: true },
          )
        })
      }
    }
  }

  const unsubscribe = kernel.subscribe(({ event }) => onEvent(event))

  return {
    start: () => {
      loop = poll()
    },
    stop: async (): Promise<void> => {
      stopped = true
      controller.abort()
      unsubscribe()
      for (const chatId of [...typing.keys()]) stopTyping(chatId)
      await loop.catch(() => undefined)
    },
  }
}

export type TelegramBridge = ReturnType<typeof createTelegramBridge>
