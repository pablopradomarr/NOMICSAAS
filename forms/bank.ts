/**
 * E7 · T11 — Validación de entrada de la conciliación bancaria (`zod`).
 *
 * Lo que aquí se rechaza no llega a `models/bank.ts`; lo que pasa, se vuelve a
 * comprobar en el modelo y una tercera vez en la base. No es redundancia: la
 * primera capa da el mensaje, la segunda protege al modelo cuando lo llama otro
 * camino y la tercera protege al dato de un `UPDATE` por SQL (C4).
 */

import { z } from "zod"

import { localDateSchema } from "@/forms/reports"

/** Sólo 572/573/574/575 y sus subcuentas (O-7). El CHECK de la base repite. */
export const reconcilableAccountCodeSchema = z
  .string()
  .trim()
  .regex(/^(572|573|574|575)\d*$/, "Sólo se concilian las cuentas 572, 573, 574 y 575 (o subcuentas suyas): la caja no tiene extracto")
  .max(12)

export const csvMappingSchema = z.object({
  delimiter: z.string().min(1).max(1),
  decimal: z.enum([",", "."]),
  dateFormat: z.string().min(6).max(10),
  centuryWindow: z.number().int().min(0).max(99).optional(),
  skipRows: z.number().int().min(0).max(50).optional(),
  signMode: z.enum(["SIGNED", "DEBIT_CREDIT"]),
  columns: z.object({
    operationDate: z.number().int().min(0),
    valueDate: z.number().int().min(0).optional(),
    amount: z.number().int().min(0),
    sign: z.number().int().min(0).optional(),
    description: z.number().int().min(0),
    reference1: z.number().int().min(0).optional(),
    reference2: z.number().int().min(0).optional(),
    currency: z.number().int().min(0).optional(),
    balance: z.number().int().min(0).optional(),
    counterpartyName: z.number().int().min(0).optional(),
  }),
})

const anchor = {
  /** **El anclaje (O-1).** Van juntos o no van: sin los dos, I-E7-1 es INFO. */
  reconciledFromDate: localDateSchema.nullish(),
  reconciledOpeningBalanceCents: z.number().int().nullish(),
}

export const createBankAccountSchema = z
  .object({
    code: z.string().trim().min(1).max(24),
    name: z.string().trim().min(1).max(200),
    accountCode: reconcilableAccountCodeSchema,
    currency: z.string().trim().length(3).toUpperCase().default("EUR"),
    iban: z.string().trim().max(34).nullish(),
    bic: z.string().trim().max(11).nullish(),
    matchToleranceDays: z.number().int().min(0).max(60).default(3),
    transitWarnDays: z.number().int().min(1).max(3650).default(90),
    csvMapping: csvMappingSchema.nullish(),
    ...anchor,
  })
  .refine((v) => (v.reconciledFromDate ?? null) === null === ((v.reconciledOpeningBalanceCents ?? null) === null), {
    message: "El anclaje son las dos cosas: la fecha desde la que la cuenta está conciliada y el saldo del extracto ese día",
    path: ["reconciledOpeningBalanceCents"],
  })

export const updateBankAccountSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  iban: z.string().trim().max(34).nullish(),
  bic: z.string().trim().max(11).nullish(),
  matchToleranceDays: z.number().int().min(0).max(60).optional(),
  transitWarnDays: z.number().int().min(1).max(3650).optional(),
  csvMapping: csvMappingSchema.nullish(),
  isActive: z.boolean().optional(),
  reconciledFromDate: localDateSchema.nullish(),
  reconciledOpeningBalanceCents: z.number().int().nullish(),
  /** Mover el anclaje exige motivo: es una decisión de gobierno. */
  reason: z.string().trim().min(10).optional(),
})

export const importStatementSchema = z.object({
  bankAccountId: z.string().uuid(),
  format: z.enum(["CSV", "N43"]),
  fileName: z.string().trim().min(1).max(255),
})

export const createMatchGroupSchema = z
  .object({
    bankAccountId: z.string().uuid(),
    statementLineIds: z.array(z.string().uuid()).min(1).max(500),
    journalLineIds: z.array(z.string().uuid()).min(1).max(500),
    note: z.string().trim().max(500).nullish(),
  })
  .refine((v) => new Set(v.statementLineIds).size === v.statementLineIds.length, {
    message: "Una misma línea de extracto no puede entrar dos veces en el grupo",
    path: ["statementLineIds"],
  })
  .refine((v) => new Set(v.journalLineIds).size === v.journalLineIds.length, {
    message: "Un mismo apunte no puede entrar dos veces en el grupo",
    path: ["journalLineIds"],
  })

export const unmatchGroupSchema = z.object({
  groupId: z.string().uuid(),
  reason: z.string().trim().min(10, "Desconciliar exige un motivo de al menos 10 caracteres"),
})

/** Vocabulario CERRADO (O-4): fuera de estos cuatro, nada es ignorable. */
export const ignoreReasonSchema = z.enum([
  "ERROR_BANCO_REVERSADO",
  "NO_ES_NUESTRA_CUENTA",
  "YA_CONTABILIZADO_EN_OTRA_CUENTA",
  "IMPORTE_CERO",
])

export const ignoreLineSchema = z
  .object({
    id: z.string().uuid(),
    reason: ignoreReasonSchema,
    evidenceId: z.string().uuid().nullish(),
  })
  .refine(
    (v) =>
      (v.reason !== "ERROR_BANCO_REVERSADO" && v.reason !== "YA_CONTABILIZADO_EN_OTRA_CUENTA") ||
      (v.evidenceId ?? null) !== null,
    {
      message:
        "`ERROR_BANCO_REVERSADO` exige la línea de extracto que lo revierte y `YA_CONTABILIZADO_EN_OTRA_CUENTA` el apunte concreto",
      path: ["evidenceId"],
    }
  )

export const acceptSuggestionsSchema = z.object({
  bankAccountId: z.string().uuid(),
  /** Ids ELEGIDOS explícitamente: nunca «acepta todas» (R2). */
  statementLineIds: z.array(z.string().uuid()).min(1).max(200),
  cutoff: localDateSchema.optional(),
})

export const bankPanelSchema = z.object({
  bankAccountId: z.string().uuid(),
  cutoff: localDateSchema.optional(),
})

/** Las seis claves del mapa que puede usar una propuesta desde el extracto (T23). */
export const proposalAccountKeySchema = z.enum([
  "COMISIONES_BANCARIAS",
  "INTERESES_DEUDAS",
  "OTROS_GASTOS_FINANCIEROS",
  "INTERESES_DESCUENTO_EFECTOS",
  "DIFERENCIA_CAMBIO_NEGATIVA",
  "DIFERENCIA_CAMBIO_POSITIVA",
])

const proposeEntryFromLineBase = z
  .object({
    statementLineId: z.string().uuid(),
    accountKey: proposalAccountKeySchema,
    description: z.string().trim().max(255).optional(),
    /**
     * **Destino analítico** (E7 · T16). Una comisión bancaria es una 626, y las
     * cuentas 6/7 llevan destino obligatorio: sin él la propuesta se bloquea con
     * `ANALYTIC_DEST_MISSING`. Es **exactamente uno** —proyecto o centro de
     * coste—, la misma regla que el resto del diario (R-A1 de E4).
     */
    projectId: z.string().uuid().nullish(),
    costCenterId: z.string().uuid().nullish(),
  })

/** Un destino y sólo uno, como en cualquier otra línea 6/7 del diario. */
const unSoloDestino = {
  check: (v: { projectId?: string | null; costCenterId?: string | null }): boolean =>
    !((v.projectId ?? null) !== null && (v.costCenterId ?? null) !== null),
  message: "El destino analítico es uno solo: o proyecto o centro de coste, nunca los dos",
  path: ["costCenterId"] as const,
}

export const proposeEntryFromLineSchema = proposeEntryFromLineBase.refine(unSoloDestino.check, {
  message: unSoloDestino.message,
  path: [...unSoloDestino.path],
})

export const confirmEntryFromLineSchema = proposeEntryFromLineBase
  .extend({
    /** Idempotencia de formulario: el doble clic no contabiliza dos veces. */
    idempotencyKey: z.string().trim().min(8).max(120).optional(),
  })
  .refine(unSoloDestino.check, { message: unSoloDestino.message, path: [...unSoloDestino.path] })
