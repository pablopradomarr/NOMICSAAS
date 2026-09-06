import type { ProposalPreview } from "@/components/unsorted/types"
import { formatCents } from "@/lib/money"

/**
 * E8 · T16 — Los **avisos específicos** del documento (§6).
 *
 * Un panel de veinticinco comprobaciones es correcto y es ilegible: quien
 * revisa una factura de abogado necesita leer «esta factura debería llevar
 * retención del 15 %», no «RC-19 WARN». Esta función traduce el veredicto
 * sellado a los seis avisos que el diseño nombra, con el texto en español
 * contable y la referencia legal cuando la hay.
 *
 * **No decide nada**: lee `checks`, `warnings` y la propuesta ya normalizada.
 * Ni una cifra sale de aquí que no venga del servidor —los importes que se
 * pintan son los que `reconcile()` selló en `fieldOrigins` o los de la propia
 * propuesta.
 */

export type NoticeTone = "aviso" | "bloqueo" | "informativo"

export type DocumentNotice = {
  code: string
  tone: NoticeTone
  title: string
  body: string
  /** `true` en el aviso del ticket: la pantalla ofrece el acto auditado. */
  offerQualify?: boolean
}

type Origin = { value?: unknown }

const originValue = (preview: ProposalPreview, key: string): number | null => {
  const origin = (preview.fieldOrigins as Record<string, Origin | undefined>)[key]
  const value = origin?.value
  return typeof value === "number" ? value : null
}

const check = (preview: ProposalPreview, id: string) => preview.checks.find((c) => c.id === id)

export function documentNotices(preview: ProposalPreview): DocumentNotice[] {
  const out: DocumentNotice[] = []
  const p = preview.proposal
  const currency = p.currency

  // ── Ticket: factura simplificada, IVA no deducible por defecto (O-1, D9) ──
  if (p.docKind === "TICKET") {
    out.push(
      p.simplifiedQualified === true
        ? {
            code: "TICKET_CUALIFICADO",
            tone: "informativo",
            title: "Ticket marcado como factura simplificada cualificada",
            body:
              "Alguien ha declarado que este ticket lleva el NIF del destinatario y la cuota repercutida por separado (art. 7.2 RD 1619/2012). La cuota se deduce y el acto ha quedado en el registro de auditoría con su motivo.",
          }
        : {
            code: "TICKET_NO_CUALIFICADO",
            tone: "aviso",
            offerQualify: true,
            title: "IVA no deducible: factura simplificada",
            body:
              "Una factura simplificada no da derecho a deducir salvo que lleve el NIF y el domicilio del destinatario y la cuota repercutida por separado (art. 7.2 RD 1619/2012). El asiento lleva el importe íntegro al gasto contra la tesorería, sin línea de 472. Si el ticket cumple los requisitos, márquelo como cualificado: es un acto explícito, con motivo y auditado.",
          }
    )
  }

  // ── Retención por régimen de la contraparte (O-11, arts. 99/101/107 LIRPF) ─
  const rc19 = check(preview, "RC-19")
  if (rc19 && rc19.status !== "PASS") {
    out.push({
      code: "RETENCION",
      tone: rc19.status === "FAIL" ? "bloqueo" : "aviso",
      title: "Retención de IRPF",
      body: `${rc19.message}. La retención es obligación del pagador y la fija la ficha del tercero, no el documento: si la factura no la menciona, solicite factura rectificada. El asiento la practica igualmente contra 4751.`,
    })
  }

  // ── Rectificativa por sustitución: se contabiliza la DIFERENCIA (O-5) ──────
  if (p.rectifies?.mode === "SUSTITUCION") {
    const base = originValue(preview, "asiento.diferenciaBaseCents")
    const quota = originValue(preview, "asiento.diferenciaCuotaCents")
    const detalle =
      base === null
        ? "Se contabiliza la diferencia respecto de la factura original."
        : `Se contabiliza la diferencia respecto de la factura ${p.rectifies.documentNumber}: base ${formatCents(base, { currency })}${quota === null ? "" : ` y cuota ${formatCents(quota, { currency })}`}.`
    out.push({
      code: "RECTIFICATIVA_SUSTITUCION",
      tone: "informativo",
      title: "Rectificativa por sustitución",
      body: `${detalle} Contabilizar el importe nuevo completo duplicaría la operación (art. 15 RD 1619/2012).`,
    })
  }

  // ── ISP: sólo con las cuatro precondiciones verificables (O-4) ─────────────
  const rc22 = check(preview, "RC-22")
  if (p.docKind === "FACTURA_RECIBIDA_ISP" || (rc22 && rc22.status !== "PASS")) {
    const faltan = Array.isArray((rc22?.evidence as { faltan?: unknown } | undefined)?.faltan)
      ? ((rc22?.evidence as { faltan: string[] }).faltan ?? [])
      : []
    out.push({
      code: "ISP",
      tone: rc22?.status === "FAIL" ? "bloqueo" : "informativo",
      title: "Inversión del sujeto pasivo",
      body:
        `La autorrepercusión exige cuatro precondiciones verificables: país y NIF-IVA comprobados en VIES con su fecha, ausencia de cuota en el documento, mención legal expresa y organización inscrita en el ROI.` +
        (faltan.length > 0 ? ` Faltan: ${faltan.join(", ")}.` : ` ${rc22?.message ?? ""}`),
    })
  }

  // ── Importación ≠ ISP (O-4) ───────────────────────────────────────────────
  if (p.docKind === "FACTURA_RECIBIDA_EXTRACOM" || p.docKind === "DUA_IMPORTACION") {
    out.push({
      code: "IMPORTACION",
      tone: "informativo",
      title: "Importación: el IVA lo liquida el DUA",
      body:
        "Una compra a un tercer país no se autorrepercute: el IVA de importación se devenga y se deduce con el DUA, no con esta factura. El asiento va sin cuota (ni 472 ni 477); el DUA se contabiliza aparte.",
    })
  }

  // ── Régimen de la organización no soportado (O-21, RC-24) ─────────────────
  const rc24 = check(preview, "RC-24")
  if (rc24 && rc24.status !== "PASS") {
    out.push({
      code: "REGIMEN_NO_SOPORTADO",
      tone: "bloqueo",
      title: "Régimen de IVA no soportado por la contabilización automática",
      body: `${rc24.message}. Con criterio de caja el IVA se devenga y se deduce con el cobro y con el pago, así que los asientos automáticos saldrían en el trimestre equivocado. El soporte de RECC/REDEME llega en E9; hasta entonces, asiento manual.`,
    })
  }

  // ── Anticipo de cliente sin cobro: sin 477 (O-23, art. 75.Dos LIVA) ───────
  const rc25 = check(preview, "RC-25")
  if (rc25 && rc25.status !== "PASS") {
    out.push({
      code: "ANTICIPO_SIN_COBRO",
      tone: "aviso",
      title: "Anticipo de cliente sin cobro registrado",
      body: `${rc25.message}. El IVA de un anticipo devenga con el cobro (art. 75.Dos LIVA): el asiento es 430 contra 438, sin línea de 477. El repercutido aparecerá cuando se registre el cobro.`,
    })
  }

  // ── Deducibilidad pendiente de decisión humana (O-17) ─────────────────────
  if (preview.warnings.includes("DEDUCIBILIDAD_PENDIENTE")) {
    out.push({
      code: "DEDUCIBILIDAD_PENDIENTE",
      tone: "aviso",
      title: "Deducibilidad pendiente de decisión",
      body:
        "El gasto pertenece a una categoría del art. 96 LIVA o del art. 95.Tres.2ª (hostelería, atenciones a clientes, combustible de turismos…): la deducibilidad es criterio humano y el producto no la adivina. Decídala en la línea y confirme individualmente; el documento no entra en el lote.",
    })
  }

  // ── Contraparte sin régimen configurado ──────────────────────────────────
  if (preview.warnings.includes("CONTRAPARTE_SIN_REGIMEN")) {
    out.push({
      code: "CONTRAPARTE_SIN_REGIMEN",
      tone: "aviso",
      title: "El tercero no está calificado fiscalmente",
      body:
        "Este NIF no tiene ficha con régimen de retención, país ni recargo de equivalencia. Sin ella el motor asume que no hay retención. Complétela en Configuración → Terceros y fiscalidad.",
    })
  }

  // ── Caducidad del derecho a deducir (RC-18, art. 99.Cinco LIVA) ──────────
  const rc18 = check(preview, "RC-18")
  if (rc18 && rc18.status !== "PASS") {
    out.push({
      code: "IVA_CADUCADO",
      tone: "aviso",
      title: "Derecho a deducir caducado",
      body: `${rc18.message}. Pasados cuatro años desde el devengo la cuota no se deduce: va como mayor coste del gasto.`,
    })
  }

  return out
}
