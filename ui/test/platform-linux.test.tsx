import { render } from "@testing-library/react"
import { expect, test, vi } from "vitest"
import { MachineFields } from "../src/components/MachineFields"

vi.mock("../src/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/platform")>()),
  hostComputerSupported: false,
}))

test("Linux VM settings retain guest login and hide unsupported host control", () => {
  const { container } = render(
    <MachineFields
      values={{ machine: "vm", machineIdleMinutes: 10, vmProviderLogin: false, hostComputerUse: false }}
      provider="codex"
      capability={{ available: true, provider: "podman", reason: null }}
      onChange={vi.fn()}
    />,
  )
  expect(container.querySelector("#machine-host-control")).toBeNull()
  expect(container.querySelector("#machine-provider-login")).not.toBeNull()
  expect(container.querySelector('option[value="vm"]')).not.toBeDisabled()
})
