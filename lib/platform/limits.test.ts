import { describe, expect, it } from "vitest"
import {
  READ_ONLY_MESSAGE_ES,
  SOFT_WARNING_BPS,
  backupConsumesQuota,
  checkLimit,
  checkSoftEntries,
  isHardAt,
  type LimitUsage,
  type PlanLimits,
} from "./limits"

const FREE: PlanLimits = {
  maxMembers: 2,
  maxOcrDocsMonth: 20,
  maxStorageBytes: BigInt(1000),
  maxExportsMonth: 3,
  maxBackupsMonth: 1,
  maxOrganizations: 1,
  softMaxEntriesMonth: 100,
  graceDays: 0,
  backupRetentionDays: 7,
}

const ILIMITADO: PlanLimits = {
  ...FREE,
  maxMembers: -1,
  maxOcrDocsMonth: -1,
  maxStorageBytes: BigInt(-1),
  maxExportsMonth: -1,
  maxBackupsMonth: -1,
  maxOrganizations: -1,
  softMaxEntriesMonth: -1,
}

const sinUso: LimitUsage = {
  maxMembers: BigInt(0),
  maxOcrDocsMonth: BigInt(0),
  maxStorageBytes: BigInt(0),
  maxExportsMonth: BigInt(0),
  maxBackupsMonth: BigInt(0),
  maxOrganizations: BigInt(0),
  softMaxEntriesMonth: BigInt(0),
}

describe("checkLimit — cuotas de recurso", () => {
  it("el caso vacío: sin uso y con cuota, pasa", () => {
    expect(checkLimit("maxMembers", sinUso, FREE, BigInt(1), "FULL")).toEqual({ ok: true })
  })

  it("mira el uso DESPUÉS del delta: la pregunta es si seguirá por debajo", () => {
    const usage = { ...sinUso, maxMembers: BigInt(2) }
    const verdict = checkLimit("maxMembers", usage, FREE, BigInt(1), "FULL")
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.key).toBe("maxMembers")
      expect(verdict.current).toBe(BigInt(2))
      expect(verdict.limit).toBe(BigInt(2))
      expect(verdict.message).toContain("miembros de la organización")
    }
  })

  it("justo en el límite pasa; uno más, no", () => {
    expect(checkLimit("maxExportsMonth", { ...sinUso, maxExportsMonth: BigInt(2) }, FREE, BigInt(1), "FULL").ok).toBe(true)
    expect(checkLimit("maxExportsMonth", { ...sinUso, maxExportsMonth: BigInt(3) }, FREE, BigInt(1), "FULL").ok).toBe(false)
  })

  it("`-1` es ILIMITADO y se resuelve antes de mirar el uso", () => {
    const enorme = { ...sinUso, maxStorageBytes: BigInt("999999999999") }
    expect(checkLimit("maxStorageBytes", enorme, ILIMITADO, BigInt(1), "FULL")).toEqual({ ok: true })
  })

  it("un delta negativo es un bug de quien llama, no un descuento de cuota", () => {
    expect(() => checkLimit("maxMembers", sinUso, FREE, BigInt(-1), "FULL")).toThrow()
  })

  it("el mensaje de almacenamiento se lee en unidades humanas y NO amenaza con perder los libros", () => {
    const verdict = checkLimit("maxStorageBytes", { ...sinUso, maxStorageBytes: BigInt(900) }, FREE, BigInt(200), "FULL")
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.message).toContain("almacenamiento")
      expect(verdict.message).toContain("las exportaciones siguen disponibles")
    }
  })
})

describe("O-16 — `maxStorageBytes` es dura en FULL y blanda fuera", () => {
  it("lo declara `isHardAt`, y sólo para esa clave", () => {
    expect(isHardAt("maxStorageBytes", "FULL")).toBe(true)
    expect(isHardAt("maxStorageBytes", "READ_ONLY")).toBe(false)
    expect(isHardAt("maxOcrDocsMonth", "READ_ONLY")).toBe(true)
  })

  it("en mora, superarla NO bloquea: avisa y deja subir el justificante", () => {
    const verdict = checkLimit("maxStorageBytes", { ...sinUso, maxStorageBytes: BigInt(990) }, FREE, BigInt(100), "READ_ONLY")
    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(verdict.warn?.code).toBe("CUOTA_DE_ALMACEN_SUPERADA_EN_MORA")
      expect(verdict.warn?.current).toBe(BigInt(1090))
    }
  })

  it("en FULL, la misma subida se rechaza: ahí la cuota es legítima", () => {
    expect(checkLimit("maxStorageBytes", { ...sinUso, maxStorageBytes: BigInt(990) }, FREE, BigInt(100), "FULL").ok).toBe(false)
  })

  it("avisa ya al 80 % cuando el acceso no es pleno, antes de que sea un problema", () => {
    const verdict = checkLimit("maxStorageBytes", { ...sinUso, maxStorageBytes: BigInt(800) }, FREE, BigInt(0), "READ_ONLY")
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.warn?.usedBps).toBeGreaterThanOrEqual(SOFT_WARNING_BPS)
  })
})

describe("O-3 — la cuota de asientos es BLANDA y nunca rechaza", () => {
  it("por debajo del 80 % no dice nada", () => {
    expect(checkSoftEntries(BigInt(50), FREE)).toEqual({ warn: null, blocksAccessory: false })
  })

  it("al 80 % avisa, y no bloquea nada", () => {
    const result = checkSoftEntries(BigInt(79), FREE)
    expect(result.warn?.code).toBe("CUOTA_DE_ASIENTOS_SUPERADA")
    expect(result.blocksAccessory).toBe(false)
  })

  it("superada, sigue sin rechazar el asiento: sólo bloquea lo ACCESORIO", () => {
    const result = checkSoftEntries(BigInt(100), FREE)
    expect(result.warn).not.toBeNull()
    expect(result.blocksAccessory).toBe(true)
  })

  it("con `softMaxEntriesMonth = -1` no hay ni aviso", () => {
    expect(checkSoftEntries(BigInt(10_000), ILIMITADO)).toEqual({ warn: null, blocksAccessory: false })
  })
})

describe("O-4 — portabilidad sin cuota", () => {
  it("el backup de salida no consume nunca, ni con acceso pleno", () => {
    expect(backupConsumesQuota("EXIT", "FULL")).toBe(false)
    expect(backupConsumesQuota("EXIT", "READ_ONLY")).toBe(false)
  })

  it("el programado tampoco: no lo pide el cliente", () => {
    expect(backupConsumesQuota("SCHEDULED", "FULL")).toBe(false)
  })

  it("el manual consume SÓLO con acceso pleno: un FREE en mora puede llevarse sus libros", () => {
    expect(backupConsumesQuota("MANUAL", "FULL")).toBe(true)
    expect(backupConsumesQuota("MANUAL", "READ_ONLY")).toBe(false)
    expect(backupConsumesQuota("MANUAL", "BLOCKED")).toBe(false)
  })
})

describe("el mensaje de mora", () => {
  it("dice en español y sin eufemismo que la llevanza sigue siendo del cliente", () => {
    expect(READ_ONLY_MESSAGE_ES).toContain("la llevanza sigue siendo")
    expect(READ_ONLY_MESSAGE_ES).toContain("exportar")
    expect(READ_ONLY_MESSAGE_ES).toContain("subir justificantes")
  })
})
