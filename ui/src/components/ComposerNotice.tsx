import type { Bot, MachineState, Message } from "@touri/contracts"
import type { UiApi } from "../api/client"
import { localizeNotice, t } from "../i18n"
import { runErrorFor } from "../runError"
import { MachineServiceButton } from "./MachineServiceButton"

export const ComposerNotice = ({
  bot,
  latestReply,
  machine,
  active,
  loginFlowShown = false,
  api,
  onOpenPermissions,
  onOpenProviderLogin,
  onRetry,
}: {
  bot: Bot | null
  latestReply: Message | undefined
  machine: MachineState | undefined
  active: boolean
  loginFlowShown?: boolean
  api: UiApi
  onOpenPermissions?: (() => void) | undefined
  onOpenProviderLogin?: (() => void) | undefined
  onRetry: (runId: string) => Promise<void>
}) => {
  if (bot?.machine === "vm" && machine?.status === "starting")
    return (
      <aside className="composer-notice" role="status" aria-live="polite">
        <span className="run-spinner" aria-hidden="true">
          ◌
        </span>
        <span>{t("Preparing the computer…")}</span>
      </aside>
    )
  if (active) return null
  const notice =
    latestReply?.status === "failed"
      ? latestReply.parts.find((part) => part.type === "notice" && part.level === "error")
      : undefined
  const authNeeded = !loginFlowShown && notice?.type === "notice" && notice.text.startsWith("cli_auth:")
  const serviceDown =
    machine?.status !== "running" &&
    notice?.type === "notice" &&
    /^machine_service_(?:unavailable|start_failed):/.test(notice.text)
  const machineFailed = bot?.machine === "vm" && machine?.status === "error"
  if (!authNeeded && !serviceDown && !machineFailed) return null
  const provider = bot?.provider === "opencode" ? "OpenCode" : bot?.provider === "claude" ? "Claude Code" : "Codex"
  const error = latestReply ? runErrorFor(latestReply) : null
  return (
    <aside className="composer-notice" aria-label={authNeeded ? "Autenticação necessária" : "Aviso do computador"}>
      <div className="composer-notice-copy">
        <strong>{authNeeded ? `Entre no ${provider} para continuar` : "O computador precisa de atenção"}</strong>
        <p>
          {authNeeded
            ? "Conecte sua conta nas permissões deste bot para voltar a enviar mensagens."
            : error?.detail ||
              (machine?.error && localizeNotice(machine.error)) ||
              "Verifique o serviço de máquinas e tente novamente. Seus arquivos continuam salvos."}
        </p>
      </div>
      {authNeeded ? (
        <button
          type="button"
          className="button button-brand"
          aria-label={`Entrar no ${provider} nesta máquina`}
          onClick={onOpenProviderLogin ?? onOpenPermissions}
        >
          Entrar no provedor
        </button>
      ) : serviceDown || /TOURI-E800[12]/.test(machine?.errorCode ?? "") ? (
        <MachineServiceButton api={api} {...(bot ? { botId: bot.id } : {})} />
      ) : latestReply?.runId ? (
        <button type="button" className="button button-quiet" onClick={() => void onRetry(latestReply.runId ?? "")}>
          Tentar novamente
        </button>
      ) : (
        <button type="button" className="button button-quiet" onClick={onOpenPermissions}>
          Ver configurações
        </button>
      )}
    </aside>
  )
}
