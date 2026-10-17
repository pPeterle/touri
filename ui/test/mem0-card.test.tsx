import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { createMockApi } from "../src/api/mock"
import { Mem0Card } from "../src/components/Mem0Card"
import { t } from "../src/i18n"

const saves = (api: ReturnType<typeof createMockApi>) => api.calls.filter((call) => call.route === "PUT /bots/:id/mem0")

describe("Mem0 card", () => {
  it("starts off, saves the key write-only and never shows it again", async () => {
    const api = createMockApi()
    render(<Mem0Card api={api} botId="bot-mark" />)
    expect(await screen.findByText("Memória Mem0")).toBeVisible()
    expect(screen.getByText("Desligado")).toBeVisible()
    expect(screen.getByRole("switch", { name: "Ativar Mem0 para este bot" })).not.toBeChecked()
    expect(screen.getByText(/vai para o Mem0 Cloud/)).toBeVisible()
    fireEvent.click(screen.getByRole("switch", { name: "Ativar Mem0 para este bot" }))
    fireEvent.change(screen.getByLabelText("Chave da API"), { target: { value: "m0-ui-key" } })
    fireEvent.click(screen.getByRole("button", { name: "Salvar Mem0" }))
    expect(await screen.findByText("Salvo.")).toBeVisible()
    expect(saves(api)[0]).toMatchObject({
      pathValues: { id: "bot-mark" },
      input: { enabled: true, mode: "platform", scope: "user", apiKey: "m0-ui-key" },
    })
    expect(screen.getByText("Ligado")).toBeVisible()
    expect(screen.getByLabelText("Chave da API")).toHaveValue("")
    expect(screen.getByText(/Chave salva/)).toBeVisible()
    expect(document.body.textContent).not.toContain("m0-ui-key")
    fireEvent.click(screen.getByRole("button", { name: "Remover chave" }))
    await waitFor(() => expect(saves(api)[1]).toMatchObject({ input: { apiKey: null } }))
  })

  it("asks for a server URL in self-hosted mode, explains where data goes and tests the connection", async () => {
    const api = createMockApi()
    render(<Mem0Card api={api} botId="bot-mark" />)
    fireEvent.change(await screen.findByLabelText("Onde ficam as memórias"), { target: { value: "server" } })
    fireEvent.change(screen.getByLabelText("URL do servidor"), { target: { value: "http://localhost:8888" } })
    expect(screen.getByText(/vai para o seu servidor Mem0/)).toBeVisible()
    expect(screen.getByText(/não é usado em grupos, rotinas nem pedidos delegados/)).toBeVisible()
    fireEvent.change(screen.getByLabelText("Alcance"), { target: { value: "bot" } })
    fireEvent.click(screen.getByRole("button", { name: "Salvar Mem0" }))
    await waitFor(() =>
      expect(saves(api)[0]).toMatchObject({ input: { mode: "server", url: "http://localhost:8888", scope: "bot" } }),
    )
    expect(saves(api)[0]?.input).not.toHaveProperty("apiKey")
    fireEvent.click(screen.getByRole("button", { name: "Testar conexão" }))
    expect(await screen.findByText("Conexão funcionando.")).toBeVisible()
    expect(t("Memória Mem0", {}, "en")).toBe("Mem0 memory")
  })
})
