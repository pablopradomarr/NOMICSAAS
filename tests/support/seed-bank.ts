/**
 * Arnés de los e2e de la conciliación bancaria (E7 · T16).
 *
 * **Por qué existe.** El recorrido de la pantalla empieza con un extracto del
 * banco y con apuntes de la 57x que casen con él. Ninguna de las dos cosas se
 * puede dar por hecha en una base de desarrollo, y montar el escenario a mano
 * con `INSERT` sería sembrar un diario que la aplicación nunca habría aceptado
 * (sin `entryHash`, sin numeración, sin los triggers). Así que:
 *
 *  · la cuenta bancaria se crea por `createBankAccount` —con su **anclaje** y su
 *    cotejo contra el saldo contable—;
 *  · los tres apuntes de la remesa se postean por `postEntry`, **el mismo camino
 *    que la aplicación**, con su partida doble y su numeración;
 *  · el extracto Norma 43 se **genera** con el periodo `[anclaje, hoy]` para que
 *    la cadena de I-E7-6b quede cubierta sin huecos, y se escribe en disco para
 *    que el test lo suba por el formulario de verdad.
 *
 * El escenario es el del diseño: una **remesa** (tres apuntes al debe de la 57x
 * contra un solo abono del banco, grupo 1-a-N) y una **comisión de
 * mantenimiento** que existe en el banco y no en los libros —que no es
 * ignorable: se propone asiento (O-4)—.
 *
 *   npx tsx tests/support/seed-bank.ts --org <id>
 *
 * Imprime en `stdout`, en una línea:
 * `{ bankAccountId, accountCode, n43Path, remesaCents, comisionCents, anchorDate, periodEnd }`.
 * Es IDEMPOTENTE: si la cuenta y los asientos ya están, los reutiliza.
 */

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { prisma, tenantDb, tenantTransaction } from "@/lib/db"
import type { EntryDraft } from "@/lib/ledger/types"
import { createBankAccount } from "@/models/bank"
import { postEntry, todayLocalDate } from "@/models/ledger"

const BANK_CODE = "E2E-BANCO"
/** El nombre es también el del expedidor en el maestro: RC-11 lo exige. */
const BANK_NAME = "Banco de Pruebas E2E SA"
const BANK_TAX_ID = "A58818501"
const REMESA_REF = "REM000000001"
/** Los tres recibos de la remesa, en céntimos. Σ = 8 420,00 €. */
const RECIBOS = [400000, 242000, 200000]
const COMISION_CENTS = 350

const pad = (value: string, length: number): string => value.padEnd(length, " ").slice(0, length)
const num = (value: number, length: number): string => String(Math.trunc(Math.abs(value))).padStart(length, "0")
const yymmdd = (date: string): string => date.slice(2, 4) + date.slice(5, 7) + date.slice(8, 10)

/** Suma días a una fecha `YYYY-MM-DD` sin tocar zonas horarias. */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number)
  const utc = new Date(Date.UTC(y, m - 1, d + days))
  return utc.toISOString().slice(0, 10)
}

/**
 * Genera un fichero Norma 43 de 80 columnas con el saldo inicial a **cero**.
 *
 * Que la apertura sea cero no es una comodidad del test: con un saldo inicial
 * declarado que ningún apunte respalda, `E − B` arrastraría esa diferencia y el
 * cuadre saldría en FAIL sin un solo error contable. El escenario tiene que ser
 * uno que un contable reconozca.
 */
function buildN43(opts: { periodStart: string; periodEnd: string; abonoDate: string; comisionDate: string }): string {
  const abonoCents = RECIBOS.reduce((a, b) => a + b, 0)
  const closing = abonoCents - COMISION_CENTS

  const header =
    "11" +
    "0182" +
    "1234" +
    "0012345678" +
    yymmdd(opts.periodStart) +
    yymmdd(opts.periodEnd) +
    "2" +
    num(0, 14) +
    "978" +
    "1" +
    pad("BANCO DE PRUEBA E2E", 26) +
    "   "

  const movimiento = (date: string, sign: "1" | "2", cents: number, doc: string, ref1: string, ref2: string): string =>
    "22" +
    "    " +
    "1234" +
    yymmdd(date) +
    yymmdd(date) +
    "03" +
    "001" +
    sign +
    num(cents, 14) +
    pad(doc, 10) +
    pad(ref1, 12) +
    pad(ref2, 16)

  const concepto = (texto: string): string => "23" + "01" + pad(texto, 38) + pad("", 38)

  const footer =
    "33" +
    "0182" +
    "1234" +
    "0012345678" +
    num(1, 5) +
    num(COMISION_CENTS, 14) +
    num(1, 5) +
    num(abonoCents, 14) +
    "2" +
    num(closing, 14) +
    "978" +
    "    "

  const fin = "88" + "9".repeat(18) + num(7, 6) + pad("", 54)

  return [
    header,
    movimiento(opts.abonoDate, "2", abonoCents, "DOC0000001", REMESA_REF, "ABONO REMESA"),
    concepto("ABONO REMESA DE RECIBOS"),
    movimiento(opts.comisionDate, "1", COMISION_CENTS, "DOC0000002", "", "COMISION"),
    concepto("COMISION MANTENIMIENTO"),
    footer,
    fin,
    "",
  ].join("\n")
}

async function main(): Promise<void> {
  const organizationId = valueOf(process.argv, "--org")
  if (!organizationId) throw new Error("Uso: npx tsx tests/support/seed-bank.ts --org <id>")

  const membership = await prisma.membership.findFirst({ where: { organizationId, role: "ADMIN" } })
  if (!membership) throw new Error(`La organización ${organizationId} no tiene ningún ADMIN`)
  const userId = membership.userId
  const db = tenantDb(organizationId)

  const today = todayLocalDate()
  const anchorDate = addDays(today, -20)

  // La subcuenta conciliable del plan de ESTA organización: el fixture postea
  // contra cuentas de tres dígitos, la organización personal contra subcuentas.
  const cuenta = await tenantTransaction(organizationId, userId, async (tx) =>
    tx.ledgerAccount.findFirst({ where: { code: { startsWith: "572" }, isPostable: true }, orderBy: { code: "asc" } })
  )
  if (!cuenta) throw new Error("El plan de esta organización no tiene ninguna cuenta 572 postable")

  const contrapartida = await tenantTransaction(organizationId, userId, async (tx) =>
    tx.ledgerAccount.findFirst({ where: { code: { startsWith: "430" }, isPostable: true }, orderBy: { code: "asc" } })
  )
  if (!contrapartida) throw new Error("El plan de esta organización no tiene ninguna cuenta 430 postable")

  const existing = await tenantTransaction(organizationId, userId, async (tx) =>
    tx.bankAccount.findFirst({ where: { code: BANK_CODE } })
  )
  const bankAccountId =
    existing?.id ??
    (
      await createBankAccount(
        organizationId,
        {
          code: BANK_CODE,
          name: BANK_NAME,
          accountCode: cuenta.code,
          currency: "EUR",
          reconciledFromDate: anchorDate,
          // El anclaje declara el saldo del EXTRACTO ese día, que es cero: el
          // extracto que se importa arranca de cero.
          reconciledOpeningBalanceCents: 0,
          matchToleranceDays: 5,
          transitWarnDays: 90,
        },
        { userId }
      )
    ).account.id

  /**
   * **El banco, en el maestro de contrapartes.** La propuesta de asiento desde
   * el extracto pasa por `reconcile()`, y RC-11 no contabiliza un gasto sin
   * identificación del expedidor: sin esta ficha, «Proponer asiento» se bloquea
   * —correctamente— y el recorrido de la comisión no se puede probar.
   */
  await tenantTransaction(organizationId, userId, async (tx) => {
    await tx.bankAccount.updateMany({ where: { code: BANK_CODE }, data: { name: BANK_NAME } })
    const existente = await tx.counterparty.findFirst({ where: { name: BANK_NAME } })
    if (!existente) {
      await tx.counterparty.create({
        data: { organizationId, code: "E2E-BANCO", name: BANK_NAME, taxId: BANK_TAX_ID, countryCode: "ES" },
      })
    }
  })

  // Los tres recibos de la remesa: 57x al debe contra clientes al haber.
  const fiscalYear = await tenantTransaction(organizationId, userId, async (tx) =>
    tx.fiscalYear.findFirst({ where: { status: "OPEN", startDate: { lte: new Date(`${today}T00:00:00Z`) } }, orderBy: { startDate: "desc" } })
  )
  if (!fiscalYear) throw new Error("No hay ningún ejercicio abierto que contenga la fecha de hoy")

  const yaSembrados = await tenantTransaction(organizationId, userId, async (tx) =>
    tx.journalEntry.count({ where: { sourceType: "MANUAL", description: { startsWith: "Cobro recibo remesa e2e" } } })
  )

  if (yaSembrados === 0) {
    for (const [index, cents] of RECIBOS.entries()) {
      const entryDate = addDays(anchorDate, index + 1)
      const draft: EntryDraft = {
        organizationId,
        fiscalYearId: fiscalYear.id,
        entryDate,
        documentDate: entryDate,
        description: `Cobro recibo remesa e2e ${index + 1}`,
        kind: "NORMAL",
        sourceType: "MANUAL",
        taxRoundingMode: "PER_TIPO",
        lines: [
          { lineNo: 1, accountCode: cuenta.code, debitCents: cents, creditCents: 0, description: REMESA_REF },
          { lineNo: 2, accountCode: contrapartida.code, debitCents: 0, creditCents: cents, description: REMESA_REF },
        ],
      }
      const posted = await postEntry(organizationId, draft, { userId }, { refDate: today })
      if (!posted.ok) {
        throw new Error(`El recibo ${index + 1} no entra: ${posted.errors.map((e) => e.message).join(" · ")}`)
      }
    }
  }

  const n43 = buildN43({
    periodStart: anchorDate,
    periodEnd: today,
    abonoDate: addDays(anchorDate, 5),
    comisionDate: addDays(anchorDate, 6),
  })
  const directory = path.join(process.cwd(), "tests", "e2e", ".artifacts")
  await mkdir(directory, { recursive: true })
  const n43Path = path.join(directory, `extracto-e2e-${organizationId.slice(0, 8)}.n43`)
  await writeFile(n43Path, n43, "utf8")

  process.stdout.write(
    `${JSON.stringify({
      bankAccountId,
      accountCode: cuenta.code,
      n43Path,
      remesaCents: RECIBOS.reduce((a, b) => a + b, 0),
      comisionCents: COMISION_CENTS,
      anchorDate,
      periodEnd: today,
    })}\n`
  )
  void db
}

function valueOf(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
