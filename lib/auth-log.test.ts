// E13 · T3 — `lib/auth-log.ts` (docs/design/E13-autenticacion.md §7b): nunca el email en claro.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { logAuthEvent } from "./auth-log"

describe("logAuthEvent()", () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it("escribe una línea JSON con el evento y el emailHash, nunca el email en claro", () => {
    logAuthEvent({ event: "login_ko", emailHash: "deadbeef", ip: "127.0.0.1" })

    expect(logSpy).toHaveBeenCalledTimes(1)
    const line = JSON.parse(logSpy.mock.calls[0][0] as string)
    expect(line.event).toBe("login_ko")
    expect(line.emailHash).toBe("deadbeef")
    expect(JSON.stringify(line)).not.toContain("@")
  })

  it("añade un timestamp ISO", () => {
    logAuthEvent({ event: "reset_requested", emailHash: "abc", ip: "127.0.0.1" })
    const line = JSON.parse(logSpy.mock.calls[0][0] as string)
    expect(() => new Date(line.ts).toISOString()).not.toThrow()
  })
})
