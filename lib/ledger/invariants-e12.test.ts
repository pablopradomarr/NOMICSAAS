/**
 * E12 · T12 — tests de `lib/ledger/invariants-e12.ts` (ADR-0020 D3–D6).
 *
 * Cubre los criterios de aceptación **41** (motivo y confirmación en el
 * servidor), **44** (excepción viva ⇒ el periodo no se firma), **45** (caduca
 * sola a las 24 h) y la parte pura del **43** (el diario intacto).
 *
 * Ningún test importa el módulo para calcular lo esperado: los literales están
 * escritos a mano (regla 7 de §7.3 del diseño).
 */

import { describe, expect, it } from "vitest"
import {
  E12_SEAL_REASONS,
  E12_SEAL_REASON_TEXT,
  FORBIDDEN_OPERATOR_TABLES,
  MAX_EXCEPTION_HOURS,
  OPERATOR_ACTIONS,
  checkIE125,
  confirmsName,
  isE12SealReason,
  isLive,
  isOperatorAction,
  liveExceptions,
  operatorSealReasons,
  runOperatorInvariants,
  validateReason,
  type OperatorAuditRef,
  type OperatorBlock,
  type OperatorExceptionRef,
} from "@/lib/ledger/invariants-e12"
import { seal } from "@/lib/ledger/invariants"

const REF = "2026-10-01T12:00:00.000Z"
const MOTIVO = "El bloqueo de septiembre se puso por error al importar el extracto"

const excepcion = (over: Partial<OperatorExceptionRef> = {}): OperatorExceptionRef => ({
  id: "e-1",
  kind: "UNBLOCK_PERIOD_LOCK",
  targetKind: "PERIOD_LOCK",
  targetId: "11111111-1111-1111-1111-111111111111",
  targetRef: null,
  reason: MOTIVO,
  requestedBy: "pablo@cfonomic.com",
  createdAt: "2026-10-01T10:00:00.000Z",
  expiresAt: "2026-10-02T10:00:00.000Z",
  revokedAt: null,
  ...over,
})

const linea = (over: Partial<OperatorAuditRef> = {}): OperatorAuditRef => ({
  id: "a-1",
  action: "admin.unblock",
  actor: "pablo@cfonomic.com",
  organizationId: "org-1",
  at: "2026-10-01T10:00:00.000Z",
  reason: MOTIVO,
  confirmedName: "Acme S.L.",
  ...over,
})

const bloque = (over: Partial<OperatorBlock> = {}): OperatorBlock => ({
  exceptions: [excepcion()],
  auditLines: [linea()],
  forbiddenWrites: FORBIDDEN_OPERATOR_TABLES.map((table) => ({ table, rows: 0 })),
  refDate: REF,
  ...over,
})

describe("E12 · el motivo de sello (ADR-0020 D6)", () => {
  it("es UNO y se llama EXCEPCION_DE_OPERADOR_VIGENTE", () => {
    expect(E12_SEAL_REASONS).toEqual(["EXCEPCION_DE_OPERADOR_VIGENTE"])
    expect(isE12SealReason("EXCEPCION_DE_OPERADOR_VIGENTE")).toBe(true)
    expect(isE12SealReason("EXCEPCION_DE_OPERADOR")).toBe(false)
  })

  it("tiene texto declarado para el código", () => {
    for (const code of E12_SEAL_REASONS) {
      expect(E12_SEAL_REASON_TEXT[code].length).toBeGreaterThan(20)
    }
  })

  it("las cuatro acciones de operador son exactamente cuatro (D1: no hay una quinta)", () => {
    expect(OPERATOR_ACTIONS).toEqual([
      "admin.reset_org",
      "admin.unblock",
      "admin.plan_changed",
      "admin.purge_retention",
    ])
    expect(isOperatorAction("admin.borrar_diario")).toBe(false)
  })

  it("las seis tablas prohibidas son las de D2", () => {
    expect([...FORBIDDEN_OPERATOR_TABLES].sort()).toEqual([
      "audit_logs",
      "closing_runs",
      "extraction_runs",
      "invariant_runs",
      "journal_entries",
      "journal_lines",
    ])
  })
})

describe("E12 · vigencia y caducidad (D5, criterio 45)", () => {
  it("una excepción dentro de su ventana está viva", () => {
    expect(isLive(excepcion(), REF)).toBe(true)
  })

  it("en el instante EXACTO de caducidad la puerta ya está cerrada", () => {
    const e = excepcion({ expiresAt: REF })
    expect(isLive(e, REF)).toBe(false)
  })

  it("caduca sola: un milisegundo después ya no está viva, sin que nadie haga nada", () => {
    const e = excepcion({ expiresAt: "2026-10-01T12:00:00.000Z" })
    expect(isLive(e, "2026-10-01T11:59:59.999Z")).toBe(true)
    expect(isLive(e, "2026-10-01T12:00:00.001Z")).toBe(false)
  })

  it("una excepción revocada deja de estar viva aunque no haya caducado", () => {
    expect(isLive(excepcion({ revokedAt: "2026-10-01T11:00:00.000Z" }), REF)).toBe(false)
  })

  it("una revocación FUTURA no adelanta el cierre de la puerta", () => {
    expect(isLive(excepcion({ revokedAt: "2026-10-01T13:00:00.000Z" }), REF)).toBe(true)
  })

  it("`liveExceptions` ordena por caducidad más próxima y es estable", () => {
    const a = excepcion({ id: "b", expiresAt: "2026-10-02T09:00:00.000Z" })
    const b = excepcion({ id: "a", expiresAt: "2026-10-02T08:00:00.000Z" })
    expect(liveExceptions([a, b], REF).map((e) => e.id)).toEqual(["a", "b"])
  })

  it("caso vacío: sin excepciones no hay vivas y no hay motivo", () => {
    expect(liveExceptions([], REF)).toEqual([])
    expect(operatorSealReasons({ operator: bloque({ exceptions: [] }) })).toEqual([])
  })

  it("el techo declarado son 24 h", () => {
    expect(MAX_EXCEPTION_HOURS).toBe(24)
  })
})

describe("E12 · el motivo obligatorio (D3, criterio 41)", () => {
  it("acepta un motivo de verdad", () => {
    expect(validateReason(MOTIVO)).toEqual({ ok: true })
  })

  it("rechaza la cadena vacía y los espacios", () => {
    expect(validateReason("").ok).toBe(false)
    expect(validateReason("        ").ok).toBe(false)
  })

  it("rechaza menos de 20 caracteres", () => {
    expect(validateReason("bloqueo mal puesto").ok).toBe(false)
    expect(validateReason("bloqueo mal puesto x").ok).toBe(true)
  })

  it("rechaza los genéricos de la lista negra aunque lleguen a 20 caracteres por relleno", () => {
    for (const generico of ["test", "arreglo", ".", "n/a", "..................."]) {
      expect(validateReason(generico).ok, generico).toBe(false)
    }
  })

  it("rechaza una palabra repetida hasta alcanzar la longitud", () => {
    expect(validateReason("arreglo arreglo arreglo").ok).toBe(false)
  })

  it("no se deja engañar por acentos ni mayúsculas en la lista negra", () => {
    expect(validateReason("   TEST   ").ok).toBe(false)
    expect(validateReason("Árreglo").ok).toBe(false)
  })
})

describe("E12 · la confirmación por nombre (D4, criterio 41)", () => {
  it("acepta el nombre exacto, con espacios de borde", () => {
    expect(confirmsName("  Acme S.L. ", "Acme S.L.")).toBe(true)
  })

  it("rechaza un nombre parecido: la comparación NO es laxa", () => {
    expect(confirmsName("acme s.l.", "Acme S.L.")).toBe(false)
    expect(confirmsName("Acme", "Acme S.L.")).toBe(false)
    expect(confirmsName("Acme S.L. 2", "Acme S.L.")).toBe(false)
  })

  it("una organización sin nombre no se puede confirmar con la cadena vacía", () => {
    expect(confirmsName("", "")).toBe(false)
  })
})

describe("I-E12-5 · escrituras de operador acotadas", () => {
  it("sin bloque sale INFO diciendo qué falta, jamás PASS", () => {
    const [c] = runOperatorInvariants({})
    expect(c.id).toBe("I-E12-5")
    expect(c.status).toBe("INFO")
    expect(c.evidencia).toContain("no evaluable")
  })

  it("con todo en regla, PASS, y nombra que hay una excepción viva", () => {
    const c = checkIE125({ operator: bloque() })
    expect(c.status).toBe("PASS")
    expect(c.evidencia).toContain("EXCEPCION_DE_OPERADOR_VIGENTE")
  })

  it("sin recuento de escrituras prohibidas NO da PASS: da INFO (nunca un PASS sin comprobar)", () => {
    const b = bloque()
    delete (b as { forbiddenWrites?: unknown }).forbiddenWrites
    expect(checkIE125({ operator: b }).status).toBe("INFO")
  })

  it("FAIL si una escritura de operador alcanzó el diario (D2)", () => {
    const c = checkIE125({
      operator: bloque({
        forbiddenWrites: [
          { table: "journal_lines", rows: 3 },
          { table: "journal_entries", rows: 0 },
        ],
      }),
    })
    expect(c.status).toBe("FAIL")
    expect(c.evidencia).toContain("journal_lines")
    expect(c.evidencia).toContain("ADR-0020 D2")
  })

  it("FAIL si una línea admin.* no tiene motivo válido", () => {
    const c = checkIE125({ operator: bloque({ auditLines: [linea({ reason: "arreglo" })] }) })
    expect(c.status).toBe("FAIL")
    expect(c.evidencia).toContain("motivo inválido")
  })

  it("FAIL si una línea admin.* contra una organización no lleva confirmación por nombre", () => {
    const c = checkIE125({ operator: bloque({ auditLines: [linea({ confirmedName: null })] }) })
    expect(c.status).toBe("FAIL")
    expect(c.evidencia).toContain("sin confirmación por nombre")
  })

  it("FAIL si aparece una quinta acción admin.* fuera de las cuatro de D1", () => {
    const c = checkIE125({ operator: bloque({ auditLines: [linea({ action: "admin.borrar_diario" })] }) })
    expect(c.status).toBe("FAIL")
    expect(c.evidencia).toContain("fuera de las cuatro")
  })

  it("FAIL si una excepción dura más de 24 h", () => {
    const c = checkIE125({
      operator: bloque({
        exceptions: [excepcion({ expiresAt: "2026-10-03T10:00:00.000Z" })],
      }),
    })
    expect(c.status).toBe("FAIL")
    expect(c.evidencia).toContain("por encima del techo de 24 h")
  })

  it("FAIL si una excepción no tiene su línea `admin.unblock` en el registro", () => {
    const c = checkIE125({ operator: bloque({ auditLines: [] }) })
    expect(c.status).toBe("FAIL")
    expect(c.evidencia).toContain("no tiene su línea «admin.unblock»")
  })

  it("caso vacío: organización sin excepciones ni escrituras ⇒ PASS sin ruido", () => {
    const c = checkIE125({ operator: bloque({ exceptions: [], auditLines: [] }) })
    expect(c.status).toBe("PASS")
    expect(c.evidencia).not.toContain("EXCEPCION_DE_OPERADOR_VIGENTE")
  })
})

describe("D6 · toda excepción viva mueve el sello (criterio 44)", () => {
  const validacion = { run_id: "r", generado_en: REF, checks: [] as never[] } as never

  it("sin excepciones vivas el periodo se firma VALIDADO AUTOMÁTICAMENTE", () => {
    const s = seal(validacion, { gitSha: "abc1234", operatorReasons: [] })
    expect(s.sello).toBe("VALIDADO AUTOMÁTICAMENTE")
  })

  it("con una excepción viva NO se puede firmar automáticamente, y el motivo se nombra", () => {
    const reasons = operatorSealReasons({ operator: bloque() })
    expect(reasons).toEqual(["EXCEPCION_DE_OPERADOR_VIGENTE"])

    const s = seal(validacion, { gitSha: "abc1234", operatorReasons: reasons })
    expect(s.sello).toBe("REQUIERE REVISIÓN")
    expect(s.razones).toHaveLength(1)
    expect(s.razones[0]!.code).toBe("EXCEPCION_DE_OPERADOR_VIGENTE")
    // Naturaleza ENTORNO: no cambia una cifra, cambia lo que se puede afirmar.
    expect(s.razones[0]!.kind).toBe("ENTORNO")
    expect(s.motivos[0]).toContain("EXCEPCION_DE_OPERADOR_VIGENTE")
  })

  it("cuando la excepción caduca, el sello vuelve solo (criterio 45)", () => {
    const b = bloque({ exceptions: [excepcion({ expiresAt: "2026-10-01T11:00:00.000Z" })] })
    expect(operatorSealReasons({ operator: b })).toEqual([])
    expect(seal(validacion, { gitSha: "abc1234", operatorReasons: [] }).sello).toBe("VALIDADO AUTOMÁTICAMENTE")
  })

  it("una excepción MAL registrada (FAIL de I-E12-5) sigue moviendo el sello por su cuenta", () => {
    // El motivo se compone de los DATOS, no de los checks (lección H-4 de E7).
    const b = bloque({ auditLines: [] })
    expect(checkIE125({ operator: b }).status).toBe("FAIL")
    expect(operatorSealReasons({ operator: b })).toEqual(["EXCEPCION_DE_OPERADOR_VIGENTE"])
  })
})
