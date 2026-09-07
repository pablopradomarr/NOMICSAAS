/**
 * E7 · T23 — De un movimiento del extracto a una **propuesta de asiento**
 * (`docs/design/E7-auditoria.md` §4.4, O-4).
 *
 * Módulo **PURO**. Aquí no se decide ninguna cuenta: la cuenta llega ya
 * resuelta desde `OrganizationAccountMap`. Deducirla del texto del movimiento
 * sería auto-punteo por patrón, que es **E12 y con ADR**.
 *
 * La propuesta entra por el **mismo camino** que el documental —`reconcile()` →
 * `previewFromProposal()` → confirmación humana → `postFromProposal()`—. Un
 * segundo camino de posteo sería una segunda verdad (§3.7).
 *
 * ## Por qué `docKind: "TICKET"`
 *
 * Un cargo bancario sin factura es un gasto **pagado en el acto contra
 * tesorería**, que es exactamente lo que el `TICKET` modela en E8: su
 * contrapartida es la clave de pago (`BANCO_DEFAULT`), no un 400/410 que nadie
 * va a pagar después. `EXTRACTO_BANCARIO` **no** vale: `TEMPLATE_FOR_DOC` lo
 * declara `null` a propósito, porque un extracto entero no es un documento
 * contabilizable.
 *
 * ## IVA (art. 20.Uno.18º LIVA)
 *
 * Los servicios financieros están **exentos**: comisión de mantenimiento, de
 * transferencia o de descubierto son `626 / 572` **por el total y sin cuota**.
 * La operación se anota con el tipo EXENTO del art. 20 y **cuota cero** —que no
 * es lo mismo que «sin impuesto»: la base de una exenta arrastra prorrata y va
 * al libro registro—. Quien lleve IVA —gestión de cobro de efectos (letra h),
 * cajas de seguridad, custodia— llega con factura y entra por el camino
 * documental; el bloqueo vive en el borde (`models/bank-proposal.ts`).
 */

import type { ExtractionProposal } from "@/lib/extraction/types"
import type { Cents, LocalDate } from "@/lib/ledger/types"

/** Las seis claves del mapa en juego (m1). Tres nacen en E7; 626/668/768 ya existían. */
export const PROPOSAL_ACCOUNT_KEYS = [
  "COMISIONES_BANCARIAS",
  "INTERESES_DEUDAS",
  "OTROS_GASTOS_FINANCIEROS",
  "INTERESES_DESCUENTO_EFECTOS",
  "DIFERENCIA_CAMBIO_NEGATIVA",
  "DIFERENCIA_CAMBIO_POSITIVA",
] as const

export type ProposalAccountKey = (typeof PROPOSAL_ACCOUNT_KEYS)[number]

/** Las cinco de gasto. `DIFERENCIA_CAMBIO_POSITIVA` (768) es de ingreso. */
export const EXPENSE_PROPOSAL_KEYS: readonly ProposalAccountKey[] = [
  "COMISIONES_BANCARIAS",
  "INTERESES_DEUDAS",
  "OTROS_GASTOS_FINANCIEROS",
  "INTERESES_DESCUENTO_EFECTOS",
  "DIFERENCIA_CAMBIO_NEGATIVA",
]

export type StatementLineForProposal = {
  id: string
  /** Con signo: negativo = cargo. La fecha que manda es la de OPERACIÓN (O-6). */
  amountCents: Cents
  operationDate: LocalDate
  description: string
  currency: string
  counterpartyName?: string | null
}

export type ProposalFromLineInput = {
  line: StatementLineForProposal
  /** Cuenta ya resuelta desde el mapa de la organización. Nunca del texto. */
  accountCode: string
  accountKey: ProposalAccountKey
  /**
   * **Código del tipo EXENTO del art. 20** vigente en la organización. La
   * operación se anota con base y **cuota cero**, no «sin impuestos»: un
   * servicio financiero exento SÍ va al libro registro de facturas recibidas
   * como operación exenta, y su base es la que arrastra la prorrata. Sin este
   * código, la propuesta no se emite: inventarlo sería sacar fiscalidad del
   * código.
   */
  exemptTaxRateCode: string
  /** La contraparte —el banco— tal como está en el maestro. */
  counterparty: { name: string | null; taxId: string | null; id?: string | null }
  /** Texto del usuario; si falta, el concepto del banco. */
  description?: string
  /**
   * sha256 de la **forma canónica de la línea de extracto**. Es el «documento»
   * de esta propuesta: no hay PDF, hay un apunte que el banco declaró y cuya
   * huella ya está sellada en `bank_statement_lines.sha256` (§2.4).
   */
  lineSha256: string
}

export type ProposalFromLineError =
  | { code: "AMOUNT_ZERO"; message: string }
  | { code: "INCOME_NOT_SUPPORTED"; message: string }

/**
 * Construye la propuesta. **No postea, no lee y no consulta el reloj**: la fecha
 * es la de operación del movimiento y el importe, el suyo en valor absoluto.
 */
export function proposalFromStatementLine(
  input: ProposalFromLineInput
): { ok: true; proposal: ExtractionProposal } | { ok: false; error: ProposalFromLineError } {
  const { line } = input
  if (line.amountCents === 0) {
    return {
      ok: false,
      error: {
        code: "AMOUNT_ZERO",
        message: "Un apunte de 0,00 € no genera asiento: nace IGNORED con IMPORTE_CERO y no altera ningún cuadre",
      },
    }
  }
  if (line.amountCents > 0) {
    return {
      ok: false,
      error: {
        code: "INCOME_NOT_SUPPORTED",
        message:
          "E7 propone asiento para un CARGO del banco (una comisión, un interés) que nadie contabilizó. " +
          "Un abono sin apunte no se resuelve inventando un ingreso: si es una diferencia de cambio, su reconocimiento en 768/668 " +
          "es E9 —E7 la mide y avisa (I-E7-12)—; si es un cobro, entra por su documento",
      },
    }
  }

  const amount = Math.abs(line.amountCents)
  const description = (input.description ?? line.description).slice(0, 255)

  return {
    ok: true,
    proposal: {
      version: 1,
      docKind: "TICKET",
      documentNumber: null,
      counterparty: {
        name: input.counterparty.name ?? line.counterpartyName ?? null,
        taxId: input.counterparty.taxId,
        ...(input.counterparty.id ? { id: input.counterparty.id } : {}),
      },
      // Las cuatro fechas son la de OPERACIÓN: el banco no expide factura, y
      // cortar por fecha valor movería el gasto a través del cierre (O-6).
      documentDate: line.operationDate,
      accrualDate: line.operationDate,
      receptionDate: line.operationDate,
      operationDate: line.operationDate,
      currency: line.currency.toUpperCase(),
      lines: [
        {
          kind: "OPERACION",
          baseCents: amount,
          // **Exento del art. 20.Uno.18º**: tipo EXENTO del art. 20 y cuota
          // cero. No es «sin impuesto»: es una operación exenta, y como tal se
          // anota.
          taxRateCode: input.exemptTaxRateCode,
          accountCode: input.accountCode,
          accountCodeOrigin: "usuario",
          description,
          deductibility: "NONE",
        },
      ],
      taxes: [{ taxRateCode: input.exemptTaxRateCode, baseCents: amount, quotaCents: 0, operationKey: "GENERAL" }],
      // El ticket se paga en el acto contra tesorería: la contrapartida es la
      // subcuenta 57x de ESTA cuenta bancaria (la resuelve el borde).
      paymentKey: "BANCO_DEFAULT",
      totalCents: amount,
      description,
    },
  }
}
