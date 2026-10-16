import type { MessagePart } from "@touri/contracts"
import { pathLeaf } from "../platform"
import { type MascotState, mascotLabel } from "./mascotState"
import { approvalMatchesTool, toolLeaf, toolPresentation, toolStatus } from "./toolPresentation"

/** Keep the visible request and activity current while the server acknowledges a local answer. */
export const withApprovalAnswers = (
  parts: MessagePart[],
  answers: Record<string, "approved" | "denied">,
): MessagePart[] => {
  const answered = parts.map((part) =>
    part.type === "approval" && part.decision === "pending" && answers[part.approvalId]
      ? { ...part, decision: answers[part.approvalId] ?? part.decision }
      : part,
  )
  return answered.map((part) =>
    (part.type === "tool_call" || part.type === "command" || part.type === "file_change") &&
    answered.some(
      (approval) =>
        approval.type === "approval" && approval.decision === "denied" && approvalMatchesTool(approval, part),
    ) &&
    toolStatus(part) === "running"
      ? { ...part, resolution: "canceled" }
      : part,
  )
}

export const activityLabelFor = (state: MascotState, parts: readonly MessagePart[]): string => {
  if (state === "waiting-approval") return mascotLabel[state]
  if (state === "typing") return "Escrevendo…"
  if (state !== "working-tool") return state === "thinking" ? "Pensando…" : mascotLabel[state]
  const tool = [...parts]
    .reverse()
    .find(
      (part) =>
        (part.type === "tool_call" || part.type === "command" || part.type === "file_change") &&
        toolStatus(part) === "running" &&
        !parts.some(
          (approval) =>
            approval.type === "approval" &&
            ["denied", "expired"].includes(approval.decision) &&
            approvalMatchesTool(approval, part),
        ),
    )
  if (!tool || (tool.type !== "tool_call" && tool.type !== "command" && tool.type !== "file_change")) return "Pensando…"
  const presentation = toolPresentation(tool)
  if (presentation.kind === "terminal") return "Executando no terminal"
  if (presentation.kind === "browser") return "Usando o navegador"
  if (presentation.kind === "computer") return "Usando o computador"
  if (presentation.kind === "files") {
    const path = presentation.filePaths[0]
    const name = path ? pathLeaf(path) : undefined
    const read = tool.type === "tool_call" && toolLeaf(tool.tool).toLowerCase() === "read"
    return name ? `${read ? "Lendo" : "Alterando"} ${name}` : read ? "Lendo arquivo" : "Alterando arquivos"
  }
  return `Usando ${presentation.name}`
}
