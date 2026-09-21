/**
 * E12 · ronda 2 — **la puerta del sello del job de CI, en negativo**.
 *
 * H-4 quedó PARCIAL porque la comprobación era vacua: con tres FAIL de sustrato
 * permanentes, `sello === "VALIDADO…" || fallos.length > 0` nunca evaluaba el
 * sello. El criterio nuevo recorre las RAZONES, y este fichero es su mitad
 * negativa: si alguien lo vuelve a debilitar, aquí se ve.
 *
 * El fichero vive en `tests/support/` y **lo ejecuta `npm run test`**
 * (`vitest.config.ts`): la lección de BLOQUEA-2 de la ronda 1 fue exactamente
 * un test de este tipo que no ejecutaba nadie.
 */

import { describe, expect, it } from "vitest"

import {
  FAIL_DEL_SUSTRATO,
  failesNoDeclarados,
  motivosNoExplicadosPorElSustrato,
  type RazonDeSello,
} from "./fail-del-sustrato"

const declarados = Object.keys(FAIL_DEL_SUSTRATO)

const razonInvariantes = (ids: readonly string[]): RazonDeSello => ({
  kind: "INVARIANTE",
  message: `invariantes en FAIL: ${ids.join(", ")}`,
})

describe("FAIL_DEL_SUSTRATO — la lista es cerrada y cada entrada trae su motivo", () => {
  it("todo motivo es una frase, no una etiqueta", () => {
    expect(declarados.length).toBeGreaterThan(0)
    for (const [id, motivo] of Object.entries(FAIL_DEL_SUSTRATO)) {
      expect(motivo.length, `${id} no explica por qué es del sustrato`).toBeGreaterThan(40)
    }
  })

  it("un FAIL fuera de la lista se nombra", () => {
    expect(failesNoDeclarados([...declarados, "I-E3-7"])).toEqual(["I-E3-7"])
    expect(failesNoDeclarados(declarados)).toEqual([])
  })
})

describe("motivosNoExplicadosPorElSustrato — el criterio del sello (H-4, ronda 2)", () => {
  it("sello sin razones ⇒ nada que explicar", () => {
    expect(motivosNoExplicadosPorElSustrato([])).toEqual([])
  })

  it("el sello rojo SÓLO por los FAIL declarados está explicado", () => {
    expect(motivosNoExplicadosPorElSustrato([razonInvariantes(declarados)])).toEqual([])
  })

  it("un solo FAIL no declarado entre los declarados rompe la explicación", () => {
    const fuera = motivosNoExplicadosPorElSustrato([razonInvariantes([...declarados, "I-E3-7"])])
    expect(fuera).toHaveLength(1)
    expect(fuera[0]).toContain("I-E3-7")
    // …y no arrastra a los que sí están declarados.
    for (const id of declarados) expect(fuera[0]).not.toContain(id)
  })

  /**
   * El corazón de H-4: con la comprobación vieja, **cualquiera** de estas
   * razones pasaba en verde sólo porque además hubiera un FAIL declarado.
   */
  it.each([
    ["AVISO", "3 aviso(s) por encima del umbral (0): I-E4-2, I-E4-3, I-E5-1"],
    ["CONFIGURACION", "revisión forzada por configuración de la organización"],
    ["ENTORNO", "ENTORNO · primer run tras cambiar el motor (aaaaaaa → bbbbbbb)"],
    ["ENTORNO", "EXCEPCION_DE_OPERADOR_VIGENTE · hay una excepción de operador viva"],
    ["DOCUMENTO", "DOCUMENTO_ALTERADO · los bytes de un documento no son los que vio su extracción"],
    ["CIERRE", "CIERRE_SIN_REGULARIZAR · el ejercicio no se ha regularizado"],
    ["PLATAFORMA", "COPIA_NO_VERIFICADA · la última restauración no está verificada"],
  ])("una razón %s junto a los FAIL declarados NO está explicada y pone el job en rojo", (kind, message) => {
    const razones: RazonDeSello[] = [razonInvariantes(declarados), { kind, message }]
    const fuera = motivosNoExplicadosPorElSustrato(razones)
    expect(fuera).toEqual([`${kind} · ${message}`])
  })

  it("el criterio NO es «hay algún FAIL»: con FAIL declarados y una razón ajena, sale rojo", () => {
    const razones: RazonDeSello[] = [
      razonInvariantes(declarados),
      { kind: "CONFIGURACION", message: "revisión forzada por configuración de la organización" },
    ]
    // La comprobación vieja: `fallos.length > 0` ⇒ verde. La nueva: rojo.
    expect(declarados.length > 0).toBe(true)
    expect(motivosNoExplicadosPorElSustrato(razones).length).toBeGreaterThan(0)
  })
})
