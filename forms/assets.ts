/**
 * E9 · T15 — Validación de entrada del inmovilizado (§5.2).
 *
 * Tres reglas del experto viven en estos schemas y no en la pantalla:
 * el método **LINEAL** es el único que el motor resuelve (D2.1, los otros tres
 * se declaran y se rechazan), la revisión es **prospectiva** y exige motivo
 * (NRV 22ª), y la baja o la venta **nunca** llevan `430` como contrapartida
 * (O-24: `543` para el crédito por venta de inmovilizado, `253` a largo).
 */

import { localDateSchema, uuidSchema } from "@/forms/ledger"
import { z } from "zod"

const codeSchema = z.string().trim().min(1, "El código es obligatorio").max(32)
const nameSchema = z.string().trim().min(1, "El nombre es obligatorio").max(160)
const accountSchema = z.string().trim().min(1, "Falta la cuenta").max(12)
const centsSchema = z.number().int("Los importes van en céntimos enteros")

export const depreciationMethodSchema = z.enum(["LINEAL", "SUMA_DIGITOS", "PORCENTAJE_CONSTANTE", "UNIDADES_PRODUCCION"])

export const createAssetSchema = z
  .object({
    code: codeSchema,
    name: nameSchema,
    assetAccountCode: accountSchema,
    accumulatedAccountCode: accountSchema,
    expenseAccountCode: accountSchema,
    acquisitionDate: localDateSchema,
    /** NRV 2ª.1 y 3ª: **puesta en condiciones de funcionamiento**, no la factura. */
    inServiceDate: localDateSchema,
    acquisitionCostCents: centsSchema.positive("El coste de adquisición tiene que ser positivo"),
    residualValueCents: centsSchema.min(0, "El valor residual no puede ser negativo").default(0),
    method: depreciationMethodSchema.default("LINEAL"),
    usefulLifeMonths: z.number().int().positive("La vida útil va en meses y tiene que ser positiva").max(1200),
    isCapitalGood: z.boolean().nullish(),
    acquisitionProrrataBps: z.number().int().min(0).max(10_000).nullish(),
    projectId: uuidSchema.nullish(),
    costCenterId: uuidSchema.nullish(),
    entryId: uuidSchema.nullish(),
    transactionId: uuidSchema.nullish(),
    fileId: uuidSchema.nullish(),
  })
  .refine((v) => v.method === "LINEAL", {
    message: "El motor sólo resuelve el método LINEAL (D2.1): los otros tres se declaran pero se rechazan",
    path: ["method"],
  })
  .refine((v) => v.inServiceDate >= v.acquisitionDate, {
    message: "La puesta en condiciones de funcionamiento no puede ser anterior a la adquisición",
    path: ["inServiceDate"],
  })
  .refine((v) => v.residualValueCents < v.acquisitionCostCents, {
    message: "El valor residual tiene que ser menor que el coste: si no, no hay base amortizable",
    path: ["residualValueCents"],
  })
  .refine((v) => !(v.projectId && v.costCenterId), {
    message: "Un activo se imputa a proyecto O a centro de coste, nunca a los dos",
    path: ["costCenterId"],
  })
export type CreateAssetFormInput = z.infer<typeof createAssetSchema>

/**
 * **R-AM-5.** Revisión **prospectiva**: no toca el pasado y no genera asiento de
 * ajuste. `effectiveFrom` no puede ser anterior al último periodo contabilizado
 * —eso lo comprueba el modelo, que es quien sabe cuál es— y el motivo es
 * obligatorio porque una vida útil nueva sin explicación es una cifra sin origen.
 */
export const reviseAssetSchema = z
  .object({
    fixedAssetId: uuidSchema,
    effectiveFrom: localDateSchema,
    newUsefulLifeMonths: z.number().int().positive().max(1200).nullish(),
    newResidualValueCents: centsSchema.min(0).nullish(),
    addedCostCents: centsSchema.nullish(),
    reason: z.string().trim().min(10, "La revisión exige un motivo de al menos 10 caracteres").max(512),
  })
  .refine((v) => v.newUsefulLifeMonths != null || v.newResidualValueCents != null || v.addedCostCents != null, {
    message: "Una revisión que no cambia vida útil, residual ni coste no es una revisión",
    path: ["newUsefulLifeMonths"],
  })
export type ReviseAssetFormInput = z.infer<typeof reviseAssetSchema>

/** **T-33** (O-24): baja sin contrapartida de cobro; el VNC se lleva a `671`. */
export const disposeAssetSchema = z.object({
  fixedAssetId: uuidSchema,
  disposalDate: localDateSchema,
  reason: z.string().trim().min(10, "La baja exige un motivo de al menos 10 caracteres").max(512),
  lossAccountCode: accountSchema.nullish(),
})
export type DisposeAssetFormInput = z.infer<typeof disposeAssetSchema>

/**
 * **T-34** (O-24). La contrapartida es `543` (crédito a corto por enajenación de
 * inmovilizado) o `253` a largo, **nunca `430`**: un cliente comercial recoge
 * ventas de la actividad, y colar ahí la venta de una máquina falsea la cifra de
 * negocios y el periodo medio de cobro.
 */
export const sellAssetSchema = z
  .object({
    fixedAssetId: uuidSchema,
    disposalDate: localDateSchema,
    salePriceCents: centsSchema.min(0, "El precio de venta no puede ser negativo"),
    receivableAccountCode: accountSchema.default("543"),
    taxRateCode: z.string().trim().max(32).nullish(),
    counterpartyId: uuidSchema.nullish(),
    reason: z.string().trim().min(10, "La venta exige un motivo de al menos 10 caracteres").max(512),
  })
  .refine((v) => !v.receivableAccountCode.startsWith("430"), {
    message: "La contrapartida de la venta de inmovilizado es 543 o 253, nunca 430 (O-24)",
    path: ["receivableAccountCode"],
  })
export type SellAssetFormInput = z.infer<typeof sellAssetSchema>

/** Vista previa de la dotación del periodo: no postea nada. */
export const previewDepreciationSchema = z.object({
  fixedAssetId: uuidSchema,
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "El periodo tiene el formato AAAA-MM"),
})
export type PreviewDepreciationFormInput = z.infer<typeof previewDepreciationSchema>

export const listAssetsSchema = z.object({
  status: z.enum(["EN_USO", "TOTALMENTE_AMORTIZADO", "BAJA", "VENDIDO"]).nullish(),
  cutoff: localDateSchema.nullish(),
  assetId: uuidSchema.nullish(),
})
export type ListAssetsFormInput = z.infer<typeof listAssetsSchema>
