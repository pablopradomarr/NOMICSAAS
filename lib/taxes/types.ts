/**
 * E2 · T5 — Tipos impositivos (`TaxRate`). Módulo PURO: la fecha de referencia
 * entra siempre por parámetro (C-7: un asiento de 2024 no coge el tipo de 2026).
 */

import type { TaxAppliesTo, TaxKind } from "@/prisma/client"

export type { TaxAppliesTo, TaxKind }

/** Fila de `tax_rates` tal y como la ven las funciones puras. */
export type TaxRateRow = {
  id: string
  code: string
  name: string
  kind: TaxKind
  /** Puntos básicos: 21 % = 2100, 5,2 % = 520, 1,75 % = 175 (E-1). */
  rateBps: number
  appliesTo: TaxAppliesTo
  /** Cuenta del lado VENTA (477 repercutido / 4751 retención practicada). */
  accountCode: string
  /** Cuenta del lado COMPRA (472 soportado / 473 retención soportada). */
  counterAccountCode: string | null
  /** RECARGO → el `TaxRate` de IVA al que acompaña. */
  linkedTaxRateId: string | null
  validFrom: Date
  validTo: Date | null
  isActive: boolean
  isSystem: boolean
}

export type TaxRateInput = Omit<TaxRateRow, "id" | "isActive" | "isSystem"> & {
  id?: string
  isActive?: boolean
  isSystem?: boolean
}

/** Fila del catálogo inicial: el enlace del recargo va por CÓDIGO, no por id. */
export type TaxRateSeed = Omit<TaxRateRow, "id" | "linkedTaxRateId"> & {
  linkedCode: string | null
}

export const TAX_SIDES = ["SALE", "PURCHASE"] as const
export type TaxSide = (typeof TAX_SIDES)[number]

export const MAX_RATE_BPS = 10000
