import { describe, expect, it } from "vitest"

/**
 * E11 · T20 — los trece `I-E11-1…13` sobre un fixture, y las **inyecciones del
 * auditor**.
 *
 * Dos cosas se prueban aquí, y las dos son el H-1 que E9, E10 y E11 pagaron:
 *
 *  1. **El barrido muestra los trece**, siempre, con el bloque y sin él. Un
 *     invariante que desaparece de la lista es el silencio que `/audit` existe
 *     para evitar.
 *  2. **Las manipulaciones que el auditor reprodujo dan FAIL.** No se prueba que
 *     el código es igual a sí mismo: se le pone delante el estado corrupto
 *     concreto que describió el informe —la caché de `usage_runs` falseada sin
 *     tocar `source_hash`, `currencies` fuera del inventario, la restauración en
 *     `DONE_UNVERIFIED`— y se exige que lo cace.
 */

import {
  E11_INVARIANT_IDS,
  E11_SEAL_REASONS,
  checkIE111,
  checkIE112,
  checkIE113,
  checkIE114,
  checkIE115,
  checkIE116,
  checkIE117,
  checkIE118,
  checkIE119,
  checkIE1110,
  checkIE1111,
  checkIE1112,
  checkIE1113,
  isE11SealReason,
  platformSealReasons,
  runPlatformInvariants,
  type PlatformInvariantInput,
} from "@/lib/ledger/invariants-e11"

const figures = {
  members: 1,
  entries: 5,
  ocrDocs: 1,
  exports: 1,
  backups: 1,
  storageBytes: BigInt(2048),
}

/** El fixture sano: los trece en PASS (o el INFO que su contrato exige). */
function fixture(): PlatformInvariantInput {
  return {
    usage: {
      periodMonth: "2026-09",
      served: { sourceHash: "a".repeat(64), gitSha: "0".repeat(40), figures: { ...figures } },
      actual: { sourceHash: "a".repeat(64), figures: { ...figures } },
    },
    restores: [
      {
        id: "restore-1",
        status: "DONE",
        verified: true,
        checks: [
          { id: "RECUENTOS", status: "PASS" },
          { id: "NUMERACION", status: "PASS" },
          { id: "SELLOS_DERIVADOS", status: "PASS" },
          { id: "AUDIT_LOG", status: "PASS" },
          { id: "SELLOS_Y_CIERRE", status: "PASS" },
          { id: "BARRIDO_INVARIANTES", status: "PASS" },
        ],
      },
    ],
    backups: [
      {
        id: "backup-1",
        status: "DONE",
        declaredSha256: "b".repeat(64),
        recomputedSha256: "b".repeat(64),
        signatureValid: true,
        signingKeyId: "k1",
        entries: [{ path: "data/journal_entries.jsonl", declared: "c".repeat(64), actual: "c".repeat(64) }],
        full: true,
      },
    ],
    quotas: {
      hardLimits: [
        { key: "maxMembers", used: BigInt(1), limit: BigInt(3) },
        { key: "maxOcrDocsMonth", used: BigInt(1), limit: BigInt(-1) },
      ],
      softExcesses: [],
      automaticExceptions: [],
      ast: {
        callers: ["inviteMemberAction", "acceptInvitationAction"],
        expected: ["inviteMemberAction", "acceptInvitationAction"],
        postingActions: ["postEntryAction", "postFromProposal"],
      },
    },
    access: {
      organizations: [{ organizationId: "org-a", subscriptions: 1, effectiveAccess: "FULL", expectedAccess: "FULL" }],
    },
    store: {
      objects: [
        {
          id: "obj-1",
          kind: "DOCUMENT",
          sha256: "d".repeat(64),
          sizeBytes: BigInt(10),
          storeSha256: "d".repeat(64),
          storeSizeBytes: BigInt(10),
          present: true,
        },
      ],
      filesWithoutObject: [],
      billableKinds: ["DOCUMENT", "PREVIEW", "LOGO", "AVATAR"],
    },
    coverage: {
      tenantModels: ["currencies", "journal_entries"],
      inventory: ["currencies", "journal_entries"],
      tablesWithOrganizationId: ["currencies", "journal_entries", "platform_audit_logs"],
      declaredExclusions: [{ table: "platform_audit_logs", reason: "registro de plataforma, no del cliente" }],
      sealColumnsInSchema: ["journal_entries.entry_hash"],
      derivedSealColumns: ["journal_entries.entry_hash"],
      manifestTables: [
        { name: "currencies", rows: 177 },
        { name: "journal_entries", rows: 84 },
      ],
    },
    isolation: {
      entriesReferencingPlatform: [],
      documentsFromPlatformInvoice: [],
      templatesNamingPlatform: [],
      privilegedPlatformOrganizations: [],
    },
    webhook: {
      internalBilling: false,
      events: [
        {
          id: "e1",
          stripeEventId: "evt_1",
          occurredAt: "2026-09-01T00:00:00.000Z",
          statusBefore: null,
          statusAfter: "ACTIVE",
        },
        {
          id: "e2",
          stripeEventId: "evt_2",
          occurredAt: "2026-09-02T00:00:00.000Z",
          statusBefore: "ACTIVE",
          statusAfter: "PAST_DUE",
        },
      ],
    },
    seeding: {
      organizations: [
        {
          organizationId: "org-a",
          baseCurrency: "EUR",
          postablePlanAccounts: 906,
          accountMapKeys: 57,
          requiredAccountMapKeys: 57,
          fiscalYears: 1,
          overlappingFiscalYears: 0,
          seriesCodes: ["ORDINARIA", "RECTIFICATIVA"],
          reclassificationPairs: 22,
          marginLevelConfigs: 1,
          onboardingRuns: 1,
          taxRateKinds: ["IVA", "IRPF"],
          currencyCodes: ["EUR", "USD"],
          exchangeRatesAvailable: 0,
        },
      ],
    },
    retention: {
      refDate: "2026-09-15",
      backups: [{ id: "backup-1", status: "DONE", expiresAt: "2026-10-15", objectAlive: true, hasLiveRestore: false }],
      expiredPlatformInvoiceObjects: [],
    },
    cron: {
      refDate: "2026-09-15",
      cadenceHours: { retention: 24 },
      runs: [
        {
          job: "retention",
          periodKey: "2026-09-15",
          status: "DONE",
          refDate: "2026-09-15",
          startedAt: "2026-09-15T02:00:00.000Z",
        },
      ],
      occurrences: [{ id: "occ-1", period: "2026-09", postingDate: "2026-09-01" }],
    },
    platformInvoices: {
      series: [
        { id: "s1", code: "PLAT", kind: "ORDINARIA", lastNumber: 2 },
        { id: "s2", code: "PLAT-R", kind: "RECTIFICATIVA", lastNumber: 1 },
      ],
      invoices: [
        { id: "i1", seriesId: "s1", number: 1, fullNumber: "PLAT-1", operationDate: "2026-01-31", rectifiesInvoiceId: null },
        { id: "i2", seriesId: "s1", number: 2, fullNumber: "PLAT-2", operationDate: "2026-02-28", rectifiesInvoiceId: null },
        { id: "i3", seriesId: "s2", number: 1, fullNumber: "PLAT-R-1", operationDate: "2026-03-31", rectifiesInvoiceId: "i1" },
      ],
    },
  }
}

const byId = (checks: ReturnType<typeof runPlatformInvariants>) => new Map(checks.map((c) => [c.id, c] as const))

describe("E11 · T20 — el barrido muestra los TRECE", () => {
  it("con el fixture completo salen los trece, en orden y todos en PASS", () => {
    const checks = runPlatformInvariants(fixture())
    expect(checks.map((c) => c.id)).toEqual(E11_INVARIANT_IDS)
    const noPass = checks.filter((c) => c.status !== "PASS")
    expect(noPass.map((c) => `${c.id}=${c.status}: ${c.evidencia}`)).toEqual([])
  })

  it("**sin ningún bloque** salen igualmente los trece, todos INFO y diciendo QUÉ falta", () => {
    const checks = runPlatformInvariants({})
    expect(checks.map((c) => c.id)).toEqual(E11_INVARIANT_IDS)
    expect(checks.every((c) => c.status === "INFO")).toBe(true)
    // Nunca un PASS por vacuidad, y nunca un INFO mudo.
    expect(checks.every((c) => c.evidencia.startsWith("no evaluable: "))).toBe(true)
  })

  it("cada check tiene evidencia con cifras, no una frase vacía", () => {
    for (const check of runPlatformInvariants(fixture())) {
      expect(check.evidencia.length, check.id).toBeGreaterThan(20)
    }
  })
})

describe("I-E11-1 · el uso servido contra la Σ real (auditor H-7)", () => {
  it("FAIL con la caché falseada SIN tocar el sourceHash: 77/4242 frente a 1/5", () => {
    const input = fixture()
    // Exactamente la manipulación del informe: seis columnas de `usage_runs`
    // alteradas por SQL, `source_hash` intacto, `fromCache: true`.
    input.usage!.served!.figures.members = 77
    input.usage!.served!.figures.entries = 4242
    const check = checkIE111(input)
    expect(check.status).toBe("FAIL")
    expect(check.evidencia).toContain("members: servido 77 ≠ Σ real 1")
    expect(check.evidencia).toContain("entries: servido 4242 ≠ Σ real 5")
  })

  it("FAIL cuando el sourceHash servido no es el vigente", () => {
    const input = fixture()
    input.usage!.actual.sourceHash = "f".repeat(64)
    expect(checkIE111(input).status).toBe("FAIL")
  })

  it("INFO —no PASS— cuando no hay UsageRun que servir", () => {
    const input = fixture()
    input.usage!.served = null
    const check = checkIE111(input)
    expect(check.status).toBe("INFO")
    expect(check.evidencia).toContain("Σ real recontada")
  })
})

describe("I-E11-2 · restauración reproducible", () => {
  it("FAIL con DONE_UNVERIFIED (O-2)", () => {
    const input = fixture()
    input.restores = [{ ...input.restores![0], status: "DONE_UNVERIFIED", verified: false }]
    const check = checkIE112(input)
    expect(check.status).toBe("FAIL")
    expect(check.evidencia).toContain("DONE_UNVERIFIED")
  })

  it("FAIL si el documento entrega CINCO comprobaciones en vez de seis", () => {
    const input = fixture()
    input.restores = [{ ...input.restores![0], checks: input.restores![0].checks.slice(0, 5) }]
    expect(checkIE112(input).evidencia).toContain("faltan BARRIDO_INVARIANTES")
  })

  it("FAIL con DONE y verified = false: la etiqueta no puede mentir", () => {
    const input = fixture()
    input.restores = [{ ...input.restores![0], verified: false }]
    expect(checkIE112(input).status).toBe("FAIL")
  })
})

describe("I-E11-3 · manifest íntegro y firmado", () => {
  it("FAIL si el sha recomputado no es el declarado", () => {
    const input = fixture()
    input.backups = [{ ...input.backups![0], recomputedSha256: "9".repeat(64) }]
    expect(checkIE113(input).status).toBe("FAIL")
  })

  it("FAIL con la firma inválida", () => {
    const input = fixture()
    input.backups = [{ ...input.backups![0], signatureValid: false }]
    expect(checkIE113(input).evidencia).toContain("firma inválida")
  })

  it("FAIL si el sha de una entrada del ZIP no cuadra (el byte cambiado del auditor)", () => {
    const input = fixture()
    input.backups = [
      {
        ...input.backups![0],
        entries: [{ path: "data/accounts.jsonl", declared: "c".repeat(64), actual: "e".repeat(64) }],
      },
    ]
    expect(checkIE113(input).evidencia).toContain("data/accounts.jsonl")
  })

  it("INFO cuando el ZIP no estaba disponible para recomputar: no se finge un PASS", () => {
    const input = fixture()
    input.backups = [{ ...input.backups![0], recomputedSha256: null, signatureValid: null, full: false }]
    expect(checkIE113(input).status).toBe("INFO")
  })
})

describe("I-E11-4 · cuotas (a, b, c)", () => {
  it("(a) FAIL con una cuota de recurso superada", () => {
    const input = fixture()
    input.quotas!.hardLimits = [{ key: "maxMembers", used: BigInt(4), limit: BigInt(3) }]
    expect(checkIE114(input).evidencia).toContain("maxMembers: 4 sobre 3")
  })

  it("(a) `-1` es ilimitado y no es una superación", () => {
    const input = fixture()
    input.quotas!.hardLimits = [{ key: "maxOcrDocsMonth", used: BigInt(9_999), limit: BigInt(-1) }]
    expect(checkIE114(input).status).toBe("PASS")
  })

  it("(b) FAIL si la superación blanda NO tiene su excepción automática", () => {
    const input = fixture()
    input.quotas!.softExcesses = [{ key: "softMaxEntriesMonth", used: BigInt(2_001), soft: BigInt(2_000) }]
    expect(checkIE114(input).status).toBe("FAIL")
  })

  it("(b) WARN —no FAIL, y nunca bloqueo— cuando la superación blanda SÍ está registrada", () => {
    const input = fixture()
    input.quotas!.softExcesses = [{ key: "softMaxEntriesMonth", used: BigInt(2_001), soft: BigInt(2_000) }]
    input.quotas!.automaticExceptions = [{ key: "softMaxEntriesMonth", actor: "motor" }]
    const check = checkIE114(input)
    expect(check.status).toBe("WARN")
    expect(check.evidencia).toContain("Ningún hecho contable se ha rechazado")
  })

  it("(b) FAIL si la excepción la concede un OPERADOR: en E11 no existe (O-3)", () => {
    const input = fixture()
    input.quotas!.softExcesses = [{ key: "softMaxEntriesMonth", used: BigInt(2_001), soft: BigInt(2_000) }]
    input.quotas!.automaticExceptions = [{ key: "softMaxEntriesMonth", actor: "operator:abc" }]
    expect(checkIE114(input).evidencia).toContain("concedida por «operator:abc»")
  })

  it("(c) FAIL si una acción de POSTEO invoca el guardián", () => {
    const input = fixture()
    input.quotas!.ast = {
      callers: ["inviteMemberAction", "acceptInvitationAction", "postEntryAction"],
      expected: ["inviteMemberAction", "acceptInvitationAction"],
      postingActions: ["postEntryAction"],
    }
    const check = checkIE114(input)
    expect(check.status).toBe("FAIL")
    expect(check.evidencia).toContain("una acción de POSTEO invoca el guardián")
  })

  it("(c) FAIL si falta una de las acciones esperadas — el BLOQUEA 2 del revisor", () => {
    const input = fixture()
    input.quotas!.ast = {
      callers: ["inviteMemberAction"],
      expected: ["inviteMemberAction", "acceptInvitationAction", "createOrganizationAction"],
      postingActions: [],
    }
    expect(checkIE114(input).evidencia).toContain("no invocan: acceptInvitationAction, createOrganizationAction")
  })
})

describe("I-E11-5 · estado ⇔ acceso", () => {
  it("FAIL con una organización sin Subscription", () => {
    const input = fixture()
    input.access!.organizations = [
      { organizationId: "org-a", subscriptions: 0, effectiveAccess: null, expectedAccess: null },
    ]
    expect(checkIE115(input).evidencia).toContain("sin Subscription")
  })

  it("FAIL con dos suscripciones en la misma organización", () => {
    const input = fixture()
    input.access!.organizations = [
      { organizationId: "org-a", subscriptions: 2, effectiveAccess: "FULL", expectedAccess: "FULL" },
    ]
    expect(checkIE115(input).evidencia).toContain("más de una Subscription")
  })

  it("FAIL si el nivel aplicado no es el que corresponde al estado", () => {
    const input = fixture()
    input.access!.organizations = [
      { organizationId: "org-a", subscriptions: 1, effectiveAccess: "FULL", expectedAccess: "READ_ONLY" },
    ]
    expect(checkIE115(input).evidencia).toContain("aplica FULL, corresponde READ_ONLY")
  })

  it("INFO —no PASS— cuando el alcance viene vacío: acotado, nunca «toda la base»", () => {
    expect(checkIE115({ access: { organizations: [] } }).status).toBe("INFO")
  })
})

describe("I-E11-6 · sha256 = almacén", () => {
  it("FAIL si el objeto no está en el almacén", () => {
    const input = fixture()
    input.store!.objects = [{ ...input.store!.objects[0], present: false }]
    expect(checkIE116(input).evidencia).toContain("no está en el almacén")
  })

  it("FAIL si el sha256 del almacén no es el registrado", () => {
    const input = fixture()
    input.store!.objects = [{ ...input.store!.objects[0], storeSha256: "0".repeat(64) }]
    expect(checkIE116(input).status).toBe("FAIL")
  })

  it("FAIL con un File sin objeto", () => {
    const input = fixture()
    input.store!.filesWithoutObject = ["file-9"]
    expect(checkIE116(input).evidencia).toContain("File file-9 sin objeto")
  })

  it("el PASS DECLARA cuándo el sha lo publica el propio almacén (revisor PUEDE 11)", () => {
    const input = fixture()
    input.store!.objects = [{ ...input.store!.objects[0], shaFromStoreMetadata: true }]
    const check = checkIE116(input)
    expect(check.status).toBe("PASS")
    expect(check.evidencia).toContain("metadato")
  })
})

describe("I-E11-7 · cobertura del backup, FUERTE (auditor H-2)", () => {
  it("**FAIL con `currencies` fuera del inventario** — la comprobación que faltaba", () => {
    const input = fixture()
    // El estado exacto de la ronda anterior: el inventario se derivaba sólo de
    // TENANT_MODELS y `currencies` no estaba, pero SÍ lleva organization_id.
    input.coverage!.tenantModels = ["journal_entries"]
    input.coverage!.inventory = ["journal_entries"]
    input.coverage!.manifestTables = [{ name: "journal_entries", rows: 84 }]
    const check = checkIE117(input)
    expect(check.status).toBe("FAIL")
    expect(check.evidencia).toContain("currencies: lleva organization_id")
  })

  it("la dirección DÉBIL sola no basta: con el inventario derivado, pasaba siempre", () => {
    // Mismo caso, pero mirando sólo `TENANT_MODELS ⊆ inventario`: no hay fallo.
    const input = fixture()
    input.coverage!.tenantModels = ["journal_entries"]
    input.coverage!.inventory = ["journal_entries"]
    expect(input.coverage!.tenantModels.every((t) => input.coverage!.inventory.includes(t))).toBe(true)
    // …y el invariante fuerte sí lo caza.
    expect(checkIE117(input).status).toBe("FAIL")
  })

  it("una exclusión DECLARADA y justificada sí pasa, y se enseña en la evidencia", () => {
    const check = checkIE117(fixture())
    expect(check.status).toBe("PASS")
    expect(check.evidencia).toContain("platform_audit_logs")
  })

  it("FAIL con una exclusión declarada que ya no existe: una lista que se pudre miente", () => {
    const input = fixture()
    input.coverage!.declaredExclusions = [
      ...input.coverage!.declaredExclusions,
      { table: "tabla_fantasma", reason: "se fue en E9" },
    ]
    expect(checkIE117(input).evidencia).toContain("tabla_fantasma")
  })

  it("**R2-7** · FAIL con una exclusión declarada SIN motivo escrito: `tabla ()` no es una justificación", () => {
    const input = fixture()
    input.coverage!.declaredExclusions = [{ table: "platform_audit_logs", reason: "   " }]
    const check = checkIE117(input)
    expect(check.status).toBe("FAIL")
    expect(check.evidencia).toContain("SIN motivo escrito")
  })

  it("**auditor ronda 2** · FAIL si `information_schema` ve una tabla con organization_id que el inventario no", () => {
    const input = fixture()
    input.coverage!.tablesWithOrganizationIdInDatabase = [
      ...input.coverage!.tablesWithOrganizationId,
      "payment_runs",
    ]
    const check = checkIE117(input)
    expect(check.status).toBe("FAIL")
    expect(check.evidencia).toContain("payment_runs")
    expect(check.evidencia).toContain("information_schema")
  })

  it("**auditor ronda 2** · FAIL si las dos fuentes del esquema divergen en cualquier dirección", () => {
    const input = fixture()
    // La base tiene una tabla que el cliente generado no conoce.
    input.coverage!.tablesWithOrganizationIdInDatabase = [
      ...input.coverage!.tablesWithOrganizationId,
      "currencies_v2",
    ]
    expect(checkIE117(input).evidencia).toContain("el cliente generado no la conoce")
    // Y al revés: el cliente cree que existe y la base no la tiene.
    const otro = fixture()
    otro.coverage!.tablesWithOrganizationIdInDatabase = otro.coverage!.tablesWithOrganizationId.filter(
      (table) => table !== "currencies"
    )
    expect(checkIE117(otro).evidencia).toContain("information_schema no la tiene")
  })

  it("con las DOS fuentes coincidiendo, el PASS lo declara", () => {
    const input = fixture()
    input.coverage!.tablesWithOrganizationIdInDatabase = [...input.coverage!.tablesWithOrganizationId]
    const check = checkIE117(input)
    expect(check.status).toBe("PASS")
    expect(check.evidencia).toContain("las DOS fuentes coinciden")
  })

  it("sin `information_schema`, el PASS DICE que sólo se contrastó contra el cliente generado", () => {
    expect(checkIE117(fixture()).evidencia).toContain("information_schema no se ha aportado")
  })

  it("FAIL con una columna-sello del esquema fuera de derivedSealColumns()", () => {
    const input = fixture()
    input.coverage!.sealColumnsInSchema = ["journal_entries.entry_hash", "budgets.budget_hash"]
    expect(checkIE117(input).evidencia).toContain("budgets.budget_hash")
  })

  it("FAIL si una tabla del inventario no aparece en el manifest", () => {
    const input = fixture()
    input.coverage!.manifestTables = [{ name: "journal_entries", rows: 84 }]
    expect(checkIE117(input).evidencia).toContain("currencies no aparece en el manifest")
  })
})

describe("I-E11-8 · la plataforma no toca el diario (O-8)", () => {
  it("FAIL si un asiento referencia una fila de plataforma", () => {
    const input = fixture()
    input.isolation!.entriesReferencingPlatform = ["entry-7"]
    expect(checkIE118(input).status).toBe("FAIL")
  })

  it("FAIL por el camino INDIRECTO: un documento con origen en una PlatformInvoice", () => {
    const input = fixture()
    input.isolation!.documentsFromPlatformInvoice = ["tx-3"]
    expect(checkIE118(input).evidencia).toContain("tx-3")
  })
})

describe("I-E11-9 · webhook idempotente", () => {
  it("FAIL con un stripeEventId duplicado", () => {
    const input = fixture()
    input.webhook!.events = [input.webhook!.events[0], { ...input.webhook!.events[0], id: "e1-bis" }]
    expect(checkIE119(input).evidencia).toContain("duplicado")
  })

  it("FAIL con un hueco en la cadena statusBefore → statusAfter", () => {
    const input = fixture()
    input.webhook!.events[1] = { ...input.webhook!.events[1], statusBefore: "CANCELED" }
    expect(checkIE119(input).evidencia).toContain("viene de CANCELED")
  })

  it("INFO en modo INTERNO: no hay webhook que auditar (D9)", () => {
    expect(checkIE119({ webhook: { internalBilling: true, events: [] } }).evidencia).toContain("INTERNO")
  })
})

describe("I-E11-10 · la siembra, nueve piezas (O-7c)", () => {
  const sin = (patch: Record<string, unknown>) => {
    const input = fixture()
    input.seeding!.organizations = [{ ...input.seeding!.organizations[0], ...patch } as never]
    return checkIE1110(input).evidencia
  }

  it("FAIL sin la novena pieza: la Currency de su moneda base (la que rompía H-2)", () => {
    expect(sin({ currencyCodes: ["USD"] })).toContain("Currency de su baseCurrency (EUR)")
  })

  it("FAIL sin TaxRate de IRPF", () => {
    expect(sin({ taxRateKinds: ["IVA"] })).toContain("TaxRate vigente de IRPF")
  })

  it("FAIL sin la serie RECTIFICATIVA", () => {
    expect(sin({ seriesCodes: ["ORDINARIA"] })).toContain("serie RECTIFICATIVA")
  })

  it("FAIL con dos ejercicios, y con ejercicios solapados", () => {
    expect(sin({ fiscalYears: 2 })).toContain("exactamente un ejercicio (hay 2)")
    expect(sin({ overlappingFiscalYears: 1 })).toContain("solape")
  })

  it("FAIL con el mapa de cuentas incompleto", () => {
    expect(sin({ accountMapKeys: 55 })).toContain("mapa de cuentas (55/57 claves)")
  })

  it("FAIL si la moneda base no es EUR y no hay ninguna tasa accesible (RC-14)", () => {
    expect(sin({ baseCurrency: "USD", currencyCodes: ["USD"], exchangeRatesAvailable: 0 })).toContain("RC-14")
  })
})

describe("I-E11-11 · retención honrada", () => {
  it("FAIL con un objeto vivo pasado su expiresAt", () => {
    const input = fixture()
    input.retention!.backups = [
      { id: "b1", status: "DONE", expiresAt: "2026-08-01", objectAlive: true, hasLiveRestore: false },
    ]
    expect(checkIE1111(input).evidencia).toContain("caducado el 2026-08-01")
  })

  it("FAIL si se borró con un RestoreJob vivo", () => {
    const input = fixture()
    input.retention!.backups = [
      { id: "b1", status: "EXPIRED", expiresAt: "2026-08-01", objectAlive: false, hasLiveRestore: true },
    ]
    expect(checkIE1111(input).evidencia).toContain("RestoreJob vivo")
  })

  it("FAIL con una copia de NUESTRA factura caducada (O-11)", () => {
    const input = fixture()
    input.retention!.expiredPlatformInvoiceObjects = ["obj-fact"]
    expect(checkIE1111(input).evidencia).toContain("art. 165.Uno LIVA")
  })
})

describe("I-E11-12 · el reloj (O-13)", () => {
  it("FAIL con (job, periodKey) duplicado", () => {
    const input = fixture()
    input.cron!.runs = [input.cron!.runs[0], { ...input.cron!.runs[0] }]
    expect(checkIE1112(input).evidencia).toContain("duplicado")
  })

  it("FAIL si el job lleva más de dos cadencias sin ejecutarse y nada lo explica", () => {
    const input = fixture()
    input.cron!.runs = [{ ...input.cron!.runs[0], startedAt: "2026-09-01T02:00:00.000Z", status: "DONE" }]
    expect(checkIE1112(input).evidencia).toContain("más de dos cadencias")
  })

  it("un PARTIAL SÍ lo explica: no es FAIL", () => {
    const input = fixture()
    input.cron!.runs = [{ ...input.cron!.runs[0], startedAt: "2026-09-01T02:00:00.000Z", status: "PARTIAL" }]
    expect(checkIE1112(input).status).toBe("PASS")
  })

  it("FAIL con una ocurrencia fechada por el instante de EJECUCIÓN y no por su devengo", () => {
    const input = fixture()
    input.cron!.occurrences = [{ id: "occ-1", period: "2026-08", postingDate: "2026-09-15" }]
    expect(checkIE1112(input).evidencia).toContain("su periodo de devengo es 2026-08")
  })

  it("FAIL con una ocurrencia fechada en el FUTURO", () => {
    const input = fixture()
    input.cron!.refDate = "2026-09-15"
    input.cron!.occurrences = [{ id: "occ-2", period: "2026-12", postingDate: "2026-12-31" }]
    expect(checkIE1112(input).evidencia).toContain("FUTURO")
  })
})

describe("I-E11-13 · nuestra serie de facturación (espejo de I-E8-20)", () => {
  it("FAIL con un hueco en la numeración", () => {
    const input = fixture()
    input.platformInvoices!.invoices = [
      { id: "i1", seriesId: "s1", number: 1, fullNumber: "PLAT-1", operationDate: "2026-01-31", rectifiesInvoiceId: null },
      { id: "i3", seriesId: "s1", number: 3, fullNumber: "PLAT-3", operationDate: "2026-03-31", rectifiesInvoiceId: null },
    ]
    input.platformInvoices!.series = [{ id: "s1", code: "PLAT", kind: "ORDINARIA", lastNumber: 3 }]
    expect(checkIE1113(input).evidencia).toContain("huecos en 2")
  })

  it("FAIL con la fecha de operación DECRECIENTE respecto del número", () => {
    const input = fixture()
    input.platformInvoices!.invoices[1] = { ...input.platformInvoices!.invoices[1], operationDate: "2025-12-31" }
    expect(checkIE1113(input).evidencia).toContain("opera el 2025-12-31")
  })

  it("FAIL si una rectificativa no está en una serie RECTIFICATIVA", () => {
    const input = fixture()
    input.platformInvoices!.invoices[2] = { ...input.platformInvoices!.invoices[2], seriesId: "s1", number: 3 }
    input.platformInvoices!.series = [
      { id: "s1", code: "PLAT", kind: "ORDINARIA", lastNumber: 3 },
      { id: "s2", code: "PLAT-R", kind: "RECTIFICATIVA", lastNumber: 0 },
    ]
    expect(checkIE1113(input).evidencia).toContain("no es RECTIFICATIVA")
  })

  it("FAIL si rectifica una factura que no existe", () => {
    const input = fixture()
    input.platformInvoices!.invoices[2] = {
      ...input.platformInvoices!.invoices[2],
      rectifiesInvoiceId: "no-existe",
    }
    expect(checkIE1113(input).evidencia).toContain("que no existe")
  })

  it("INFO sin facturas: mismo contrato que I-E8-20 con el contador a cero", () => {
    const input = fixture()
    input.platformInvoices!.invoices = []
    expect(checkIE1113(input).status).toBe("INFO")
  })
})

describe("Motivos de sello de la plataforma", () => {
  it("el código es cerrado y `isE11SealReason` lo respeta", () => {
    for (const code of E11_SEAL_REASONS) expect(isE11SealReason(code)).toBe(true)
    expect(isE11SealReason("CUALQUIER_COSA")).toBe(false)
  })

  it("el fixture sano no aporta ningún motivo", () => {
    expect(platformSealReasons(fixture())).toEqual([])
  })

  it("la cuota blanda superada sella el periodo con motivo, y NO rechaza nada", () => {
    const input = fixture()
    input.quotas!.softExcesses = [{ key: "softMaxEntriesMonth", used: BigInt(2_001), soft: BigInt(2_000) }]
    input.quotas!.automaticExceptions = [{ key: "softMaxEntriesMonth", actor: "motor" }]
    expect(platformSealReasons(input)).toEqual(["CUOTA_DE_ASIENTOS_SUPERADA"])
    // El check que la acompaña es WARN, jamás FAIL: un asiento no se rechaza.
    expect(byId(runPlatformInvariants(input)).get("I-E11-4")!.status).toBe("WARN")
  })

  it("un DONE_UNVERIFIED sella con RESTAURACION_SIN_VERIFICAR (O-2)", () => {
    const input = fixture()
    input.restores = [{ ...input.restores![0], status: "DONE_UNVERIFIED", verified: false }]
    expect(platformSealReasons(input)).toContain("RESTAURACION_SIN_VERIFICAR")
  })

  it("una copia con la firma rota sella con COPIA_SIN_VERIFICAR", () => {
    const input = fixture()
    input.backups = [{ ...input.backups![0], signatureValid: false }]
    expect(platformSealReasons(input)).toContain("COPIA_SIN_VERIFICAR")
  })
})
