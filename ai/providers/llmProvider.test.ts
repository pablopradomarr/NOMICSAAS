/**
 * E8 · T11 — La cadena de intentos y los códigos de error (G-09).
 *
 * Lo que se defiende aquí es que `attempts[]` cuente la verdad: un proveedor sin
 * credenciales **no es un intento** —no se llamó a nadie—, y un error sí lo es,
 * con un código estable y **sin el cuerpo de la respuesta**, que puede llevar
 * fragmentos del documento o de la clave (§10).
 */

import { describe, expect, it } from "vitest"

import { errorCodeOf, requestLLM } from "@/ai/providers/llmProvider"

describe("errorCodeOf", () => {
  it("prefiere el código HTTP cuando lo hay", () => {
    expect(errorCodeOf(429, "cualquier cosa")).toBe("HTTP_429")
    expect(errorCodeOf(500, "boom")).toBe("HTTP_500")
  })

  it("reconoce el modelo sin visión y el fallo de red", () => {
    expect(errorCodeOf(undefined, "image_url is not supported")).toBe("NO_VISION")
    expect(errorCodeOf(undefined, "fetch failed")).toBe("NETWORK")
  })

  it("no filtra el mensaje: lo desconocido es UNKNOWN, no el texto del error", () => {
    const code = errorCodeOf(undefined, "clave sk-secreta rechazada por el proveedor")
    expect(code).toBe("UNKNOWN")
    expect(code).not.toContain("sk-")
  })
})

describe("requestLLM — cadena de proveedores", () => {
  it("sin ningún proveedor configurado no hay intentos y el error lo dice", async () => {
    const response = await requestLLM({ providers: [] }, { prompt: "hola" })
    expect(response.attempts).toEqual([])
    expect(response.error).toMatch(/Ningún proveedor/)
    expect(response.output).toEqual({})
  })

  it("un proveedor sin credenciales se salta y NO cuenta como intento", async () => {
    const response = await requestLLM(
      {
        providers: [
          { provider: "openai", apiKey: "", model: "gpt-4o" },
          { provider: "mistral", apiKey: "k", model: "" },
          { provider: "openai_compatible", apiKey: "", model: "local", baseUrl: "" },
        ],
      },
      { prompt: "hola" }
    )
    expect(response.attempts).toEqual([])
    expect(response.error).toBeDefined()
  })
})
