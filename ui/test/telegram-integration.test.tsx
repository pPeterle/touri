import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { TelegramIntegration } from "@touri/contracts"
import { describe, expect, it, vi } from "vitest"
import type { UiApi } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { TelegramIntegrationCard } from "../src/components/TelegramIntegrationCard"
import { t } from "../src/i18n"

const TOKEN = "123456789:AAExampleTokenForTouriTests_123456"

describe("Telegram integration card", () => {
  it("starts off, saves the token write-only and enables the bridge only on request", async () => {
    const api = createMockApi()
    const botId = api.getState().bots[0]?.id ?? ""
    render(<TelegramIntegrationCard api={api} botId={botId} />)
    expect(await screen.findByRole("checkbox", { name: "Ativar Telegram" })).not.toBeChecked()
    expect(screen.getByRole("status")).toHaveTextContent("Desligado")
    fireEvent.change(screen.getByLabelText("Token do bot"), { target: { value: TOKEN } })
    fireEvent.click(screen.getByRole("button", { name: "Salvar token" }))
    await waitFor(() => expect(screen.getByLabelText("Token do bot")).toHaveValue(""))
    expect(screen.getByLabelText("Token do bot")).toHaveAttribute("placeholder", "Token salvo")
    expect(screen.getByRole("status")).toHaveTextContent("Desligado")
    fireEvent.click(screen.getByRole("checkbox", { name: "Ativar Telegram" }))
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Conectado como @touri_mock_bot"))
    fireEvent.change(screen.getByLabelText("IDs de usuário permitidos"), { target: { value: "42, 77" } })
    fireEvent.click(screen.getByRole("button", { name: "Salvar Telegram" }))
    await waitFor(() =>
      expect(api.calls.at(-1)).toMatchObject({
        route: "PUT /bots/:id/integrations/telegram",
        input: { allowedUserIds: ["42", "77"], homeChatId: null, forwardRoutines: false },
      }),
    )
    const tokenWrites = api.calls.filter(
      (call) => call.route === "PUT /bots/:id/integrations/telegram" && "token" in (call.input as object),
    )
    expect(tokenWrites).toHaveLength(1)
    expect(t("Ativar Telegram", {}, "en")).toBe("Enable Telegram")
  })

  it("offers to allow the last refused sender in one click", async () => {
    const telegram: TelegramIntegration = {
      config: { enabled: true, allowedUserIds: [], homeChatId: null, forwardRoutines: false },
      tokenSaved: true,
      status: { state: "connected", username: "touri_bot", error: null },
      lastRejected: { userId: "77", name: "Ana", at: 1 },
    }
    const request = vi.fn(async (route: string, input: unknown) => {
      if (route === "PUT /bots/:id/integrations/telegram")
        return {
          telegram: { ...telegram, config: { ...telegram.config, ...(input as object) } },
        }
      return { telegram }
    })
    const api = { request, subscribe: () => () => undefined, isMock: true } as unknown as UiApi
    render(<TelegramIntegrationCard api={api} botId="bot-1" />)
    expect(await screen.findByText("Pedido de Ana (ID 77)")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Permitir" }))
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith(
        "PUT /bots/:id/integrations/telegram",
        { allowedUserIds: ["77"] },
        { id: "bot-1" },
      ),
    )
    await waitFor(() => expect(screen.queryByText("Pedido de Ana (ID 77)")).toBeNull())
  })
})
