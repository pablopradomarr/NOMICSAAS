#!/usr/bin/env python3
"""
E8 - Generador del fixture de EXTRACCION esperada (`extraccion-esperada.json`).

    python3 docs/design/fixtures/build_extraccion_esperada.py [--check]

Sella los QUINCE casos comprometidos en `docs/design/E8-documentos-asientos.md` §5.3
(los trece de la validacion contable mas los dos que la re-validacion §R2.3 exige para
probar O-23 y O-25). Para cada caso escribe, en un unico fichero:

  1. la PROPUESTA normalizada tal como la leeria el LLM y la dejaria `reconcile()`
     (docKind, las cuatro fechas, contraparte con pais/NIF/regimen, lineas con `kind`,
     base, tipo, cuota leida, retencion, descuentos, suplidos, moneda, total leido,
     paginas analizadas de las totales, `rectifies`/modo);
  2. el RESULTADO ESPERADO DE `reconcile()`: RC-01..RC-25 en PASS/WARN/FAIL con su
     evidencia, la confianza de cada campo en los CUATRO niveles, `quotaDeviationsCents`,
     el estado global y si el documento es elegible para el lote;
  3. el ASIENTO ESPERADO de `postFromProposal()`: plantilla, lineas con cuenta y
     debe/haber en centimos, dimension analitica, bloques de pasivo, IVA deducible /
     no deducible / ISP / importacion, retencion por regimen de la contraparte, divisa
     con tasa persistida y reparto Hamilton del residuo.

Ademas: los casos NEGATIVOS como variantes declarativas sobre un caso base
(`casosNegativos`), y las identidades de IVA I-E8-15a / 15b / 15c verificadas caso a
caso, por periodo de IVA y en global.

Python puro y determinista: sin `lib/`, sin TypeScript, sin Prisma, sin BD, sin red y
sin reloj. Con `--check` no escribe: reconstruye, compara byte a byte con el fichero en
disco y falla si difiere.

NO TOCA `tests/fixtures/*` ni codigo de producto.

Convenciones (las mismas que sella el JSON en `convenciones`)
------------------------------------------------------------
* Todo en CENTIMOS ENTEROS. Ni un float en el resultado.
* Signos: `debitCents` y `creditCents` son magnitudes >= 0 y una de las dos es 0. Un
  abono no lleva signo negativo: invierte el lado. Sigma debe == Sigma haber, tolerancia 0.
* Cuota de IVA e IRPF: HALF-UP sobre la magnitud (`applyBps` de `lib/taxes/bps.ts`,
  R-IVA-2: la convencion de la AEAT no es el redondeo del banquero).
* Conversion de divisa: HALF-EVEN (`convertWithRateMicro` de `lib/money.ts`, NRV 11a).
  Las dos conviven a proposito y por eso se declaran por separado.
* Reparto de un residuo entre varios destinos: HAMILTON (mayor resto), con desempate
  por MENOR CODIGO en orden lexicografico, igual que I5 de E5. Se usa en dos sitios:
  el residuo de conversion de divisa (que absorben las cuotas, ADR-0014 D2) y el
  reparto de la cuota entre bloques de pasivo de un documento mixto (O-3).
* La cuota que se CONTABILIZA es la del documento (ADR-0014 D3). El recalculo solo fija
  la confianza y alimenta `quotaDeviationsCents` (I-E8-7b), que es una metrica, no un
  importe.
* El IVA NO deducible nunca pasa por 472: engorda la linea de gasto o de inmovilizado
  (art. 103 LIVA, NRV 2a y 10a).
* Periodo de IVA = trimestre de `max(receptionDate, documentDate)` (ADR-0014 D8), que no
  tiene por que ser el del `entryDate`.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
OUT = HERE / "extraccion-esperada.json"

SCHEMA_VERSION = "1.0"
REF_DATE = "2026-12-31"
BASE_CURRENCY = "EUR"
FISCAL_YEAR = "2026"


# ---------------------------------------------------------------------------
# Aritmetica: half-up para impuestos, half-even para divisa, Hamilton para restos
# ---------------------------------------------------------------------------


def apply_bps(base_cents: int, bps: int) -> int:
    """Cuota HALF-UP sobre la magnitud. Replica `applyBps` de lib/taxes/bps.ts."""
    if not isinstance(base_cents, int) or not isinstance(bps, int):
        raise TypeError("apply_bps opera con enteros")
    sign = -1 if base_cents < 0 else 1
    magnitude = abs(base_cents) * bps
    quotient, remainder = divmod(magnitude, 10000)
    return sign * (quotient + 1 if remainder * 2 >= 10000 else quotient)


def round_half_even(numerator: int, denominator: int) -> int:
    """`numerator/denominator` a entero con HALF-EVEN, en aritmetica entera exacta."""
    if denominator <= 0:
        raise ValueError("denominador positivo")
    sign = -1 if numerator < 0 else 1
    n = abs(numerator)
    quotient, remainder = divmod(n, denominator)
    twice = remainder * 2
    if twice > denominator or (twice == denominator and quotient % 2 == 1):
        quotient += 1
    return sign * quotient


def convert_with_rate_micro(cents: int, rate_micro: int) -> int:
    """Replica `convertWithRateMicro` de lib/money.ts: half-even sobre cents*rate/1e6."""
    return round_half_even(cents * rate_micro, 1_000_000)


def half_up_div(numerator: int, denominator: int) -> int:
    """`round_half_up(numerator/denominator)` exacto. Usado por RC-17."""
    sign = -1 if numerator < 0 else 1
    n = abs(numerator)
    quotient, remainder = divmod(n, denominator)
    return sign * (quotient + 1 if remainder * 2 >= denominator else quotient)


def hamilton(total: int, weights: list[tuple[str, int]]) -> list[tuple[str, int]]:
    """Reparte `total` entre `weights = [(code, peso>=0)]` por mayor resto.

    Sigma resultado == total EXACTO. Desempate de restos: MENOR CODIGO (lexicografico),
    para que el reparto sea reproducible byte a byte (P7), igual que I5 de E5.
    """
    if not weights:
        return []
    sign = -1 if total < 0 else 1
    magnitude = abs(total)
    total_weight = sum(w for _, w in weights)
    if total_weight == 0:
        weights = [(c, 1) for c, _ in weights]
        total_weight = len(weights)
    parts: list[tuple[str, int, int]] = []
    for code, weight in weights:
        quotient, remainder = divmod(magnitude * weight, total_weight)
        parts.append((code, quotient, remainder))
    assigned = sum(p[1] for p in parts)
    leftover = magnitude - assigned
    order = sorted(range(len(parts)), key=lambda i: (-parts[i][2], parts[i][0]))
    extra = {i: 0 for i in range(len(parts))}
    for i in order[:leftover]:
        extra[i] = 1
    return [(parts[i][0], sign * (parts[i][1] + extra[i])) for i in range(len(parts))]


# ---------------------------------------------------------------------------
# Identificadores fiscales: el modulo 23 / la letra de CIF que exige RC-11 rama ES
# ---------------------------------------------------------------------------

_NIF_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE"
_CIF_CONTROL_LETTERS = "JABCDEFGHI"


def nif_es_valido(value: str) -> bool:
    """Modulo 23 (NIF/NIE) y digito/letra de control de CIF. Solo rama ES de RC-11."""
    v = (value or "").strip().upper().replace("-", "").replace(" ", "")
    if len(v) != 9:
        return False
    if v[:8].isdigit() and v[8].isalpha():                      # NIF persona fisica
        return v[8] == _NIF_LETTERS[int(v[:8]) % 23]
    if v[0] in "XYZ" and v[1:8].isdigit() and v[8].isalpha():    # NIE
        n = int(str("XYZ".index(v[0])) + v[1:8])
        return v[8] == _NIF_LETTERS[n % 23]
    if v[0].isalpha() and v[1:8].isdigit():                      # CIF
        odd = sum(sum(divmod(int(d) * 2, 10)) for d in v[1:8:2])
        even = sum(int(d) for d in v[2:8:2])
        control = (10 - (odd + even) % 10) % 10
        last = v[8]
        if last.isdigit():
            return int(last) == control
        return last == _CIF_CONTROL_LETTERS[control]
    return False


# ---------------------------------------------------------------------------
# Contexto compartido: plan, mapa de claves, tipos y contrapartes
# ---------------------------------------------------------------------------

# `ACCOUNT_KEY_DEFAULT_CODE` de lib/accounts/map.ts + la clave que anade E8.
ACCOUNT_MAP: dict[str, str] = {
    "CLIENTES": "430",
    "PROVEEDORES": "400",
    "ACREEDORES": "410",
    "PROVEEDORES_INMOVILIZADO": "523",
    "BANCO_DEFAULT": "572",
    "CAJA": "570",
    "IVA_SOPORTADO": "472",
    "IVA_REPERCUTIDO": "477",
    "IVA_SOPORTADO_ISP": "472",
    "IVA_REPERCUTIDO_ISP": "477",
    "IRPF_PROFESIONALES_A_PAGAR": "4751",
    "IRPF_ALQUILERES_A_PAGAR": "4751",
    "ANTICIPOS_CLIENTES": "438",
    "ANTICIPOS_PROVEEDORES": "407",
    "COMPRAS_DEFAULT": "600",
    "SUBCONTRATACION_DEFAULT": "607",
    "VENTAS_DEFAULT": "705",
    "DEVOLUCION_VENTAS": "708",
    "DEVOLUCION_COMPRAS": "608",
    "REMUNERACIONES_PENDIENTES": "465",
    "REDONDEO_GASTO": "669",
    "REDONDEO_INGRESO": "769",
    "AJUSTE_IVA_NEGATIVO": "634",
    "AJUSTE_IVA_POSITIVO": "639",
}

TAX_RATES: dict[str, dict[str, Any]] = {
    "IVA_21": {"code": "IVA_21", "kind": "IVA", "rateBps": 2100, "appliesTo": "BOTH",
               "validFrom": "2012-09-01", "validTo": None},
    "IVA_10": {"code": "IVA_10", "kind": "IVA", "rateBps": 1000, "appliesTo": "BOTH",
               "validFrom": "2012-09-01", "validTo": None},
    "IVA_4": {"code": "IVA_4", "kind": "IVA", "rateBps": 400, "appliesTo": "BOTH",
              "validFrom": "2012-09-01", "validTo": None},
    "IVA_NO_SUJETO": {"code": "IVA_NO_SUJETO", "kind": "EXENTO", "rateBps": 0, "appliesTo": "BOTH",
                      "validFrom": "2007-01-01", "validTo": None},
    "IRPF_15": {"code": "IRPF_15", "kind": "IRPF", "rateBps": 1500, "appliesTo": "BOTH",
                "validFrom": "2015-07-12", "validTo": None},
}

# Cuentas que se citan en los asientos, con su tipo analitico segun seeds/npgc.csv.
ACCOUNT_ANALYTIC: dict[str, str | None] = {
    "217": None, "400": None, "410": None, "430": None, "438": None, "472": None,
    "477": None, "4751": None, "523": None, "570": None, "572": None,
    "600": "COSTE_DIRECTO_MC1", "607": "COSTE_DIRECTO_MC1", "608": "COSTE_DIRECTO_MC1",
    "621": "INDIRECTO_CECO", "623": "INDIRECTO_CECO", "628": "INDIRECTO_CECO",
    "629": "INDIRECTO_CECO", "631": "INDIRECTO_CECO",
    "705": "INGRESO_DIRECTO", "708": "INGRESO_DIRECTO",
}

ORG_GENERAL: dict[str, Any] = {
    "baseCurrency": BASE_CURRENCY,
    "taxRoundingMode": "POR_TIPO",
    "redondeoToleranciaCents": 1,
    "prorrataBps": None,
    "roiRegistered": True,
    "ivaRegime": "GENERAL",
    "analyticsRequired": False,
}

CONTRAPARTES: dict[str, dict[str, Any]] = {
    "CP-ES-SUBCON": {"id": "CP-ES-SUBCON", "name": "Talleres Duero SL", "taxId": "B12345674",
                     "countryCode": "ES", "vatNumber": "ESB12345674", "viesValid": None,
                     "viesCheckedAt": None, "withholdingRegime": "NINGUNO",
                     "withholdingRateCode": None, "surchargeRegime": False, "isEmployee": False,
                     "enMaestro": True},
    "CP-ES-SERVICIOS": {"id": "CP-ES-SERVICIOS", "name": "Servicios Integrales Nervion SA",
                        "taxId": "A28017895", "countryCode": "ES", "vatNumber": "ESA28017895",
                        "viesValid": None, "viesCheckedAt": None, "withholdingRegime": "NINGUNO",
                        "withholdingRateCode": None, "surchargeRegime": False, "isEmployee": False,
                        "enMaestro": True},
    "CP-ES-TICKET": {"id": None, "name": "Cafeteria del Puerto SL", "taxId": "B12345674",
                     "countryCode": "ES", "vatNumber": None, "viesValid": None,
                     "viesCheckedAt": None, "withholdingRegime": "NINGUNO",
                     "withholdingRateCode": None, "surchargeRegime": False, "isEmployee": False,
                     "enMaestro": False},
    "CP-ES-INFORMATICA": {"id": "CP-ES-INFORMATICA", "name": "Sistemas Aranzadi SL",
                          "taxId": "B12345674", "countryCode": "ES", "vatNumber": "ESB12345674",
                          "viesValid": None, "viesCheckedAt": None, "withholdingRegime": "NINGUNO",
                          "withholdingRateCode": None, "surchargeRegime": False,
                          "isEmployee": False, "enMaestro": True},
    "CP-ES-ABOGADO": {"id": "CP-ES-ABOGADO", "name": "Marta Ruiz Salas (abogada)",
                      "taxId": "12345678Z", "countryCode": "ES", "vatNumber": "ES12345678Z",
                      "viesValid": None, "viesCheckedAt": None, "withholdingRegime": "PROFESIONAL",
                      "withholdingRateCode": "IRPF_15", "surchargeRegime": False,
                      "isEmployee": False, "enMaestro": True},
    "CP-ES-CLIENTE": {"id": "CP-ES-CLIENTE", "name": "Constructora del Ebro SA",
                      "taxId": "A28017895", "countryCode": "ES", "vatNumber": "ESA28017895",
                      "viesValid": None, "viesCheckedAt": None, "withholdingRegime": "NINGUNO",
                      "withholdingRateCode": None, "surchargeRegime": False, "isEmployee": False,
                      "enMaestro": True},
    "CP-CH-BIENES": {"id": "CP-CH-BIENES", "name": "Alpina Components AG",
                     "taxId": "CHE-116.281.710", "countryCode": "CH", "vatNumber": None,
                     "viesValid": None, "viesCheckedAt": None, "withholdingRegime": "NINGUNO",
                     "withholdingRateCode": None, "surchargeRegime": False, "isEmployee": False,
                     "enMaestro": True},
    "CP-DE-AIB": {"id": "CP-DE-AIB", "name": "Nordwerk Bauteile GmbH", "taxId": "DE811907980",
                  "countryCode": "DE", "vatNumber": "DE811907980", "viesValid": True,
                  "viesCheckedAt": "2026-10-02", "withholdingRegime": "NINGUNO",
                  "withholdingRateCode": None, "surchargeRegime": False, "isEmployee": False,
                  "enMaestro": True},
    "CP-US-CONSULT": {"id": "CP-US-CONSULT", "name": "Harborline Advisors LLC",
                      "taxId": "98-7654321", "countryCode": "US", "vatNumber": None,
                      "viesValid": None, "viesCheckedAt": None, "withholdingRegime": "NINGUNO",
                      "withholdingRateCode": None, "surchargeRegime": False, "isEmployee": False,
                      "enMaestro": True},
}

# Tasa persistida en `exchange_rates` que usa el caso 12 (USD -> EUR, 1 USD = 1/1,08 EUR).
RATE_USD_EUR: dict[str, Any] = {
    "id": "RATE-2026-11-20-USD-EUR",
    "date": "2026-11-20",
    "from": "USD",
    "to": "EUR",
    "rateMicro": 925926,
    "source": "ECB_FRANKFURTER",
    "rateDateEfectiva": "2026-11-20",
    "nota": "1 EUR = 1,08 USD publicado por el BCE el 2026-11-20; se persiste el inverso "
            "en micro-unidades (925926 = 1/1,08 redondeado a 1e-6) porque la conversion "
            "va de la divisa del documento a la moneda base.",
}


# ---------------------------------------------------------------------------
# RC-01..RC-25: catalogo, con el enunciado y el default PASS de cada regla
# ---------------------------------------------------------------------------

RC_CATALOG: list[tuple[str, str, str]] = [
    ("RC-01", "Sigma bases de las lineas OPERACION = base declarada (suplidos y no sujetos fuera)",
     "las bases de las lineas suman la base declarada, tolerancia 0"),
    ("RC-02", "Cuota del documento contrastada por tipo con cuota(bases, rateBps, mode)",
     "la cuota del documento coincide al centimo con el recalculo, por cada tipo"),
    ("RC-03", "Identidad interna: Sigma bases + cuotas + recargos + suplidos y no sujetos - retencion - anticipo = total",
     "el documento cuadra consigo mismo (art. 6 RD 1619/2012), tolerancia 0"),
    ("RC-04", "Moneda ISO-4217 existente, exponente correcto y unica en el documento",
     "una sola moneda, con exponente 2"),
    ("RC-05", "Las cuatro fechas existen; documentDate <= refDate; ejercicio abierto y mes no bloqueado",
     "las cuatro fechas son validas y el asiento cae en ejercicio abierto"),
    ("RC-06", "Todo taxRateCode vigente a operationDate ?? accrualDate ?? documentDate (art. 90.Dos LIVA)",
     "todos los tipos estan vigentes a la fecha de devengo"),
    ("RC-07", "Toda cuenta existe, es postable y activa; ninguna del subgrupo 64",
     "todas las cuentas del asiento son postables, activas y ajenas al subgrupo 64"),
    ("RC-08", "Proyecto/CECO existen y son exclusivos entre si",
     "las dimensiones analiticas existen y no se solapan"),
    ("RC-09", "Extraccion completa: pagesAnalyzed = pagesTotal; un run parcial de kind LLM no respalda asiento",
     "el modelo vio el documento completo"),
    ("RC-10", "sha256 del fichero en disco = el sellado en el ExtractionRun",
     "el fichero no ha cambiado desde la extraccion"),
    ("RC-11", "Identificador fiscal por rama de pais: ES modulo 23 / letra CIF; UE formato + VIES; tercer pais libre",
     "identificador fiscal comprobado en su rama"),
    ("RC-12", "Sin duplicado por sha256 ni por (taxId, numero de documento, ejercicio)",
     "no hay otro documento con el mismo sha256 ni el mismo numero para el mismo NIF y ejercicio"),
    ("RC-13", "Signos: totalCents > 0; total negativo en FACTURA_* se reclasifica a ABONO_* con absolutos",
     "el total es positivo y el tipo de documento es coherente con su signo"),
    ("RC-14", "Moneda distinta de la base exige tasa persistida; sin tasa no se inventa nada",
     "la moneda del documento es la moneda base"),
    ("RC-15", "Deducibilidad resuelta: prorrata o REQUIERE_DECISION dejan el campo no verificado",
     "la deducibilidad esta resuelta por configuracion, sin decision pendiente"),
    ("RC-16", "Reproducibilidad: proposalHash estable y ningun importe procedente de rawOutput sin check",
     "la propuesta normalizada es reproducible byte a byte"),
    ("RC-17", "Documento con IVA incluido: base = round_half_up(total x 10000/(10000+bps)), cuota residual",
     "no aplica: el documento declara sus bases"),
    ("RC-18", "IVA no caducado: documentDate a menos de cuatro anos de la fecha de deduccion (art. 99.Cinco LIVA)",
     "el derecho a deducir esta dentro de los cuatro anos"),
    ("RC-19", "Retencion practicada = la del regimen de Counterparty; lo leido solo contrasta",
     "no aplica: la contraparte no esta sujeta a retencion"),
    ("RC-20", "Suplidos y no sujetos fuera de Sigma bases, de la base de la cuota y de la base de la retencion",
     "no aplica: el documento no tiene suplidos ni lineas no sujetas"),
    ("RC-21", "ABONO_* exige rectifies{documentNumber, reason, mode}; con SUSTITUCION, el rectificado resuelto",
     "no aplica: el documento no es rectificativo"),
    ("RC-22", "ISP solo con las cuatro precondiciones: pais/VIES con fecha, ausencia de cuota, mencion legal y ROI",
     "no aplica: el documento no se ha calificado como inversion del sujeto pasivo"),
    ("RC-23", "appliedAdvanceTaxCents = IVA repercutido del asiento del anticipo referenciado",
     "no aplica: el documento no aplica anticipo alguno"),
    ("RC-24", "Organization.ivaRegime = GENERAL; RECC/REDEME/OTRO bloquean la contabilizacion automatica",
     "la organizacion esta en regimen general de IVA"),
    ("RC-25", "FACTURA_ANTICIPO_CLIENTE exige cobro registrado: sin cobro no hay 477 (art. 75.Dos LIVA)",
     "no aplica: el documento no es una factura de anticipo de cliente"),
]

RC_IDS = [rc[0] for rc in RC_CATALOG]
RC_TITLE = {rc[0]: rc[1] for rc in RC_CATALOG}
RC_DEFAULT_MSG = {rc[0]: rc[2] for rc in RC_CATALOG}


def build_checks(overrides: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Los 25 checks en el orden fijo del catalogo. Lo no sobrescrito sale PASS."""
    unknown = set(overrides) - set(RC_IDS)
    if unknown:
        raise KeyError(f"RC desconocido: {sorted(unknown)}")
    out: list[dict[str, Any]] = []
    for rc in RC_IDS:
        o = overrides.get(rc, {})
        out.append({
            "id": rc,
            "regla": RC_TITLE[rc],
            "status": o.get("status", "PASS"),
            "blocksBatch": o.get("blocksBatch", False),
            "message": o.get("message", RC_DEFAULT_MSG[rc]),
            "evidence": o.get("evidence", {}),
            "fields": list(o.get("fields", [])),
        })
    return out


def estado_global(checks: list[dict[str, Any]]) -> str:
    if any(c["status"] == "FAIL" for c in checks):
        return "FAIL"
    if any(c["status"] == "WARN" for c in checks):
        return "WARN"
    return "PASS"


def elegible_lote(checks: list[dict[str, Any]]) -> bool:
    """`confirmBatchAction`: solo PASS y sin ningun check con `blocksBatch` activo."""
    return estado_global(checks) == "PASS" and not any(c["blocksBatch"] for c in checks)


# ---------------------------------------------------------------------------
# Lineas del asiento
# ---------------------------------------------------------------------------


def line(account: str, debit: int = 0, credit: int = 0, *, description: str,
         tax_rate_code: str | None = None, deductibility: str | None = None,
         project_id: str | None = None, cost_center_id: str | None = None,
         original_currency: str | None = None, original_amount_cents: int | None = None,
         exchange_rate_id: str | None = None, account_key: str | None = None,
         non_deductible_included_cents: int = 0) -> dict[str, Any]:
    if debit < 0 or credit < 0 or (debit > 0 and credit > 0) or (debit == 0 and credit == 0):
        raise ValueError(f"linea invalida en {account}: debe={debit} haber={credit}")
    if account not in ACCOUNT_ANALYTIC:
        raise KeyError(f"cuenta fuera del plan del fixture: {account}")
    return {
        "accountCode": account,
        "accountKey": account_key,
        "description": description,
        "debitCents": debit,
        "creditCents": credit,
        "analyticType": ACCOUNT_ANALYTIC[account],
        "projectId": project_id,
        "costCenterId": cost_center_id,
        "taxRateCode": tax_rate_code,
        "deductibility": deductibility,
        "nonDeductibleIncludedCents": non_deductible_included_cents,
        "originalCurrency": original_currency,
        "originalAmountCents": original_amount_cents,
        "exchangeRateId": exchange_rate_id,
    }


def quarter_of(date: str) -> str:
    return f"{date[:4]}-Q{(int(date[5:7]) - 1) // 3 + 1}"


def iva_period(document_date: str, reception_date: str | None) -> str:
    """ADR-0014 D8: el periodo de IVA soportado es el de max(receptionDate, documentDate)."""
    ref = max(document_date, reception_date) if reception_date else document_date
    return quarter_of(ref)


def entry(template: str, *, source_type: str, entry_date: str, document_date: str,
          reception_date: str | None, operation_date: str | None, lines: list[dict[str, Any]],
          payable_blocks: list[dict[str, Any]] | None = None,
          tax_overrides: list[dict[str, Any]] | None = None,
          hash_version: int = 3, notas: list[str] | None = None) -> dict[str, Any]:
    debit = sum(l["debitCents"] for l in lines)
    credit = sum(l["creditCents"] for l in lines)
    return {
        "templateCode": template,
        "templateVersion": 1,
        "sourceType": source_type,
        "entryDate": entry_date,
        "documentDate": document_date,
        "receptionDate": reception_date,
        "operationDate": operation_date,
        "ivaPeriod": iva_period(document_date, reception_date),
        "hashVersion": hash_version,
        "payableBlocks": payable_blocks or [],
        "taxOverrides": tax_overrides or [],
        "lines": lines,
        "totalDebitCents": debit,
        "totalCreditCents": credit,
        "cuadreCents": debit - credit,
        "notas": notas or [],
    }


# ---------------------------------------------------------------------------
# Confianza por campo (P6, cuatro niveles, O-20.1)
# ---------------------------------------------------------------------------

def conf(origin: str, confidence: str, check: str | None = None) -> dict[str, Any]:
    if origin not in ("llm", "usuario", "calculado", "catalogo", "importado"):
        raise ValueError(f"origen invalido: {origin}")
    if confidence not in ("calculado", "verificado", "interpretacion_ia", "no_verificado"):
        raise ValueError(f"confianza invalida: {confidence}")
    return {"origin": origin, "confidence": confidence, "check": check}


# Campos que el modelo lee y que NUNCA son derivables: siempre `interpretacion_ia`.
def conf_base_documental(extra: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    base = {
        "docKind": conf("llm", "interpretacion_ia", "RC-13"),
        "documentNumber": conf("llm", "interpretacion_ia", "RC-12"),
        "counterparty.name": conf("llm", "interpretacion_ia", "RC-11"),
        "documentDate": conf("llm", "interpretacion_ia", "RC-05"),
        "currency": conf("llm", "interpretacion_ia", "RC-04"),
        "receptionDate": conf("usuario", "verificado", "RC-05"),
    }
    base.update(extra or {})
    return dict(sorted(base.items()))


CASES: list[dict[str, Any]] = []


def add(case: dict[str, Any]) -> None:
    CASES.append(case)



def propuesta(*, doc_kind: str, number: str | None, cp: dict[str, Any], document_date: str,
              reception_date: str | None, currency: str = "EUR", lines: list[dict[str, Any]],
              taxes: list[dict[str, Any]], total: int, description: str,
              pages: tuple[int, int] = (1, 1), **extra: Any) -> dict[str, Any]:
    """Propuesta normalizada. Los campos que el modelo NO rellena (O-10/O-11/D4/D8) llegan
    por `extra` o por el default, jamas del `rawOutput`."""
    p: dict[str, Any] = {
        "version": 1, "docKind": doc_kind, "documentNumber": number,
        "counterparty": {"name": cp["name"], "taxId": cp["taxId"], "id": cp["id"]},
        "documentDate": document_date, "accrualDate": None, "receptionDate": reception_date,
        "operationDate": None, "dueSchedule": None, "currency": currency,
        "lines": lines, "taxes": taxes,
        "withholding": None, "readWithholding": None,
        "appliedAdvanceCents": 0, "appliedAdvanceTaxCents": 0, "advanceEntryId": None,
        "rectifies": None, "paymentKey": None, "simplifiedQualified": None,
        "totalCents": total, "description": description,
        "pagesAnalyzed": pages[0], "pagesTotal": pages[1],
    }
    p.update(extra)
    return p


def pl(base: int, rate: str | None, account: str, *, kind: str = "OPERACION", discount: int = 0,
       description: str = "", origin: str = "catalogo", project: str | None = None,
       ceco: str | None = None, deductibility: str | None = "FULL") -> dict[str, Any]:
    """Linea de la propuesta. `baseCents` es la base YA neta de descuento (D10)."""
    return {"kind": kind, "baseCents": base, "discountCents": discount, "taxRateCode": rate,
            "description": description, "accountCode": account, "accountCodeOrigin": origin,
            "projectId": project, "costCenterId": ceco, "deductibility": deductibility}


def pt(rate: str, base: int, quota: int, key: str = "GENERAL") -> dict[str, Any]:
    return {"taxRateCode": rate, "baseCents": base, "quotaCents": quota, "operationKey": key}


def libro(tipo: str, *, base: int = 0, cuota_total: int = 0, deducible: int = 0,
          no_deducible: int = 0, repercutida: int = 0, devengada_isp: int = 0) -> dict[str, Any]:
    """Anotacion del libro registro (art. 64 y 63 RIVA), que es lo que cuadran I-E8-15a/b/c."""
    return {"tipo": tipo, "baseCents": base, "cuotaTotalCents": cuota_total,
            "cuotaDeducibleCents": deducible, "cuotaNoDeducibleAlCosteCents": no_deducible,
            "cuotaRepercutidaCents": repercutida, "cuotaDevengadaIspAibCents": devengada_isp}


def mk(*, cid: str, slug: str, titulo: str, cubre: list[str], fundamento: str,
       cp: dict[str, Any], prop: dict[str, Any], overrides: dict[str, dict[str, Any]],
       confianza: dict[str, dict[str, Any]], asiento: dict[str, Any] | None,
       libro_registro: dict[str, Any], org: dict[str, Any] | None = None,
       run: dict[str, Any] | None = None, rate: dict[str, Any] | None = None,
       categoria: dict[str, Any] | None = None, desviaciones: dict[str, int] | None = None,
       sellos: list[str] | None = None, post_error: str | None = None,
       notas: list[str] | None = None) -> dict[str, Any]:
    checks = build_checks(overrides)
    return {
        "id": cid, "slug": slug, "titulo": titulo, "cubre": cubre, "fundamento": fundamento,
        "contexto": {
            "organization": org or ORG_GENERAL, "counterparty": cp, "refDate": REF_DATE,
            "run": run or {"kind": "LLM", "pagesAnalyzed": prop["pagesAnalyzed"],
                           "pagesTotal": prop["pagesTotal"],
                           "partial": prop["pagesAnalyzed"] < prop["pagesTotal"]},
            "rate": rate, "categoria": categoria,
        },
        "propuesta": prop,
        "reconcile": {
            "status": estado_global(checks), "checks": checks,
            "confianzaPorCampo": conf_base_documental(confianza),
            "quotaDeviationsCents": dict(sorted((desviaciones or {}).items())),
            "elegibleParaLote": elegible_lote(checks),
            "sellos": sellos or [],
        },
        "postError": post_error,
        "asiento": asiento,
        "libroRegistro": libro_registro,
        "notas": notas or [],
    }


# ---------------------------------------------------------------------------
# Los quince casos
# ---------------------------------------------------------------------------

def caso_01() -> dict[str, Any]:
    base, cuota, total = 100_000, 21_000, 121_000
    cp = CONTRAPARTES["CP-ES-SUBCON"]
    return mk(
        cid="C01", slug="factura-recibida-simple",
        titulo="Factura recibida de subcontratacion, recibida en el trimestre siguiente al de expedicion",
        cubre=["§5.3 caso 1 (factura simple)", "criterio 10 (fecha de recepcion)",
               "criterio 24 (NIF valido con ficha -> verificado)"],
        fundamento="arts. 92.Uno y 97.Uno LIVA (la cuota deducible es la de la factura); "
                   "art. 99.Tres LIVA y ADR-0014 D8 (se deduce en el periodo de recepcion).",
        cp=cp,
        categoria={"code": "SUBCONTRATACION", "defaultAccountCode": "607", "defaultDeductibility": "FULL"},
        prop=propuesta(doc_kind="FACTURA_RECIBIDA", number="F-2026-0001", cp=cp,
                       document_date="2026-03-28", reception_date="2026-05-04",
                       lines=[pl(base, "IVA_21", "607", description="Montaje en obra", project="PRJ-ALFA")],
                       taxes=[pt("IVA_21", base, cuota)], total=total,
                       description="Montaje en obra - proyecto Alfa",
                       dueSchedule=[{"dueDate": "2026-04-27", "amountCents": total}]),
        overrides={
            "RC-02": {"message": "cuota declarada 21 000 = recalculada 21 000 sobre 100 000 al 21 %",
                      "evidence": {"IVA_21": {"declarada": 21000, "recalculada": 21000, "desvio": 0}},
                      "fields": ["taxes.IVA_21.quotaCents"]},
            "RC-05": {"message": "expedida el 2026-03-28 y recibida el 2026-05-04: el gasto se devenga "
                                 "en marzo y el IVA se deduce en el 2T",
                      "evidence": {"documentDate": "2026-03-28", "receptionDate": "2026-05-04",
                                   "entryDate": "2026-03-28", "ivaPeriod": "2026-Q2"},
                      "fields": ["documentDate", "receptionDate"]},
            "RC-11": {"message": "NIF ES B12345674: digito de control valido y ficha en el maestro",
                      "evidence": {"rama": "ES", "checksum": "VALIDO", "enMaestro": True},
                      "fields": ["counterparty.taxId"]},
        },
        confianza={
            "counterparty.taxId": conf("llm", "verificado", "RC-11"),
            "lines[0].baseCents": conf("llm", "verificado", "RC-01"),
            "lines[0].accountCode": conf("catalogo", "interpretacion_ia", "RC-07"),
            "lines[0].deductibility": conf("catalogo", "verificado", "RC-15"),
            "taxes[IVA_21].quotaCents": conf("llm", "verificado", "RC-02"),
            "totalCents": conf("llm", "verificado", "RC-03"),
        },
        asiento=entry("FACTURA_RECIBIDA", source_type="INVOICE_IN", entry_date="2026-03-28",
                      document_date="2026-03-28", reception_date="2026-05-04", operation_date=None,
                      lines=[
                          line("607", debit=base, description="Subcontratacion de montaje - proyecto Alfa",
                               tax_rate_code="IVA_21", deductibility="FULL", project_id="PRJ-ALFA"),
                          line("472", debit=cuota, description="IVA soportado 21 % (cuota del documento)",
                               tax_rate_code="IVA_21", account_key="IVA_SOPORTADO"),
                          line("400", credit=total, description="Talleres Duero SL", account_key="PROVEEDORES"),
                      ],
                      payable_blocks=[{"payableKey": "PROVEEDORES", "accountCode": "400",
                                       "baseCents": base, "quotaCents": cuota, "amountCents": total}],
                      tax_overrides=[{"taxRateCode": "IVA_21", "quotaCents": cuota}],
                      notas=["607 y no 623 porque el servicio se incorpora al entregable del proyecto "
                             "Alfa (§1.3 de la validacion contable). La cuenta viene del catalogo, "
                             "nunca del modelo (O-10): su confianza maxima es interpretacion_ia.",
                             "El asiento es de marzo; el 472 se declara en el 2T (ADR-0014 D8)."]),
        libro_registro=libro("RECIBIDAS", base=base, cuota_total=cuota, deducible=cuota),
    )


def caso_02() -> dict[str, Any]:
    b21, b10 = 100_000, 50_000
    q21_doc, q10_doc = 21_001, 4_999
    total = b21 + b10 + q21_doc + q10_doc          # 176 000
    cp = CONTRAPARTES["CP-ES-SERVICIOS"]
    return mk(
        cid="C02", slug="dos-tipos-desviacion-un-centimo",
        titulo="Dos tipos impositivos con la cuota del emisor desviada un centimo en cada uno",
        cubre=["§5.3 caso 2", "criterio 3 (se contabiliza la cuota del documento)",
               "criterio 4 (dos lineas de 472, dos WARN, ninguna linea de ajuste)"],
        fundamento="ADR-0014 D3: la cuota contabilizada es la de la factura (arts. 92.Uno y 97.Uno "
                   "LIVA, art. 64 RIVA). El recalculo es control de verosimilitud. 669/769 queda "
                   "reservado al redondeo de tesoreria y 634/639 a la imposicion indirecta.",
        cp=cp,
        prop=propuesta(doc_kind="FACTURA_RECIBIDA", number="2026/A/118", cp=cp,
                       document_date="2026-04-10", reception_date="2026-04-12",
                       lines=[pl(b21, "IVA_21", "623", description="Asesoria juridica trimestral", ceco="CC-ADM"),
                              pl(b10, "IVA_10", "629", description="Transporte de viajeros", ceco="CC-ADM")],
                       taxes=[pt("IVA_21", b21, q21_doc), pt("IVA_10", b10, q10_doc)],
                       total=total, description="Servicios de estructura, dos tipos"),
        overrides={
            "RC-02": {"status": "WARN", "blocksBatch": False,
                      "message": "la cuota del documento difiere un centimo del recalculo en los dos "
                                 "tipos: se contabiliza la del documento (21 001 y 4 999)",
                      "evidence": {"IVA_21": {"declarada": 21001, "recalculada": 21000, "desvio": 1,
                                              "tolerancia": 1},
                                   "IVA_10": {"declarada": 4999, "recalculada": 5000, "desvio": -1,
                                              "tolerancia": 1}},
                      "fields": ["taxes.IVA_21.quotaCents", "taxes.IVA_10.quotaCents"]},
            "RC-03": {"message": "150 000 de bases + 26 000 de cuotas = 176 000 declarados, tolerancia 0",
                      "evidence": {"bases": 150000, "cuotas": 26000, "total": total, "desvio": 0}},
        },
        confianza={
            "counterparty.taxId": conf("llm", "verificado", "RC-11"),
            "lines[0].baseCents": conf("llm", "verificado", "RC-01"),
            "lines[1].baseCents": conf("llm", "verificado", "RC-01"),
            "lines[0].accountCode": conf("catalogo", "interpretacion_ia", "RC-07"),
            "lines[1].accountCode": conf("catalogo", "interpretacion_ia", "RC-07"),
            "taxes[IVA_21].quotaCents": conf("llm", "interpretacion_ia", "RC-02"),
            "taxes[IVA_10].quotaCents": conf("llm", "interpretacion_ia", "RC-02"),
            "totalCents": conf("llm", "verificado", "RC-03"),
        },
        desviaciones={"IVA_10": -1, "IVA_21": 1},
        asiento=entry("FACTURA_RECIBIDA", source_type="INVOICE_IN", entry_date="2026-04-10",
                      document_date="2026-04-10", reception_date="2026-04-12", operation_date=None,
                      lines=[
                          line("623", debit=b21, description="Asesoria juridica trimestral",
                               tax_rate_code="IVA_21", deductibility="FULL", cost_center_id="CC-ADM"),
                          line("629", debit=b10, description="Transporte de viajeros",
                               tax_rate_code="IVA_10", deductibility="FULL", cost_center_id="CC-ADM"),
                          line("472", debit=q21_doc, description="IVA soportado 21 % (cuota del documento)",
                               tax_rate_code="IVA_21", account_key="IVA_SOPORTADO"),
                          line("472", debit=q10_doc, description="IVA soportado 10 % (cuota del documento)",
                               tax_rate_code="IVA_10", account_key="IVA_SOPORTADO"),
                          line("410", credit=total, description="Servicios Integrales Nervion SA",
                               account_key="ACREEDORES"),
                      ],
                      payable_blocks=[{"payableKey": "ACREEDORES", "accountCode": "410",
                                       "baseCents": b21 + b10, "quotaCents": q21_doc + q10_doc,
                                       "amountCents": total}],
                      tax_overrides=[{"taxRateCode": "IVA_10", "quotaCents": q10_doc},
                                     {"taxRateCode": "IVA_21", "quotaCents": q21_doc}],
                      notas=["DOS lineas de 472, una por taxRateId. El test debe fallar si el motor "
                             "compensa 21 000 + 5 000 en una sola linea de 26 000 o si no emite los "
                             "dos WARN.",
                             "Ninguna linea de 669, 769, 634 ni 639: con la cuota del documento el "
                             "asiento cuadra por construccion (ADR-0014 D3.iii)."]),
        libro_registro=libro("RECIBIDAS", base=b21 + b10, cuota_total=q21_doc + q10_doc,
                             deducible=q21_doc + q10_doc),
    )


def caso_03() -> dict[str, Any]:
    total = 1_234
    base = half_up_div(total * 10_000, 10_000 + 1_000)   # RC-17
    cuota = total - base
    cp = CONTRAPARTES["CP-ES-TICKET"]
    return mk(
        cid="C03", slug="ticket-no-cualificado",
        titulo="Ticket con IVA incluido pagado con tarjeta: contrapartida de tesoreria y cuota NO deducible",
        cubre=["§5.3 caso 3", "criterio 5 (primera mitad)", "I-E8-15b (la cuota perdida engorda el coste)"],
        fundamento="art. 97.Uno LIVA: solo la factura simplificada cualificada del art. 7.2 RD "
                   "1619/2012 da derecho a deducir. art. 103 LIVA y NRV 2a: la cuota no deducible "
                   "es mayor coste. ADR-0014 D9: contrapartida de tesoreria, nunca 410.",
        cp=cp,
        categoria={"code": "RESTAURACION", "defaultAccountCode": "629", "defaultDeductibility": "NONE"},
        prop=propuesta(doc_kind="TICKET", number="T-004512", cp=cp,
                       document_date="2026-05-06", reception_date="2026-05-06",
                       lines=[pl(base, "IVA_10", "629", description="Comida de trabajo",
                                 ceco="CC-ADM", deductibility="NONE")],
                       taxes=[pt("IVA_10", base, cuota)], total=total,
                       description="Ticket de restauracion con IVA incluido",
                       paymentKey="BANCO_DEFAULT", simplifiedQualified=False),
        overrides={
            "RC-17": {"message": "ticket sin bases declaradas: base = round_half_up(1 234 x 10000/11000) "
                                 "= 1 122 y cuota residual = 112; base + cuota = total, tolerancia 0",
                      "evidence": {"totalCents": total, "rateBps": 1000, "baseCents": base,
                                   "cuotaCents": cuota, "residuo": total - base - cuota},
                      "fields": ["lines[0].baseCents", "taxes.IVA_10.quotaCents"]},
            "RC-02": {"message": "cuota residual por construccion: no hay recalculo que contrastar",
                      "evidence": {"IVA_10": {"declarada": None, "derivada": cuota, "desvio": 0}}},
            "RC-15": {"message": "deducibilidad NONE por defecto de factura simplificada (ADR-0014 D9); "
                                 "pasar a FULL es un acto explicito y auditado del EDITOR",
                      "evidence": {"deductibility": "NONE", "simplifiedQualified": False}},
            "RC-11": {"status": "WARN", "blocksBatch": False,
                      "message": "el ticket lleva NIF valido del emisor pero no hay ficha de contraparte",
                      "evidence": {"rama": "ES", "checksum": "VALIDO", "enMaestro": False},
                      "fields": ["counterparty.taxId"]},
        },
        confianza={
            "counterparty.taxId": conf("llm", "interpretacion_ia", "RC-11"),
            "lines[0].baseCents": conf("calculado", "calculado", "RC-17"),
            "lines[0].accountCode": conf("catalogo", "interpretacion_ia", "RC-07"),
            "lines[0].deductibility": conf("catalogo", "verificado", "RC-15"),
            "taxes[IVA_10].quotaCents": conf("calculado", "calculado", "RC-17"),
            "totalCents": conf("llm", "interpretacion_ia", "RC-17"),
            "paymentKey": conf("usuario", "verificado", None),
        },
        asiento=entry("FACTURA_RECIBIDA", source_type="INVOICE_IN", entry_date="2026-05-06",
                      document_date="2026-05-06", reception_date="2026-05-06", operation_date=None,
                      lines=[
                          line("629", debit=total, description="Comida de trabajo (IVA no deducible incluido)",
                               tax_rate_code="IVA_10", deductibility="NONE", cost_center_id="CC-ADM",
                               non_deductible_included_cents=cuota),
                          line("572", credit=total, description="Pago con tarjeta", account_key="BANCO_DEFAULT"),
                      ],
                      payable_blocks=[{"payableKey": "BANCO_DEFAULT", "accountCode": "572",
                                       "baseCents": base, "quotaCents": cuota, "amountCents": total}],
                      tax_overrides=[{"taxRateCode": "IVA_10", "quotaCents": cuota}],
                      notas=["SIN linea de 472 y SIN 410: el ticket se paga en el acto y su cuota no "
                             "es deducible. Llevarlo a 410 crearia una deuda que nunca se paga y "
                             "falsearia el periodo medio de pago (Ley 15/2010).",
                             "Los 112 centimos de cuota viajan dentro de los 1 234 de la 629: es "
                             "exactamente lo que I-E8-15b verifica."]),
        libro_registro=libro("RECIBIDAS", base=base, cuota_total=cuota, deducible=0, no_deducible=cuota),
    )


def caso_04() -> dict[str, Any]:
    total = 1_234
    base = half_up_div(total * 10_000, 10_000 + 1_000)
    cuota = total - base
    cp = CONTRAPARTES["CP-ES-TICKET"]
    return mk(
        cid="C04", slug="ticket-cualificado",
        titulo="El mismo ticket marcado como factura simplificada CUALIFICADA por un EDITOR",
        cubre=["§5.3 caso 4", "criterio 5 (segunda mitad)", "criterio 26 (I-E8-15a con el 472 del ticket)"],
        fundamento="art. 7.2 RD 1619/2012: la factura simplificada con NIF y domicilio del "
                   "destinatario y cuota repercutida por separado si da derecho a deducir. El paso "
                   "a FULL es un acto explicito del usuario y queda en AuditLog.",
        cp=cp,
        categoria={"code": "RESTAURACION", "defaultAccountCode": "629", "defaultDeductibility": "NONE"},
        prop=propuesta(doc_kind="TICKET", number="T-004512", cp=cp,
                       document_date="2026-05-06", reception_date="2026-05-06",
                       lines=[pl(base, "IVA_10", "629", description="Comida de trabajo",
                                 ceco="CC-ADM", deductibility="FULL")],
                       taxes=[pt("IVA_10", base, cuota)], total=total,
                       description="Ticket de restauracion cualificado",
                       paymentKey="BANCO_DEFAULT", simplifiedQualified=True),
        overrides={
            "RC-17": {"message": "base y cuota derivadas del total con IVA incluido, residuo 0",
                      "evidence": {"totalCents": total, "rateBps": 1000, "baseCents": base,
                                   "cuotaCents": cuota, "residuo": 0},
                      "fields": ["lines[0].baseCents", "taxes.IVA_10.quotaCents"]},
            "RC-15": {"message": "deducibilidad FULL por acto explicito del EDITOR "
                                 "(markSimplifiedQualifiedAction, con motivo y AuditLog)",
                      "evidence": {"deductibility": "FULL", "simplifiedQualified": True,
                                   "auditAction": "MARK_SIMPLIFIED_QUALIFIED"}},
            "RC-11": {"status": "WARN", "blocksBatch": False,
                      "message": "NIF valido del emisor sin ficha de contraparte",
                      "evidence": {"rama": "ES", "checksum": "VALIDO", "enMaestro": False},
                      "fields": ["counterparty.taxId"]},
        },
        confianza={
            "counterparty.taxId": conf("llm", "interpretacion_ia", "RC-11"),
            "lines[0].baseCents": conf("calculado", "calculado", "RC-17"),
            "lines[0].accountCode": conf("catalogo", "interpretacion_ia", "RC-07"),
            "lines[0].deductibility": conf("usuario", "verificado", "RC-15"),
            "taxes[IVA_10].quotaCents": conf("calculado", "calculado", "RC-17"),
            "totalCents": conf("llm", "interpretacion_ia", "RC-17"),
            "simplifiedQualified": conf("usuario", "verificado", None),
        },
        asiento=entry("FACTURA_RECIBIDA", source_type="INVOICE_IN", entry_date="2026-05-06",
                      document_date="2026-05-06", reception_date="2026-05-06", operation_date=None,
                      lines=[
                          line("629", debit=base, description="Comida de trabajo",
                               tax_rate_code="IVA_10", deductibility="FULL", cost_center_id="CC-ADM"),
                          line("472", debit=cuota, description="IVA soportado 10 % (ticket cualificado)",
                               tax_rate_code="IVA_10", account_key="IVA_SOPORTADO"),
                          line("572", credit=total, description="Pago con tarjeta", account_key="BANCO_DEFAULT"),
                      ],
                      payable_blocks=[{"payableKey": "BANCO_DEFAULT", "accountCode": "572",
                                       "baseCents": base, "quotaCents": cuota, "amountCents": total}],
                      tax_overrides=[{"taxRateCode": "IVA_10", "quotaCents": cuota}],
                      notas=["Mismo documento y mismo total que C03; lo unico que cambia es un acto "
                             "humano auditado. El par C03/C04 es lo que demuestra que la "
                             "deducibilidad no la decide el documento (ADR-0014 D4)."]),
        libro_registro=libro("RECIBIDAS", base=base, cuota_total=cuota, deducible=cuota),
        notas=["avisoCalidad: TICKET_CUALIFICADO, que E7 lista en el panel de calidad de datos."],
    )


def caso_05() -> dict[str, Any]:
    b_inm, b_serv = 1_000_000, 200_000
    cuota_doc = 252_000
    total = b_inm + b_serv + cuota_doc                    # 1 452 000
    reparto = hamilton(cuota_doc, [("410", b_serv), ("523", b_inm)])
    q_por_bloque = dict(reparto)
    cp = CONTRAPARTES["CP-ES-INFORMATICA"]
    return mk(
        cid="C05", slug="mixta-inmovilizado-y-servicio",
        titulo="Documento mixto: equipo informatico (grupo 2) y mantenimiento (62x) con el pasivo repartido",
        cubre=["§5.3 caso 5", "criterio 6 (bloques de pasivo)", "criterio 7 (523 siempre en el alta)"],
        fundamento="3a parte del PGC: la deuda por inmovilizado no es acreedor comercial. ADR-0014 D6 "
                   "y art. 35.1 CCom: el criterio corriente/no corriente se mide DESDE EL CIERRE, asi "
                   "que en el alta siempre es 523; la reclasificacion 523->173 es un asiento de E9.",
        cp=cp,
        prop=propuesta(doc_kind="FACTURA_RECIBIDA", number="SIS-2026-3341", cp=cp,
                       document_date="2026-11-15", reception_date="2026-11-18",
                       lines=[pl(b_inm, "IVA_21", "217", description="Servidor de calculo",
                                 ceco=None, deductibility="FULL"),
                              pl(b_serv, "IVA_21", "629", description="Mantenimiento anual",
                                 ceco="CC-OPS")],
                       taxes=[pt("IVA_21", b_inm + b_serv, cuota_doc)], total=total,
                       description="Servidor y mantenimiento",
                       dueSchedule=[{"dueDate": "2027-11-30", "amountCents": total}]),
        overrides={
            "RC-02": {"message": "cuota declarada 252 000 = recalculada sobre 1 200 000 al 21 %",
                      "evidence": {"IVA_21": {"declarada": 252000, "recalculada": 252000, "desvio": 0}},
                      "fields": ["taxes.IVA_21.quotaCents"]},
            "RC-05": {"message": "vencimiento a 2027-11-30, mas de doce meses desde la factura, pero el "
                                 "plazo se mide desde el cierre (2026-12-31): en el alta la deuda es 523",
                      "evidence": {"documentDate": "2026-11-15", "dueDate": "2027-11-30",
                                   "cierre": "2026-12-31", "cuentaEnAlta": "523",
                                   "candidataAReclasificacion": True}},
            "RC-07": {"message": "217 (grupo 2) y 629 (62x) existen, son postables y determinan dos "
                                 "claves de pasivo distintas"},
        },
        confianza={
            "counterparty.taxId": conf("llm", "verificado", "RC-11"),
            "lines[0].baseCents": conf("llm", "verificado", "RC-01"),
            "lines[1].baseCents": conf("llm", "verificado", "RC-01"),
            "lines[0].accountCode": conf("usuario", "verificado", "RC-07"),
            "lines[1].accountCode": conf("catalogo", "interpretacion_ia", "RC-07"),
            "taxes[IVA_21].quotaCents": conf("llm", "verificado", "RC-02"),
            "totalCents": conf("llm", "verificado", "RC-03"),
        },
        asiento=entry("FACTURA_RECIBIDA", source_type="INVOICE_IN", entry_date="2026-11-15",
                      document_date="2026-11-15", reception_date="2026-11-18", operation_date=None,
                      lines=[
                          line("217", debit=b_inm, description="Servidor de calculo",
                               tax_rate_code="IVA_21", deductibility="FULL"),
                          line("629", debit=b_serv, description="Mantenimiento anual",
                               tax_rate_code="IVA_21", deductibility="FULL", cost_center_id="CC-OPS"),
                          line("472", debit=cuota_doc, description="IVA soportado 21 % (cuota del documento)",
                               tax_rate_code="IVA_21", account_key="IVA_SOPORTADO"),
                          line("523", credit=b_inm + q_por_bloque["523"],
                               description="Sistemas Aranzadi SL - inmovilizado",
                               account_key="PROVEEDORES_INMOVILIZADO"),
                          line("410", credit=b_serv + q_por_bloque["410"],
                               description="Sistemas Aranzadi SL - servicios", account_key="ACREEDORES"),
                      ],
                      payable_blocks=[
                          {"payableKey": "ACREEDORES", "accountCode": "410", "baseCents": b_serv,
                           "quotaCents": q_por_bloque["410"], "amountCents": b_serv + q_por_bloque["410"]},
                          {"payableKey": "PROVEEDORES_INMOVILIZADO", "accountCode": "523",
                           "baseCents": b_inm, "quotaCents": q_por_bloque["523"],
                           "amountCents": b_inm + q_por_bloque["523"]},
                      ],
                      tax_overrides=[{"taxRateCode": "IVA_21", "quotaCents": cuota_doc}],
                      notas=["La cuota se reparte entre bloques por Hamilton sobre la base de cada uno; "
                             "aqui el reparto es exacto (210 000 / 42 000) y el residuo es 0. El "
                             "centimo huerfano, cuando lo haya, va al bloque de mayor importe.",
                             "El test debe fallar si los 1 452 000 van enteros a 523 o enteros a 410."]),
        libro_registro=libro("RECIBIDAS", base=b_inm + b_serv, cuota_total=cuota_doc, deducible=cuota_doc),
        notas=["Auditoria lo lista como candidato a reclasificacion 523->173 en el cierre (E9)."],
    )


def caso_06() -> dict[str, Any]:
    base, cuota, total = 20_000, 4_200, 24_200
    cp = CONTRAPARTES["CP-ES-SUBCON"]
    return mk(
        cid="C06", slug="rectificativa-por-diferencias",
        titulo="Abono recibido por devolucion parcial, modo DIFERENCIAS",
        cubre=["§5.3 caso 6", "criterio 9 (segunda mitad: normalizacion de signos)"],
        fundamento="art. 15 RD 1619/2012 y art. 80 LIVA. ADR-0014 D12: en modo DIFERENCIAS se "
                   "contabiliza lo que el documento expresa, que ya ES la diferencia.",
        cp=cp,
        prop=propuesta(doc_kind="ABONO_RECIBIDO", number="R-2026-0007", cp=cp,
                       document_date="2026-06-30", reception_date="2026-07-02",
                       lines=[pl(base, "IVA_21", "608", description="Devolucion de montaje defectuoso",
                                 project="PRJ-ALFA")],
                       taxes=[pt("IVA_21", base, cuota)], total=total,
                       description="Abono por devolucion parcial de F-2026-0001",
                       rectifies={"documentNumber": "F-2026-0001", "entryId": "ENTRY-C01",
                                  "reason": "DEVOLUCION", "mode": "DIFERENCIAS"}),
        overrides={
            "RC-13": {"message": "el documento venia con total -242,00 EUR y docKind FACTURA_RECIBIDA: "
                                 "se reclasifica a ABONO_RECIBIDO con valores absolutos",
                      "evidence": {"totalLeido": -24200, "totalNormalizado": total,
                                   "docKindLeido": "FACTURA_RECIBIDA", "docKindNormalizado": "ABONO_RECIBIDO"},
                      "fields": ["docKind", "totalCents"]},
            "RC-21": {"message": "rectificativa con documento rectificado, causa DEVOLUCION y modo "
                                 "DIFERENCIAS; el asiento original esta resuelto",
                      "evidence": {"documentNumber": "F-2026-0001", "entryId": "ENTRY-C01",
                                   "reason": "DEVOLUCION", "mode": "DIFERENCIAS"},
                      "fields": ["rectifies"]},
            "RC-02": {"message": "cuota declarada 4 200 = recalculada sobre 20 000 al 21 %",
                      "evidence": {"IVA_21": {"declarada": 4200, "recalculada": 4200, "desvio": 0}}},
        },
        confianza={
            "docKind": conf("calculado", "interpretacion_ia", "RC-13"),
            "counterparty.taxId": conf("llm", "verificado", "RC-11"),
            "lines[0].baseCents": conf("llm", "verificado", "RC-01"),
            "lines[0].accountCode": conf("catalogo", "interpretacion_ia", "RC-07"),
            "taxes[IVA_21].quotaCents": conf("llm", "verificado", "RC-02"),
            "totalCents": conf("calculado", "calculado", "RC-13"),
            "rectifies.mode": conf("usuario", "verificado", "RC-21"),
            "rectifies.reason": conf("usuario", "verificado", "RC-21"),
        },
        asiento=entry("ABONO_RECIBIDO", source_type="INVOICE_IN", entry_date="2026-06-30",
                      document_date="2026-06-30", reception_date="2026-07-02", operation_date=None,
                      lines=[
                          line("400", debit=total, description="Talleres Duero SL - abono",
                               account_key="PROVEEDORES"),
                          line("608", credit=base, description="Devolucion de compras y operaciones similares",
                               tax_rate_code="IVA_21", deductibility="FULL", project_id="PRJ-ALFA"),
                          line("472", credit=cuota, description="Rectificacion de IVA soportado 21 %",
                               tax_rate_code="IVA_21", account_key="IVA_SOPORTADO"),
                      ],
                      payable_blocks=[{"payableKey": "PROVEEDORES", "accountCode": "400",
                                       "baseCents": base, "quotaCents": cuota, "amountCents": total}],
                      tax_overrides=[{"taxRateCode": "IVA_21", "quotaCents": cuota}],
                      notas=["608 y no 607 en negativo: el PGC tiene cuenta propia para la devolucion "
                             "de compras, y una linea negativa en 607 falsearia el consumo del "
                             "epigrafe 4.c) de la PyG.",
                             "El 472 va al HABER: minora la cuota deducible del 3T (periodo de la "
                             "recepcion, 2026-07-02), no la del 2T de la factura original."]),
        libro_registro=libro("RECIBIDAS", base=-base, cuota_total=-cuota, deducible=-cuota),
    )


def caso_07() -> dict[str, Any]:
    base_orig, cuota_orig = 100_000, 21_000
    base_nueva, cuota_nueva = 80_000, 16_800
    dif_base, dif_cuota = base_orig - base_nueva, cuota_orig - cuota_nueva
    dif_total = dif_base + dif_cuota                       # 24 200
    total_leido = base_nueva + cuota_nueva                 # 96 800
    cp = CONTRAPARTES["CP-ES-CLIENTE"]
    return mk(
        cid="C07", slug="rectificativa-por-sustitucion",
        titulo="Abono emitido por SUSTITUCION: se contabiliza la diferencia, no el importe rectificado",
        cubre=["§5.3 caso 7", "criterio 9 (primera mitad)", "criterio 18 (serie rectificativa)"],
        fundamento="art. 15.4 RD 1619/2012 (serie especial) y art. 13 RD 1619/2012 (la rectificativa "
                   "por sustitucion expresa el importe RECTIFICADO, no la diferencia). ADR-0014 D12: "
                   "contabilizar 80 000 duplicaria la operacion.",
        cp=cp,
        prop=propuesta(doc_kind="ABONO_EMITIDO", number="R2026/0003", cp=cp,
                       document_date="2026-07-15", reception_date=None,
                       lines=[pl(base_nueva, "IVA_21", "705", description="Servicios de julio (importe rectificado)",
                                 project="PRJ-BETA")],
                       taxes=[pt("IVA_21", base_nueva, cuota_nueva)], total=total_leido,
                       description="Rectificativa por sustitucion de FV2026/0041",
                       rectifies={"documentNumber": "FV2026/0041", "entryId": "ENTRY-FV41",
                                  "reason": "DEVOLUCION", "mode": "SUSTITUCION"},
                       serie={"code": "RECT", "kind": "RECTIFICATIVA", "number": "R2026/0003"}),
        overrides={
            "RC-21": {"message": "modo SUSTITUCION con el asiento rectificado resuelto: se contabiliza "
                                 "la diferencia de 24 200 (base 20 000 + cuota 4 200), no los 96 800 leidos",
                      "evidence": {"documentNumber": "FV2026/0041", "entryId": "ENTRY-FV41",
                                   "mode": "SUSTITUCION",
                                   "original": {"baseCents": base_orig, "quotaCents": cuota_orig},
                                   "rectificado": {"baseCents": base_nueva, "quotaCents": cuota_nueva},
                                   "diferencia": {"baseCents": dif_base, "quotaCents": dif_cuota,
                                                  "totalCents": dif_total}},
                      "fields": ["rectifies", "lines[0].baseCents", "taxes.IVA_21.quotaCents"]},
            "RC-02": {"message": "cuota rectificada 16 800 = recalculada sobre 80 000 al 21 %",
                      "evidence": {"IVA_21": {"declarada": 16800, "recalculada": 16800, "desvio": 0}}},
            "RC-03": {"message": "80 000 + 16 800 = 96 800 declarados, tolerancia 0",
                      "evidence": {"bases": base_nueva, "cuotas": cuota_nueva, "total": total_leido}},
        },
        confianza={
            "counterparty.taxId": conf("llm", "verificado", "RC-11"),
            "receptionDate": conf("calculado", "calculado", "RC-05"),
            "lines[0].baseCents": conf("llm", "verificado", "RC-01"),
            "lines[0].accountCode": conf("catalogo", "interpretacion_ia", "RC-07"),
            "taxes[IVA_21].quotaCents": conf("llm", "verificado", "RC-02"),
            "totalCents": conf("llm", "verificado", "RC-03"),
            "asiento.diferenciaBaseCents": conf("calculado", "calculado", "RC-21"),
            "asiento.diferenciaCuotaCents": conf("calculado", "calculado", "RC-21"),
            "rectifies.mode": conf("usuario", "verificado", "RC-21"),
        },
        asiento=entry("ABONO_EMITIDO", source_type="INVOICE_OUT", entry_date="2026-07-15",
                      document_date="2026-07-15", reception_date=None, operation_date=None,
                      lines=[
                          line("708", debit=dif_base, description="Devoluciones de ventas - rectificacion "
                                                                  "por sustitucion de FV2026/0041",
                               tax_rate_code="IVA_21", project_id="PRJ-BETA"),
                          line("477", debit=dif_cuota, description="Rectificacion de IVA repercutido 21 %",
                               tax_rate_code="IVA_21", account_key="IVA_REPERCUTIDO"),
                          line("430", credit=dif_total, description="Constructora del Ebro SA",
                               account_key="CLIENTES"),
                      ],
                      tax_overrides=[{"taxRateCode": "IVA_21", "quotaCents": dif_cuota}],
                      notas=["El test debe fallar si contabiliza 80 000: la factura original ya esta "
                             "en el diario y sustituirla sin restar duplicaria el ingreso.",
                             "Numero tomado de la serie RECTIFICATIVA (art. 15.4 RD 1619/2012), no de "
                             "la ordinaria."]),
        libro_registro=libro("EMITIDAS", base=-dif_base, cuota_total=-dif_cuota, repercutida=-dif_cuota),
    )


def caso_08() -> dict[str, Any]:
    base, cuota, total_leido = 100_000, 21_000, 121_000
    cp = CONTRAPARTES["CP-ES-ABOGADO"]
    retencion = apply_bps(base, TAX_RATES["IRPF_15"]["rateBps"])   # 15 000
    liquido = base + cuota - retencion                              # 106 000
    return mk(
        cid="C08", slug="profesional-sin-mencion-de-retencion",
        titulo="Factura de profesional SIN mencion de retencion: se practica la del regimen de la contraparte",
        cubre=["§5.3 caso 8", "criterio 11", "I-E8-17 (puente al modelo 111)"],
        fundamento="arts. 99 y 101 LIRPF y art. 76 RIRPF: retener es obligacion del PAGADOR, "
                   "exista o no mencion en la factura. ADR-0014 D11: la retencion la fija "
                   "Counterparty.withholdingRegime, no el PDF.",
        cp=cp,
        prop=propuesta(doc_kind="FACTURA_RECIBIDA", number="2026-014", cp=cp,
                       document_date="2026-02-20", reception_date="2026-02-25",
                       lines=[pl(base, "IVA_21", "623", description="Direccion letrada", ceco="CC-ADM")],
                       taxes=[pt("IVA_21", base, cuota)], total=total_leido,
                       description="Honorarios de abogada, sin retencion en el documento",
                       withholding={"rateCode": "IRPF_15", "quotaCents": retencion},
                       readWithholding=None),
        overrides={
            "RC-03": {"message": "100 000 de base + 21 000 de cuota - 0 de retencion LEIDA = 121 000; "
                                 "la identidad interna usa lo leido, no lo configurado",
                      "evidence": {"bases": base, "cuotas": cuota, "retencionLeida": 0,
                                   "total": total_leido, "desvio": 0}},
            "RC-19": {"status": "WARN", "blocksBatch": True,
                      "message": "esta factura deberia llevar retencion del 15 %; solicite factura "
                                 "rectificada. Se practica la retencion del regimen (15 000) y se "
                                 "abona a 4751",
                      "evidence": {"regimen": "PROFESIONAL", "rateCode": "IRPF_15", "rateBps": 1500,
                                   "baseRetencion": base, "retencionConfigurada": retencion,
                                   "retencionLeida": None, "modelo": "111"},
                      "fields": ["withholding", "readWithholding"]},
            "RC-02": {"message": "cuota declarada 21 000 = recalculada sobre 100 000 al 21 %",
                      "evidence": {"IVA_21": {"declarada": 21000, "recalculada": 21000, "desvio": 0}}},
            "RC-11": {"message": "NIF ES 12345678Z valido (modulo 23) con ficha en el maestro",
                      "evidence": {"rama": "ES", "checksum": "VALIDO", "enMaestro": True}},
        },
        confianza={
            "counterparty.taxId": conf("llm", "verificado", "RC-11"),
            "lines[0].baseCents": conf("llm", "verificado", "RC-01"),
            "lines[0].accountCode": conf("catalogo", "interpretacion_ia", "RC-07"),
            "taxes[IVA_21].quotaCents": conf("llm", "verificado", "RC-02"),
            "totalCents": conf("llm", "verificado", "RC-03"),
            "withholding.quotaCents": conf("calculado", "calculado", "RC-19"),
            "readWithholding": conf("llm", "no_verificado", "RC-19"),
        },
        sellos=["RETENCION_NO_PRACTICADA"],
        asiento=entry("FACTURA_RECIBIDA", source_type="INVOICE_IN", entry_date="2026-02-20",
                      document_date="2026-02-20", reception_date="2026-02-25", operation_date=None,
                      lines=[
                          line("623", debit=base, description="Servicios de profesionales independientes",
                               tax_rate_code="IVA_21", deductibility="FULL", cost_center_id="CC-ADM"),
                          line("472", debit=cuota, description="IVA soportado 21 %",
                               tax_rate_code="IVA_21", account_key="IVA_SOPORTADO"),
                          line("410", credit=liquido, description="Marta Ruiz Salas - liquido a pagar",
                               account_key="ACREEDORES"),
                          line("4751", credit=retencion, description="Retencion IRPF 15 % (modelo 111)",
                               tax_rate_code="IRPF_15", account_key="IRPF_PROFESIONALES_A_PAGAR"),
                      ],
                      payable_blocks=[{"payableKey": "ACREEDORES", "accountCode": "410",
                                       "baseCents": base, "quotaCents": cuota,
                                       "retencionCents": retencion, "amountCents": liquido}],
                      tax_overrides=[{"taxRateCode": "IVA_21", "quotaCents": cuota}],
                      notas=["El proveedor cobra 106 000 aunque su factura diga 121 000. Ese es el "
                             "punto: la retencion no es negociable con el documento.",
                             "La clave de cuenta sale del TaxKind/subtipo del regimen: PROFESIONAL -> "
                             "IRPF_PROFESIONALES_A_PAGAR -> modelo 111. Un ARRENDADOR habria ido a "
                             "IRPF_ALQUILERES_A_PAGAR -> modelo 115, misma cuenta 4751 con otro taxRateId."]),
        libro_registro=libro("RECIBIDAS", base=base, cuota_total=cuota, deducible=cuota),
        notas=["retencionesModelo111Cents: 15000 - lo que I-E8-17 cuadra con el abono a 4751."],
    )


def caso_09() -> dict[str, Any]:
    honorarios, cuota = 100_000, 21_000
    suplido = 30_000
    retencion = apply_bps(honorarios, 1500)                 # 15 000 sobre 100 000, NO sobre 130 000
    total = honorarios + cuota + suplido - retencion        # 136 000
    liquido = honorarios + cuota + suplido - retencion      # 136 000 a 410
    cp = CONTRAPARTES["CP-ES-ABOGADO"]
    return mk(
        cid="C09", slug="factura-con-suplido",
        titulo="Factura de profesional con SUPLIDO: fuera de base, de cuota y de base de retencion",
        cubre=["§5.3 caso 9", "criterio 12", "RC-20"],
        fundamento="art. 78.Tres.3o LIVA: las sumas pagadas en nombre y por cuenta del cliente, con "
                   "mandato expreso y justificante a su nombre, no forman parte de la base imponible. "
                   "art. 75 RIRPF: la retencion se practica sobre los ingresos integros, sin suplidos.",
        cp=cp,
        prop=propuesta(doc_kind="FACTURA_RECIBIDA", number="2026-031", cp=cp,
                       document_date="2026-09-05", reception_date="2026-09-08",
                       lines=[pl(honorarios, "IVA_21", "623", description="Honorarios de procedimiento",
                                 ceco="CC-ADM"),
                              pl(suplido, None, "631", kind="SUPLIDO",
                                 description="Tasa judicial abonada por cuenta del cliente",
                                 ceco="CC-ADM", deductibility=None)],
                       taxes=[pt("IVA_21", honorarios, cuota)], total=total,
                       description="Honorarios con tasa judicial como suplido",
                       withholding={"rateCode": "IRPF_15", "quotaCents": retencion},
                       readWithholding={"rateBps": 1500, "quotaCents": retencion}),
        overrides={
            "RC-01": {"message": "solo la linea OPERACION suma base: 100 000. El suplido de 30 000 "
                                 "queda fuera",
                      "evidence": {"baseOperacion": honorarios, "suplidos": suplido,
                                   "noSujetos": 0, "baseDeclarada": honorarios}},
            "RC-03": {"message": "100 000 + 21 000 + 30 000 - 15 000 = 136 000 declarados, tolerancia 0",
                      "evidence": {"bases": honorarios, "cuotas": cuota, "suplidos": suplido,
                                   "retencion": retencion, "total": total, "desvio": 0}},
            "RC-19": {"message": "retencion leida 15 000 = la del regimen PROFESIONAL al 15 %",
                      "evidence": {"retencionLeida": retencion, "retencionConfigurada": retencion,
                                   "baseRetencion": honorarios, "modelo": "111"}},
            "RC-20": {"message": "el suplido queda fuera de Sigma bases, de la base de la cuota y de la "
                                 "base de la retencion, y dentro del total",
                      "evidence": {"suplidoCents": suplido, "baseCuota": honorarios,
                                   "baseRetencion": honorarios, "enTotal": True},
                      "fields": ["lines[1].kind"]},
            "RC-02": {"message": "cuota declarada 21 000 = recalculada sobre 100 000 al 21 % "
                                 "(el suplido no entra en la base)",
                      "evidence": {"IVA_21": {"declarada": 21000, "recalculada": 21000, "desvio": 0}}},
        },
        confianza={
            "counterparty.taxId": conf("llm", "verificado", "RC-11"),
            "lines[0].baseCents": conf("llm", "verificado", "RC-01"),
            "lines[1].baseCents": conf("llm", "verificado", "RC-20"),
            "lines[1].kind": conf("usuario", "verificado", "RC-20"),
            "lines[0].accountCode": conf("catalogo", "interpretacion_ia", "RC-07"),
            "lines[1].accountCode": conf("catalogo", "interpretacion_ia", "RC-07"),
            "taxes[IVA_21].quotaCents": conf("llm", "verificado", "RC-02"),
            "totalCents": conf("llm", "verificado", "RC-03"),
            "withholding.quotaCents": conf("calculado", "calculado", "RC-19"),
        },
        asiento=entry("FACTURA_RECIBIDA", source_type="INVOICE_IN", entry_date="2026-09-05",
                      document_date="2026-09-05", reception_date="2026-09-08", operation_date=None,
                      lines=[
                          line("623", debit=honorarios, description="Honorarios de procedimiento",
                               tax_rate_code="IVA_21", deductibility="FULL", cost_center_id="CC-ADM"),
                          line("631", debit=suplido, description="Tasa judicial (suplido, sin IVA)",
                               cost_center_id="CC-ADM"),
                          line("472", debit=cuota, description="IVA soportado 21 % sobre honorarios",
                               tax_rate_code="IVA_21", account_key="IVA_SOPORTADO"),
                          line("410", credit=liquido, description="Marta Ruiz Salas - liquido a pagar",
                               account_key="ACREEDORES"),
                          line("4751", credit=retencion, description="Retencion IRPF 15 % sobre 100 000",
                               tax_rate_code="IRPF_15", account_key="IRPF_PROFESIONALES_A_PAGAR"),
                      ],
                      payable_blocks=[{"payableKey": "ACREEDORES", "accountCode": "410",
                                       "baseCents": honorarios + suplido, "quotaCents": cuota,
                                       "retencionCents": retencion, "amountCents": liquido}],
                      tax_overrides=[{"taxRateCode": "IVA_21", "quotaCents": cuota}],
                      notas=["El test falla si la retencion sale 19 500 (15 % de 130 000) o si RC-03 "
                             "da FAIL sobre un documento perfectamente correcto.",
                             "631 y no 623 para el suplido: la tasa judicial es un tributo, epigrafe "
                             "7.b) de la PyG, y su justificante esta a nuestro nombre."]),
        libro_registro=libro("RECIBIDAS", base=honorarios, cuota_total=cuota, deducible=cuota),
        notas=["retencionesModelo111Cents: 15000."],
    )


def caso_10() -> dict[str, Any]:
    base = 500_000
    cp = CONTRAPARTES["CP-CH-BIENES"]
    return mk(
        cid="C10", slug="importacion-tercer-pais",
        titulo="Factura de proveedor de tercer pais por bienes: base sin IVA, el DUA liquida la cuota",
        cubre=["§5.3 caso 10", "criterio 8 (primera parte: importacion != ISP)"],
        fundamento="arts. 17 y 18 LIVA: la importacion la devenga la Aduana, no el proveedor. El IVA "
                   "de importacion se soporta con el DUA (art. 97.Uno.3o LIVA), no con esta factura. "
                   "Autorrepercutir aqui inventaria una cuota devengada y una deducible sin soporte.",
        cp=cp,
        prop=propuesta(doc_kind="FACTURA_RECIBIDA_EXTRACOM", number="INV-CH-88214", cp=cp,
                       document_date="2026-08-12", reception_date="2026-08-20",
                       lines=[pl(base, "IVA_NO_SUJETO", "600", description="Componentes de precision",
                                 project="PRJ-GAMMA", deductibility=None)],
                       taxes=[pt("IVA_NO_SUJETO", base, 0, "NO_SUJETA")], total=base,
                       description="Compra de componentes a proveedor suizo"),
        overrides={
            "RC-06": {"message": "IVA_NO_SUJETO vigente: la operacion no esta sujeta a IVA espanol en "
                                 "sede del proveedor",
                      "evidence": {"taxRateCode": "IVA_NO_SUJETO", "rateBps": 0, "operationKey": "NO_SUJETA"}},
            "RC-11": {"message": "identificador suizo CHE-116.281.710: rama tercer pais, sin digito de "
                                 "control verificable; nunca FAIL",
                      "evidence": {"rama": "TERCER_PAIS", "countryCode": "CH", "checksum": "NO_APLICA",
                                   "enMaestro": True},
                      "fields": ["counterparty.taxId"]},
            "RC-22": {"status": "WARN", "blocksBatch": True,
                      "message": "no es inversion del sujeto pasivo: es una importacion. El IVA lo "
                                 "liquida el DUA y se contabilizara con su propio documento (T-20/E9)",
                      "evidence": {"docKind": "FACTURA_RECIBIDA_EXTRACOM",
                                   "precondicionesIsp": {"paisUeConVies": False, "ausenciaDeCuota": True,
                                                         "mencionLegalArt61m": False, "roiRegistered": True},
                                   "cuotaEnEsteAsiento": 0},
                      "fields": ["docKind"]},
        },
        confianza={
            "docKind": conf("usuario", "verificado", "RC-22"),
            "counterparty.taxId": conf("llm", "interpretacion_ia", "RC-11"),
            "lines[0].baseCents": conf("llm", "verificado", "RC-01"),
            "lines[0].accountCode": conf("catalogo", "interpretacion_ia", "RC-07"),
            "totalCents": conf("llm", "verificado", "RC-03"),
        },
        asiento=entry("FACTURA_RECIBIDA", source_type="INVOICE_IN", entry_date="2026-08-12",
                      document_date="2026-08-12", reception_date="2026-08-20", operation_date=None,
                      lines=[
                          line("600", debit=base, description="Componentes de precision (importacion)",
                               tax_rate_code="IVA_NO_SUJETO", project_id="PRJ-GAMMA"),
                          line("400", credit=base, description="Alpina Components AG",
                               account_key="PROVEEDORES"),
                      ],
                      payable_blocks=[{"payableKey": "PROVEEDORES", "accountCode": "400",
                                       "baseCents": base, "quotaCents": 0, "amountCents": base}],
                      notas=["NI 472 NI 477. El test falla si aparece cualquiera de las dos: seria "
                             "autorrepercutir una importacion.",
                             "Aranceles y gastos hasta el primer destino, cuando los haya, son mayor "
                             "coste de la mercancia (NRV 10a/2a), no gasto del periodo."]),
        libro_registro=libro("RECIBIDAS", base=base),
    )


def caso_11() -> dict[str, Any]:
    base = 300_000
    cuota = apply_bps(base, 2100)      # 63 000, tipo ESPANOL elegido por el usuario
    cp = CONTRAPARTES["CP-DE-AIB"]
    return mk(
        cid="C11", slug="aib-con-inversion-del-sujeto-pasivo",
        titulo="Adquisicion intracomunitaria de bienes con las cuatro precondiciones de ISP verificadas",
        cubre=["§5.3 caso 11", "criterio 8 (segunda parte)", "I-E8-18 (dos lineas del mismo taxRateId)"],
        fundamento="arts. 13, 15 y 71 LIVA (AIB) y art. 84.Uno.2o LIVA (inversion del sujeto pasivo). "
                   "El tipo es el ESPANOL del bien, elegido por el usuario, no el del pais de origen. "
                   "El devengado es integro: la prorrata, cuando la hay, solo minora el deducible.",
        cp=cp,
        prop=propuesta(doc_kind="FACTURA_RECIBIDA_ISP", number="NW-2026-4471", cp=cp,
                       document_date="2026-10-05", reception_date="2026-10-09",
                       lines=[pl(base, "IVA_21", "600", description="Piezas mecanizadas",
                                 project="PRJ-GAMMA")],
                       taxes=[pt("IVA_21", base, cuota, "AIB")], total=base,
                       description="AIB de bienes, factura sin cuota",
                       operationDate="2026-10-05"),
        overrides={
            "RC-03": {"message": "la factura del proveedor no repercute cuota: 300 000 de base = "
                                 "300 000 de total. La cuota de 63 000 es autorrepercutida y no forma "
                                 "parte del total del documento",
                      "evidence": {"bases": base, "cuotasEnDocumento": 0, "total": base,
                                   "cuotaAutorrepercutida": cuota, "desvio": 0}},
            "RC-06": {"message": "IVA_21 vigente a la fecha de devengo 2026-10-05 (art. 90.Dos LIVA); "
                                 "es el tipo espanol del bien, elegido por el usuario",
                      "evidence": {"taxRateCode": "IVA_21", "rateBps": 2100,
                                   "fechaDevengo": "2026-10-05", "origenDelTipo": "usuario"}},
            "RC-11": {"message": "NIF-IVA DE811907980 de formato valido y VIES afirmativo el 2026-10-02",
                      "evidence": {"rama": "UE", "countryCode": "DE", "formato": "VALIDO",
                                   "viesValid": True, "viesCheckedAt": "2026-10-02"},
                      "fields": ["counterparty.taxId"]},
            "RC-22": {"message": "las cuatro precondiciones de ISP se cumplen: pais UE con VIES fechado, "
                                 "ausencia de cuota en el documento, mencion legal del art. 6.1.m leida "
                                 "y organizacion en el ROI",
                      "evidence": {"paisUeConVies": True, "ausenciaDeCuota": True,
                                   "mencionLegalArt61m": True, "textoLeido": "Inversion del sujeto pasivo "
                                   "- art. 84.Uno.2o LIVA", "roiRegistered": True},
                      "fields": ["docKind"]},
        },
        confianza={
            "docKind": conf("usuario", "verificado", "RC-22"),
            "counterparty.taxId": conf("catalogo", "verificado", "RC-11"),
            "lines[0].baseCents": conf("llm", "verificado", "RC-01"),
            "lines[0].accountCode": conf("catalogo", "interpretacion_ia", "RC-07"),
            "taxes[IVA_21].quotaCents": conf("calculado", "calculado", "RC-02"),
            "taxes[IVA_21].taxRateCode": conf("usuario", "verificado", "RC-06"),
            "totalCents": conf("llm", "verificado", "RC-03"),
        },
        asiento=entry("FACTURA_RECIBIDA_ISP", source_type="INVOICE_IN", entry_date="2026-10-05",
                      document_date="2026-10-05", reception_date="2026-10-09",
                      operation_date="2026-10-05",
                      lines=[
                          line("600", debit=base, description="Piezas mecanizadas (AIB)",
                               tax_rate_code="IVA_21", deductibility="FULL", project_id="PRJ-GAMMA"),
                          line("472", debit=cuota, description="IVA soportado 21 % autorrepercutido (ISP)",
                               tax_rate_code="IVA_21", account_key="IVA_SOPORTADO_ISP"),
                          line("400", credit=base, description="Nordwerk Bauteile GmbH",
                               account_key="PROVEEDORES"),
                          line("477", credit=cuota, description="IVA repercutido 21 % autorrepercutido (ISP)",
                               tax_rate_code="IVA_21", account_key="IVA_REPERCUTIDO_ISP"),
                      ],
                      payable_blocks=[{"payableKey": "PROVEEDORES", "accountCode": "400",
                                       "baseCents": base, "quotaCents": 0, "amountCents": base}],
                      tax_overrides=[{"taxRateCode": "IVA_21", "quotaCents": cuota}],
                      notas=["Exactamente DOS lineas de IVA, ambas con el mismo taxRateId y el mismo "
                             "importe: efecto neto en tesoreria 0 (I-E8-18). La deuda con el "
                             "proveedor es SOLO la base.",
                             "El devengado de 63 000 es integro. Con prorrata configurada, el "
                             "deducible se minoraria y la diferencia engordaria la 600; el 477 "
                             "seguiria siendo 63 000."]),
        libro_registro=libro("RECIBIDAS", base=base, cuota_total=cuota, deducible=cuota,
                             devengada_isp=cuota),
        notas=["Este caso es el que obliga a que I-E8-15c incluya el termino de IVA devengado por "
               "ISP/AIB del libro registro de RECIBIDAS: el 477 de un ISP no procede de ninguna "
               "factura emitida. Ver `observacionesParaT14`."],
    )


def caso_12() -> dict[str, Any]:
    b21_usd, b10_usd = 500_000, 359_091
    q21_usd = apply_bps(b21_usd, 2100)      # 105 000
    q10_usd = apply_bps(b10_usd, 1000)      # 35 909
    total_usd = b21_usd + b10_usd + q21_usd + q10_usd    # 1 000 000
    rm = RATE_USD_EUR["rateMicro"]
    payable_eur = convert_with_rate_micro(total_usd, rm)
    b21_eur = convert_with_rate_micro(b21_usd, rm)
    b10_eur = convert_with_rate_micro(b10_usd, rm)
    cuotas_eur_total = payable_eur - b21_eur - b10_eur
    reparto = dict(hamilton(cuotas_eur_total, [("IVA_10", q10_usd), ("IVA_21", q21_usd)]))
    q21_eur, q10_eur = reparto["IVA_21"], reparto["IVA_10"]
    cp = CONTRAPARTES["CP-ES-SERVICIOS"]
    return mk(
        cid="C12", slug="factura-en-divisa-usd",
        titulo="Factura en USD: tasa persistida del documentDate, divisa en la linea y residuo cero por Hamilton",
        cubre=["§5.3 caso 12", "criterio 19 (divisa en la linea)", "criterio 20 (sin tasa no se inventa nada)",
               "I-E8-5", "I-E8-19"],
        fundamento="NRV 11a: la partida monetaria se reconoce al tipo de contado de la fecha de la "
                   "transaccion, que es la de expedicion. En el reconocimiento inicial NO hay "
                   "diferencia de cambio: el residuo se elimina por construccion (ADR-0014 D2) y "
                   "jamas se lleva a 669/769; su cuenta, si alguna vez procediera, seria 668/768.",
        cp=cp, rate=RATE_USD_EUR,
        prop=propuesta(doc_kind="FACTURA_RECIBIDA", number="SIN-2026-9002", cp=cp,
                       document_date="2026-11-20", reception_date="2026-11-23", currency="USD",
                       lines=[pl(b21_usd, "IVA_21", "600", description="Lote A de mercaderia",
                                 project="PRJ-GAMMA"),
                              pl(b10_usd, "IVA_10", "600", description="Lote B de mercaderia",
                                 project="PRJ-GAMMA")],
                       taxes=[pt("IVA_21", b21_usd, q21_usd), pt("IVA_10", b10_usd, q10_usd)],
                       total=total_usd, description="Factura en dolares, dos tipos"),
        overrides={
            "RC-02": {"message": "las dos cuotas en USD coinciden con el recalculo al centimo",
                      "evidence": {"IVA_21": {"declarada": q21_usd, "recalculada": apply_bps(b21_usd, 2100),
                                              "desvio": 0},
                                   "IVA_10": {"declarada": q10_usd, "recalculada": apply_bps(b10_usd, 1000),
                                              "desvio": 0}}},
            "RC-04": {"message": "USD es ISO-4217 con exponente 2 y es la unica moneda del documento",
                      "evidence": {"currency": "USD", "exponent": 2, "monedasDetectadas": ["USD"]}},
            "RC-14": {"message": "moneda distinta de la base con tasa persistida del 2026-11-20 "
                                 "(ECB_FRANKFURTER); confirmar hoy o dentro de un mes da el mismo asiento",
                      "evidence": {"currency": "USD", "baseCurrency": "EUR",
                                   "exchangeRateId": RATE_USD_EUR["id"], "rateMicro": rm,
                                   "rateDate": RATE_USD_EUR["date"], "source": RATE_USD_EUR["source"],
                                   "convertedTotalCents": payable_eur, "forzado": False},
                      "fields": ["currency", "convertedTotalCents"]},
        },
        confianza={
            "counterparty.taxId": conf("llm", "verificado", "RC-11"),
            "currency": conf("llm", "verificado", "RC-04"),
            "lines[0].baseCents": conf("llm", "verificado", "RC-01"),
            "lines[1].baseCents": conf("llm", "verificado", "RC-01"),
            "lines[0].accountCode": conf("catalogo", "interpretacion_ia", "RC-07"),
            "lines[1].accountCode": conf("catalogo", "interpretacion_ia", "RC-07"),
            "taxes[IVA_21].quotaCents": conf("llm", "verificado", "RC-02"),
            "taxes[IVA_10].quotaCents": conf("llm", "verificado", "RC-02"),
            "totalCents": conf("llm", "verificado", "RC-03"),
            "convertedTotalCents": conf("calculado", "calculado", "RC-14"),
            "asiento.cuotasEnMonedaBase": conf("calculado", "calculado", "RC-14"),
        },
        asiento=entry("FACTURA_RECIBIDA", source_type="INVOICE_IN", entry_date="2026-11-20",
                      document_date="2026-11-20", reception_date="2026-11-23", operation_date=None,
                      hash_version=3,
                      lines=[
                          line("600", debit=b21_eur, description="Lote A de mercaderia",
                               tax_rate_code="IVA_21", deductibility="FULL", project_id="PRJ-GAMMA"),
                          line("600", debit=b10_eur, description="Lote B de mercaderia",
                               tax_rate_code="IVA_10", deductibility="FULL", project_id="PRJ-GAMMA"),
                          line("472", debit=q21_eur, description="IVA soportado 21 % (convertido)",
                               tax_rate_code="IVA_21", account_key="IVA_SOPORTADO"),
                          line("472", debit=q10_eur, description="IVA soportado 10 % (convertido)",
                               tax_rate_code="IVA_10", account_key="IVA_SOPORTADO"),
                          line("400", credit=payable_eur, description="Servicios Integrales Nervion SA",
                               account_key="PROVEEDORES", original_currency="USD",
                               original_amount_cents=total_usd,
                               exchange_rate_id=RATE_USD_EUR["id"]),
                      ],
                      payable_blocks=[{"payableKey": "PROVEEDORES", "accountCode": "400",
                                       "baseCents": b21_eur + b10_eur,
                                       "quotaCents": q21_eur + q10_eur, "amountCents": payable_eur}],
                      tax_overrides=[{"taxRateCode": "IVA_10", "quotaCents": q10_eur},
                                     {"taxRateCode": "IVA_21", "quotaCents": q21_eur}],
                      notas=["Solo la linea MONETARIA (400) lleva originalCurrency / "
                             "originalAmountCents / exchangeRateId: es la unica partida que habra que "
                             "valorar al tipo de cierre (NRV 11a.2.1, motor de E9). Las lineas de "
                             "gasto y de IVA ya son no monetarias en euros.",
                             "El residuo de conversion lo absorben las CUOTAS por Hamilton con "
                             "desempate por menor codigo: Sigma bases + Sigma cuotas = el pasivo "
                             "convertido, exacto. Ni una linea de ajuste.",
                             "hashVersion = 3 (canonicalEntryFormV3). El ledgerHash financiero del "
                             "periodo no cambia respecto de un asiento equivalente en euros."]),
        libro_registro=libro("RECIBIDAS", base=b21_eur + b10_eur, cuota_total=q21_eur + q10_eur,
                             deducible=q21_eur + q10_eur),
        notas=["WARN informativo declarado y NO unificado (ADR-0014 D2): la base imponible en euros a "
               "efectos del art. 79.Once LIVA puede diferir en centimos de la base contable.",
               f"Reparto Hamilton: cuotas en EUR = {cuotas_eur_total} repartidos entre IVA_21 "
               f"({q21_eur}) e IVA_10 ({q10_eur}) por pesos {q21_usd}/{q10_usd}. Con estas cifras "
               f"el residuo frente a la conversion directa de cada cuota es "
               f"{cuotas_eur_total - convert_with_rate_micro(q21_usd, rm) - convert_with_rate_micro(q10_usd, rm)}: "
               "el reparto se declara igualmente porque es lo que garantiza el cuadre cuando NO es "
               "cero, y su desempate es por menor codigo."],
    )


def caso_13() -> dict[str, Any]:
    cp = CONTRAPARTES["CP-ES-SERVICIOS"]
    base, cuota, total = 480_000, 100_800, 580_800
    return mk(
        cid="C13", slug="extraccion-parcial",
        titulo="Extraccion parcial: el modelo vio 4 de 9 paginas y el run NO puede respaldar un asiento",
        cubre=["§5.3 caso 13", "criterio 23", "G-02", "I-E8-10", "RC-09"],
        fundamento="P4 y G-02 de la SPEC-FIABILIDAD: una lectura incompleta no puede producir un "
                   "campo calculado ni verificado. ADR-0014 D5 / O-20.3: para contabilizar hay que "
                   "teclear las cifras, y eso crea un ExtractionRun MANUAL nuevo.",
        cp=cp,
        run={"kind": "LLM", "pagesAnalyzed": 4, "pagesTotal": 9, "partial": True},
        prop=propuesta(doc_kind="FACTURA_RECIBIDA", number="SIN-2026-9101", cp=cp,
                       document_date="2026-12-01", reception_date="2026-12-02",
                       lines=[pl(base, "IVA_21", "629", description="Servicios de diciembre (parcial)",
                                 ceco="CC-ADM")],
                       taxes=[pt("IVA_21", base, cuota)], total=total,
                       description="Documento de 9 paginas con 4 analizadas", pages=(4, 9)),
        overrides={
            "RC-09": {"status": "FAIL", "blocksBatch": True,
                      "message": "el modelo vio 4 de 9 paginas: este documento no puede contabilizarse "
                                 "desde la extraccion automatica. Revise y teclee las cifras y se "
                                 "registrara como revision humana",
                      "evidence": {"pagesAnalyzed": 4, "pagesTotal": 9, "partial": True,
                                   "runKind": "LLM", "postError": "PARTIAL_RUN_CANNOT_POST"},
                      "fields": ["*"]},
            "RC-01": {"status": "WARN", "blocksBatch": True,
                      "message": "las bases suman la base declarada de las paginas leidas, pero faltan "
                                 "cinco paginas: el resultado no es concluyente",
                      "evidence": {"paginasNoLeidas": 5}},
            "RC-16": {"message": "la propuesta es reproducible, pero ningun campo alcanza calculado ni "
                                 "verificado por RC-09"},
        },
        confianza={
            "docKind": conf("llm", "no_verificado", "RC-09"),
            "documentNumber": conf("llm", "no_verificado", "RC-09"),
            "counterparty.name": conf("llm", "no_verificado", "RC-09"),
            "counterparty.taxId": conf("llm", "no_verificado", "RC-09"),
            "documentDate": conf("llm", "no_verificado", "RC-09"),
            "receptionDate": conf("usuario", "no_verificado", "RC-09"),
            "currency": conf("llm", "no_verificado", "RC-09"),
            "lines[0].baseCents": conf("llm", "no_verificado", "RC-09"),
            "lines[0].accountCode": conf("catalogo", "no_verificado", "RC-09"),
            "taxes[IVA_21].quotaCents": conf("llm", "no_verificado", "RC-09"),
            "totalCents": conf("llm", "no_verificado", "RC-09"),
        },
        post_error="PARTIAL_RUN_CANNOT_POST",
        asiento=None,
        sellos=["PROPUESTA_NO_RECONCILIADA"],
        libro_registro=libro("NINGUNO"),
        notas=["I-E8-10: partial = true implica ningun campo calculado ni verificado, ausencia del "
               "lote y ningun asiento que lo referencie.",
               "Camino de salida: el EDITOR teclea las cifras, se crea un ExtractionRun kind = MANUAL "
               "con parentRunId apuntando a este, sus campos son de origen usuario y ESE si postea. "
               "El run del LLM queda intacto byte a byte (criterio 28)."],
    )


def caso_14() -> dict[str, Any]:
    base, cuota, total = 1_000_000, 210_000, 1_210_000
    cp = CONTRAPARTES["CP-ES-CLIENTE"]
    return mk(
        cid="C14", slug="anticipo-cliente-sin-cobro",
        titulo="Factura de anticipo de cliente SIN cobro registrado: asiento 430 / 438 sin linea de 477",
        cubre=["§R2.3 caso extra 1 (O-23)", "criterio 32", "RC-25", "I-E8-15c"],
        fundamento="art. 75.Dos LIVA: en los pagos anticipados el impuesto se devenga en el momento "
                   "del cobro total o parcial del precio por los importes efectivamente percibidos. "
                   "Repercutir al expedir anticipa el ingreso a Hacienda y descuadra las casillas "
                   "01-03 del 303 del trimestre.",
        cp=cp,
        prop=propuesta(doc_kind="FACTURA_ANTICIPO_CLIENTE", number="FV2026/0088", cp=cp,
                       document_date="2026-12-10", reception_date=None,
                       lines=[pl(base, "IVA_21", "705", description="Anticipo del 30 % del proyecto Beta",
                                 project="PRJ-BETA")],
                       taxes=[pt("IVA_21", base, cuota)], total=total,
                       description="Factura de anticipo emitida antes de cobrar",
                       advanceEntryId=None,
                       dueSchedule=[{"dueDate": "2026-12-31", "amountCents": total}],
                       serie={"code": "FV", "kind": "ORDINARIA", "number": "FV2026/0088"}),
        overrides={
            "RC-25": {"status": "WARN", "blocksBatch": True,
                      "message": "factura de anticipo sin cobro registrado: el IVA no devenga todavia "
                                 "(art. 75.Dos LIVA). Se contabiliza 430 contra 438 sin linea de 477; "
                                 "el devengo llegara con el cobro (T-08)",
                      "evidence": {"advanceEntryId": None, "cobroEfectivo": False,
                                   "cuotaDelDocumento": cuota, "cuotaContabilizada": 0,
                                   "devengaraCon": "T-08 COBRO_CLIENTE"},
                      "fields": ["taxes.IVA_21.quotaCents", "advanceEntryId"]},
            "RC-02": {"message": "la cuota del documento (210 000) coincide con el recalculo, pero su "
                                 "devengo se difiere al cobro por RC-25",
                      "evidence": {"IVA_21": {"declarada": cuota, "recalculada": cuota, "desvio": 0,
                                              "contabilizadaAhora": 0}}},
            "RC-23": {"message": "no se aplica anticipo alguno: esta factura CREA el anticipo, no lo consume",
                      "evidence": {"appliedAdvanceCents": 0, "appliedAdvanceTaxCents": 0}},
        },
        confianza={
            "counterparty.taxId": conf("llm", "verificado", "RC-11"),
            "receptionDate": conf("calculado", "calculado", "RC-05"),
            "lines[0].baseCents": conf("llm", "verificado", "RC-01"),
            "lines[0].accountCode": conf("catalogo", "interpretacion_ia", "RC-07"),
            "taxes[IVA_21].quotaCents": conf("llm", "no_verificado", "RC-25"),
            "totalCents": conf("llm", "verificado", "RC-03"),
        },
        sellos=["IVA_PERIODO_DESPLAZADO"],
        asiento=entry("FACTURA_EMITIDA_SERVICIOS", source_type="INVOICE_OUT",
                      entry_date="2026-12-10", document_date="2026-12-10", reception_date=None,
                      operation_date=None,
                      lines=[
                          line("430", debit=total, description="Constructora del Ebro SA - anticipo facturado",
                               account_key="CLIENTES"),
                          line("438", credit=total, description="Anticipos de clientes - proyecto Beta",
                               account_key="ANTICIPOS_CLIENTES"),
                      ],
                      notas=["SIN linea de 477 y SIN linea de 705: no hay ingreso devengado ni IVA "
                             "repercutido. El test falla si aparece cualquiera de los dos.",
                             "Cuando se cobre, T-08 llevara 572 contra 430 y ES ENTONCES cuando nace "
                             "el 477 de 210 000, con la fecha del cobro. I-E8-15c cuadrara con el "
                             "libro registro de emitidas del trimestre DEL COBRO."]),
        libro_registro=libro("EMITIDAS"),
        notas=["El libro registro de emitidas anota este documento sin cuota devengada: la anotacion "
               "de la cuota corresponde al periodo del cobro. Por eso repercutida = 0."],
    )


def caso_15() -> dict[str, Any]:
    base = 250_000
    cp = CONTRAPARTES["CP-US-CONSULT"]
    return mk(
        cid="C15", slug="proveedor-tercer-pais-sin-checksum",
        titulo="Proveedor de tercer pais con identificador fiscal sin digito de control: RC-11 nunca falla",
        cubre=["§R2.3 caso extra 2 (O-25)", "criterio 33 (tercera rama)",
               "criterio 8 (ISP sin precondiciones -> no ISP)"],
        fundamento="art. 6.1.c RD 1619/2012 exige el NIF del expedidor, pero el modulo 23 y la letra "
                   "de CIF son reglas del NIF ESPANOL. Un EIN estadounidense no tiene digito de "
                   "control verificable: aplicarselo bloquearia toda factura de tercer pais.",
        cp=cp,
        prop=propuesta(doc_kind="FACTURA_RECIBIDA_EXTRACOM", number="HA-2026-1177", cp=cp,
                       document_date="2026-12-15", reception_date="2026-12-18",
                       lines=[pl(base, "IVA_NO_SUJETO", "629", description="Consultoria estrategica",
                                 ceco="CC-ADM", deductibility=None)],
                       taxes=[pt("IVA_NO_SUJETO", base, 0, "NO_SUJETA")], total=base,
                       description="Servicios de consultoria de proveedor estadounidense",
                       docKindSugeridoPorElModelo="FACTURA_RECIBIDA_ISP"),
        overrides={
            "RC-11": {"message": "identificador estadounidense 98-7654321 (EIN): rama tercer pais, "
                                 "identificador libre sin checksum. Nunca FAIL; confianza "
                                 "interpretacion_ia",
                      "evidence": {"rama": "TERCER_PAIS", "countryCode": "US",
                                   "checksum": "NO_APLICA", "vacio": False, "enMaestro": True},
                      "fields": ["counterparty.taxId"]},
            "RC-22": {"status": "WARN", "blocksBatch": True,
                      "message": "el modelo sugirio inversion del sujeto pasivo, pero faltan dos "
                                 "precondiciones (VIES y mencion legal del art. 6.1.m): no se "
                                 "autorrepercute. Decide el usuario",
                      "evidence": {"docKindSugerido": "FACTURA_RECIBIDA_ISP",
                                   "precondicionesIsp": {"paisUeConVies": False, "ausenciaDeCuota": True,
                                                         "mencionLegalArt61m": False, "roiRegistered": True},
                                   "docKindResuelto": "FACTURA_RECIBIDA_EXTRACOM",
                                   "cuotaAutorrepercutida": 0},
                      "fields": ["docKind"]},
            "RC-06": {"message": "IVA_NO_SUJETO vigente: sin las precondiciones de ISP no hay cuota "
                                 "espanola que devengar en este asiento",
                      "evidence": {"taxRateCode": "IVA_NO_SUJETO", "rateBps": 0}},
        },
        confianza={
            "docKind": conf("usuario", "verificado", "RC-22"),
            "counterparty.taxId": conf("llm", "interpretacion_ia", "RC-11"),
            "lines[0].baseCents": conf("llm", "verificado", "RC-01"),
            "lines[0].accountCode": conf("catalogo", "interpretacion_ia", "RC-07"),
            "totalCents": conf("llm", "verificado", "RC-03"),
        },
        asiento=entry("FACTURA_RECIBIDA", source_type="INVOICE_IN", entry_date="2026-12-15",
                      document_date="2026-12-15", reception_date="2026-12-18", operation_date=None,
                      lines=[
                          line("629", debit=base, description="Consultoria estrategica (proveedor no "
                                                              "establecido, sin cuota espanola)",
                               tax_rate_code="IVA_NO_SUJETO", cost_center_id="CC-ADM"),
                          line("410", credit=base, description="Harborline Advisors LLC",
                               account_key="ACREEDORES"),
                      ],
                      payable_blocks=[{"payableKey": "ACREEDORES", "accountCode": "410",
                                       "baseCents": base, "quotaCents": 0, "amountCents": base}],
                      notas=["El test falla si una factura de tercer pais queda bloqueada por el "
                             "digito de control: RC-11 no puede dar FAIL en esta rama.",
                             "Tampoco hay ISP: la sugerencia del modelo no basta. Calificar la "
                             "operacion es del usuario y de la organizacion (ADR-0014 D11)."]),
        libro_registro=libro("RECIBIDAS", base=base),
        notas=["Si el usuario decidiese que si procede la inversion del sujeto pasivo del art. "
               "84.Uno.2o, tendria que aportar la mencion legal y elegir el tipo espanol; el asiento "
               "pasaria a ser el de C11. Eso es un acto humano, no una inferencia."],
    )


for _f in (caso_01, caso_02, caso_03, caso_04, caso_05, caso_06, caso_07, caso_08,
           caso_09, caso_10, caso_11, caso_12, caso_13, caso_14, caso_15):
    add(_f())


# ---------------------------------------------------------------------------
# Casos negativos: variantes declarativas sobre un caso base
# ---------------------------------------------------------------------------

CASOS_NEGATIVOS: list[dict[str, Any]] = [
    {
        "id": "N01", "casoBase": "C01", "titulo": "NIF espanol con digito de control invalido",
        "mutacion": {"counterparty.taxId": "B12345675"},
        "esperado": {"check": "RC-11", "status": "FAIL", "blocksBatch": True,
                     "reconcileStatus": "FAIL", "postError": "PROPOSAL_NOT_RECONCILED",
                     "asiento": None,
                     "message": "NIF B12345675: digito de control incorrecto (esperado 4). Sin NIF "
                                "valido la factura no cumple el art. 6.1.c RD 1619/2012 y su cuota "
                                "no es deducible"},
        "fundamento": "criterio 24 y O-20.2: FAIL, no WARN. El test falla si degrada a WARN.",
    },
    {
        "id": "N02", "casoBase": "C01", "titulo": "Factura defectuosa: no cuadra consigo misma",
        "mutacion": {"totalCents": 119_900},
        "esperado": {"check": "RC-03", "status": "FAIL", "blocksBatch": True,
                     "reconcileStatus": "FAIL", "postError": "PROPOSAL_NOT_RECONCILED",
                     "asiento": None,
                     "message": "100 000 de base + 21 000 de cuota = 121 000, y el documento declara "
                                "119 900: faltan 1 100 centimos. Se pide factura corregida, no se "
                                "ajusta con un asiento"},
        "fundamento": "criterio 1 y art. 6 RD 1619/2012. Tolerancia 0 y NO forzable: el forzado "
                      "existe para el duplicado, el convertedTotal y el ticket cualificado, jamas "
                      "para una cifra aritmetica (R6).",
    },
    {
        "id": "N03", "casoBase": "C01", "titulo": "Tres lineas de 333,33 contra una base declarada de 1 000,00",
        "mutacion": {"lines": "tres lineas OPERACION de 33 333 al 21 %", "taxes[IVA_21].baseCents": 100_000},
        "esperado": {"check": "RC-01", "status": "FAIL", "blocksBatch": True,
                     "reconcileStatus": "FAIL", "postError": "PROPOSAL_NOT_RECONCILED",
                     "asiento": None,
                     "message": "las bases suman 99 999 y el documento declara 100 000: falta 1 centimo",
                     "evidence": {"sumaBases": 99_999, "baseDeclarada": 100_000, "desvio": -1}},
        "fundamento": "criterio 2: la tolerancia de RC-01 es 0 y el mensaje nombra el centimo exacto.",
    },
    {
        "id": "N04", "casoBase": "C02", "titulo": "Cuota del emisor desviada 5 centimos, por encima de la tolerancia",
        "mutacion": {"taxes[IVA_21].quotaCents": 21_005},
        "esperado": {"check": "RC-02", "status": "FAIL", "blocksBatch": True,
                     "reconcileStatus": "FAIL", "postError": "PROPOSAL_NOT_RECONCILED",
                     "asiento": None,
                     "message": "la cuota declarada 21 005 se aparta 5 centimos del recalculo 21 000, "
                                "por encima de TOLERANCIA_CUOTA_IVA_CENTS = 1: tipo mal leido o "
                                "factura defectuosa",
                     "evidence": {"declarada": 21_005, "recalculada": 21_000, "desvio": 5,
                                  "tolerancia": 1}},
        "fundamento": "criterio 3 (segunda mitad) y O-16: la tolerancia es constante del motor y no "
                      "aparece en Setting. El test falla si se puede subir desde una pantalla.",
    },
    {
        "id": "N05", "casoBase": "C11", "titulo": "ISP sin precondiciones: VIES negativo y sin mencion legal",
        "mutacion": {"counterparty.viesValid": False, "mencionLegalArt61m": None},
        "esperado": {"check": "RC-22", "status": "WARN", "blocksBatch": True,
                     "reconcileStatus": "WARN", "postError": "TEMPLATE_UNRESOLVED",
                     "docKindResuelto": "DESCONOCIDO", "asiento": None,
                     "checkAdicional": {"id": "RC-11", "status": "WARN", "blocksBatch": True,
                                        "message": "VIES negativo para DE811907980: bloquea RC-22"},
                     "message": "faltan dos de las cuatro precondiciones de inversion del sujeto "
                                "pasivo (VIES afirmativo y mencion legal del art. 6.1.m): el "
                                "documento queda DESCONOCIDO y decide el usuario"},
        "fundamento": "criterio 8 (tercera parte) y criterio 33 (rama UE). No se autorrepercute nunca "
                      "por el silencio del documento: se inventaria una cuota devengada y una "
                      "deducible sin soporte.",
    },
    {
        "id": "N06", "casoBase": "C15", "titulo": "Tercer pais con identificador fiscal vacio",
        "mutacion": {"counterparty.taxId": None},
        "esperado": {"check": "RC-11", "status": "WARN", "blocksBatch": False,
                     "reconcileStatus": "WARN", "postError": None,
                     "asientoIgualQue": "C15",
                     "message": "el documento no muestra identificador fiscal del expedidor; en un "
                                "tercer pais no hay checksum que comprobar, asi que se avisa y no se "
                                "bloquea"},
        "fundamento": "criterio 33 (tercera rama) y O-25: en la rama de tercer pais RC-11 NUNCA da "
                      "FAIL, ni siquiera con el identificador vacio. El test falla si bloquea.",
    },
    {
        "id": "N07", "casoBase": "C09", "titulo": "Suplido mal clasificado como linea de operacion",
        "mutacion": {"lines[1].kind": "OPERACION"},
        "esperado": {"check": "RC-20", "status": "FAIL", "blocksBatch": True,
                     "reconcileStatus": "FAIL", "postError": "PROPOSAL_NOT_RECONCILED",
                     "asiento": None,
                     "message": "con el suplido dentro de la base, la cuota saldria 27 300 en vez de "
                                "21 000 y la retencion 19 500 en vez de 15 000: RC-02 y RC-19 "
                                "fallarian sobre un documento correcto",
                     "evidence": {"baseIncorrecta": 130_000, "cuotaIncorrecta": 27_300,
                                  "retencionIncorrecta": 19_500, "baseCorrecta": 100_000,
                                  "cuotaCorrecta": 21_000, "retencionCorrecta": 15_000}},
        "fundamento": "art. 78.Tres.3o LIVA y art. 75 RIRPF. Es el error que O-12 vino a corregir.",
    },
    {
        "id": "N08", "casoBase": "C01", "titulo": "Organizacion en regimen especial del criterio de caja (RECC)",
        "mutacion": {"organization.ivaRegime": "RECC"},
        "esperado": {"check": "RC-24", "status": "FAIL", "blocksBatch": True,
                     "reconcileStatus": "FAIL", "postError": "PROPOSAL_NOT_RECONCILED",
                     "asiento": None, "sello": "REGIMEN_NO_SOPORTADO",
                     "message": "la organizacion esta acogida al regimen especial del criterio de "
                                "caja: el devengo y la deduccion siguen el cobro y el pago (arts. "
                                "163 terdecies y quaterdecies LIVA). La contabilizacion automatica "
                                "se bloquea; soporte previsto en E9"},
        "fundamento": "criterio 25 y O-21/D11. Un producto que no dice que no soporta es peor que "
                      "uno que no lo soporta (R12).",
    },
    {
        "id": "N09", "casoBase": "C13", "titulo": "El mismo documento parcial, tecleado por un EDITOR",
        "mutacion": {"run.kind": "MANUAL", "run.parentRunId": "RUN-C13",
                     "run.pagesAnalyzed": 9, "run.pagesTotal": 9},
        "esperado": {"check": "RC-09", "status": "PASS", "blocksBatch": False,
                     "reconcileStatus": "PASS", "postError": None,
                     "asiento": "se construye con FACTURA_RECIBIDA y las cifras tecleadas",
                     "origenDeLosCampos": "usuario",
                     "message": "run MANUAL con parentRunId: las cifras las asume una persona y el "
                                "run del LLM queda intacto byte a byte"},
        "fundamento": "criterio 23 y 28, ADR-0014 D5. La revision humana es un run NUEVO, jamas una "
                      "sobreescritura del anterior.",
    },
    {
        "id": "N10", "casoBase": "C12", "titulo": "La fuente de tasas no responde el dia de la confirmacion",
        "mutacion": {"rate": None},
        "esperado": {"check": "RC-14", "status": "FAIL", "blocksBatch": True,
                     "reconcileStatus": "FAIL", "postError": "PROPOSAL_NOT_RECONCILED",
                     "asiento": None,
                     "message": "factura en USD sin tasa persistida para el 2026-11-20: no se "
                                "convierte con otra fuente ni con otro dia. No se guarda nada a medias"},
        "fundamento": "criterio 20 y ADR-0014 D2: fuente unica (BCE/Frankfurter), sin fallback. "
                      "Inventar un tipo de cambio es inventar una cifra contable.",
    },
]


# ---------------------------------------------------------------------------
# Agregacion e identidades de IVA (I-E8-15a / 15b / 15c) e I-E8-7a
# ---------------------------------------------------------------------------


def _sum_account(asiento: dict[str, Any], code: str) -> int:
    """Saldo deudor neto de una cuenta en el asiento (debe - haber)."""
    return sum(l["debitCents"] - l["creditCents"] for l in asiento["lines"] if l["accountCode"] == code)


def identidades_de_caso(case: dict[str, Any]) -> dict[str, Any]:
    a = case["asiento"]
    lr = case["libroRegistro"]
    if a is None:
        return {"aplica": False, "ivaPeriod": None}
    iva_472 = _sum_account(a, "472")                 # deudor: cuota deducible
    iva_477 = -_sum_account(a, "477")                # acreedor: cuota devengada
    # 15a y 15b solo miran el libro registro de RECIBIDAS; 15c, el de emitidas mas el
    # devengado por ISP/AIB que se anota en el de recibidas (OBS-F1).
    recibidas = lr["tipo"] == "RECIBIDAS"
    return {
        "aplica": True,
        "ivaPeriod": a["ivaPeriod"],
        "saldo472Cents": iva_472,
        "saldo477Cents": iva_477,
        "libroCuotaTotalCents": lr["cuotaTotalCents"] if recibidas else 0,
        "libroCuotaDeducibleCents": lr["cuotaDeducibleCents"],
        "libroCuotaNoDeducibleAlCosteCents": lr["cuotaNoDeducibleAlCosteCents"],
        "libroCuotaRepercutidaCents": lr["cuotaRepercutidaCents"],
        "libroCuotaDevengadaIspAibCents": lr["cuotaDevengadaIspAibCents"],
        "I-E8-15a": iva_472 - lr["cuotaDeducibleCents"],
        "I-E8-15b": lr["cuotaTotalCents"] - (iva_472 + lr["cuotaNoDeducibleAlCosteCents"]),
        "I-E8-15c": iva_477 - (lr["cuotaRepercutidaCents"] + lr["cuotaDevengadaIspAibCents"]),
    }


def identidad_interna(case: dict[str, Any]) -> dict[str, Any]:
    """RC-03 / I-E8-7a sobre la PROPUESTA: el documento cuadra consigo mismo."""
    p = case["propuesta"]
    bases = sum(l["baseCents"] for l in p["lines"] if l["kind"] == "OPERACION")
    fuera_de_base = sum(l["baseCents"] for l in p["lines"] if l["kind"] in ("SUPLIDO", "NO_SUJETO"))
    # La cuota autorrepercutida (ISP/AIB) NO forma parte del total del documento: el
    # proveedor no la repercute. Es el unico caso en que `taxes[]` no suma al total.
    cuotas = sum(t["quotaCents"] for t in p["taxes"] if t.get("operationKey") not in ("ISP", "AIB"))
    retencion_leida = (p.get("readWithholding") or {}).get("quotaCents", 0) or 0
    anticipo = p.get("appliedAdvanceCents", 0) or 0
    calculado = bases + cuotas + fuera_de_base - retencion_leida - anticipo
    return {"basesOperacion": bases, "cuotasEnElTotal": cuotas, "suplidosYNoSujetos": fuera_de_base,
            "retencionLeida": retencion_leida, "anticipoAplicado": anticipo,
            "identidadCents": calculado, "totalDeclaradoCents": p["totalCents"],
            "desvioCents": calculado - p["totalCents"]}


CONVENCIONES: dict[str, Any] = {
    "unidad": "Todo importe es un entero en CENTIMOS. No hay ni un float en este fichero.",
    "signos": "`debitCents` y `creditCents` son magnitudes >= 0 y una de las dos es siempre 0. "
              "Un abono no lleva signo negativo: invierte el lado del asiento. En el LIBRO REGISTRO "
              "si hay negativos, porque una rectificativa minora la base y la cuota del periodo "
              "(C06 y C07). En el asiento, Sigma debe = Sigma haber con tolerancia 0 (I1, I-E8-7a).",
    "redondeoImpuestos": "HALF-UP sobre la magnitud, `applyBps` de lib/taxes/bps.ts (R-IVA-2). No es "
                         "half-even: el redondeo del banquero no es la convencion de la AEAT. "
                         "Simetrico en negativos, que es lo que exige una rectificativa.",
    "redondeoDivisa": "HALF-EVEN, `convertWithRateMicro` de lib/money.ts (NRV 11a). Convive a "
                      "proposito con el half-up de los impuestos: son dos magnitudes distintas.",
    "redondeoBaseDeTicket": "RC-17 usa round_half_up(total x 10000 / (10000 + rateBps)) y deja la "
                            "cuota como RESIDUO, de modo que base + cuota = total con tolerancia 0 "
                            "y jamas hay linea de redondeo.",
    "hamilton": "Un residuo entre varios destinos se reparte por MAYOR RESTO con desempate por MENOR "
                "CODIGO en orden lexicografico, igual que I5 de E5, para que sea reproducible byte a "
                "byte (P7). Se usa en dos sitios: (a) el residuo de conversion de divisa, que "
                "absorben las cuotas (ADR-0014 D2), y (b) el reparto de la cuota entre bloques de "
                "pasivo de un documento mixto, cuyo centimo huerfano va al bloque mayor (O-3).",
    "cuotaContabilizada": "La del DOCUMENTO (ADR-0014 D3, arts. 92.Uno y 97.Uno LIVA, art. 64 RIVA). "
                          "El recalculo solo fija la confianza y alimenta `quotaDeviationsCents`, que "
                          "es la metrica I-E8-7b y NO un importe a contabilizar. "
                          "TOLERANCIA_CUOTA_IVA_CENTS = 1, constante del motor, no configurable.",
    "sinLineaDeAjusteDeIva": "No existe linea de 669/769 por residuo de IVA. 669/769 queda reservado "
                             "al redondeo de TESORERIA de T-08/T-09; 668/768 a las diferencias de "
                             "cambio; 634/639 a un eventual ajuste de imposicion indirecta.",
    "ivaNoDeducible": "Nunca pasa por 472: engorda la linea de gasto o de inmovilizado (art. 103 "
                      "LIVA, NRV 2a y 10a). El campo `nonDeductibleIncludedCents` de la linea dice "
                      "cuanto de ella es cuota incorporada al coste, que es lo que cuadra I-E8-15b.",
    "periodoDeIva": "Trimestre de max(receptionDate, documentDate) (ADR-0014 D8), que NO tiene por "
                    "que coincidir con el del entryDate. C01 lo demuestra: gasto en marzo, IVA en 2T.",
    "confianza": "Cuatro niveles (O-20.1). `calculado`: lo produjo el codigo. `verificado`: leido del "
                 "documento y coincidente con el recalculo determinista, o afirmado por una persona "
                 "y con su check en PASS. `interpretacion_ia`: valor del modelo que paso su "
                 "comprobacion de forma pero no es derivable, y TODA cuenta o dimension que venga "
                 "del catalogo por coincidencia (O-10). `no_verificado`: su check fallo, se forzo, el "
                 "run es parcial o importado, o la deducibilidad esta pendiente de decision.",
    "elegibleParaLote": "true solo si el estado global es PASS y ningun check tiene blocksBatch. Un "
                        "WARN bloqueante impide el lote sin ser FAIL, que es justo lo que O-19 pedia.",
    "puerta": "FAIL en reconcile => no hay asiento. Tambien lo impiden un run IMPORTED y un run "
              "`partial` de kind LLM (PARTIAL_RUN_CANNOT_POST, O-20.3).",
    "loQueElModeloNoRellena": ["accountCode", "projectId", "costCenterId", "deductibility",
                               "withholding", "receptionDate", "paymentKey", "simplifiedQualified",
                               "rectifies.reason", "rectifies.mode", "calificacion firme de ISP"],
}

OBSERVACIONES_PARA_T14: list[dict[str, str]] = [
    {
        "id": "OBS-F1",
        "afecta": "I-E8-15c",
        "hallazgo": "El enunciado literal de I-E8-15c (`Sigma 477 del periodo = Sigma cuota "
                    "repercutida del libro registro de EMITIDAS`) da FAIL sobre el caso C11, que es "
                    "correcto: el 477 de una autorrepercusion por inversion del sujeto pasivo o por "
                    "AIB no procede de ninguna factura emitida, sino del libro registro de "
                    "RECIBIDAS (art. 64 RIVA y casillas 10-13 del 303).",
        "correccion": "I-E8-15c = Sigma 477 del periodo de IVA - (Sigma cuota repercutida del libro "
                      "de emitidas + Sigma cuota devengada por ISP/AIB del libro de recibidas) = 0. "
                      "Es un termino mas en la misma consulta, sin codigo nuevo.",
        "severidad": "MEDIA - se implementa dentro de T14, no exige ronda de validacion.",
    },
    {
        "id": "OBS-F2",
        "afecta": "I-E8-15c y el 303 del trimestre",
        "hallazgo": "C14 (anticipo de cliente sin cobro) anota el documento en el libro registro de "
                    "emitidas con cuota repercutida 0, porque el devengo se difiere al cobro (art. "
                    "75.Dos LIVA). Si el libro registro anotase la cuota de la factura, 15c daria "
                    "FAIL con el asiento correcto.",
        "correccion": "El libro registro de emitidas anota la cuota devengada del PERIODO, no la "
                      "impresa en el documento. La anotacion de los 210 000 corresponde al trimestre "
                      "del cobro, con el asiento T-08.",
        "severidad": "MEDIA - condiciona la consulta de T14 y el asiento de T-08.",
    },
    {
        "id": "OBS-F3",
        "afecta": "RC-03 en documentos con inversion del sujeto pasivo",
        "hallazgo": "La identidad interna de RC-03 suma `Sigma cuotas`, pero en un ISP o una AIB el "
                    "proveedor NO repercute: la cuota autorrepercutida no forma parte del total del "
                    "documento. Sumarla haria FAIL a toda factura intracomunitaria (C11).",
        "correccion": "RC-03 excluye de `Sigma cuotas` los tipos cuyo `operationKey` sea ISP o AIB. "
                      "Es la unica excepcion y esta acotada por el propio enum.",
        "severidad": "ALTA para T7 - sin esto, el caso C11 del fixture no pasa.",
    },
    {
        "id": "OBS-F4",
        "afecta": "Confianza de los campos de origen `usuario`",
        "hallazgo": "Los cuatro niveles de O-20.1 no dicen que confianza tiene un campo que teclea "
                    "una persona (receptionDate, paymentKey, deductibility de un ticket cualificado, "
                    "rectifies.mode). No es `calculado` ni `interpretacion_ia`.",
        "correccion": "Convencion sellada en este fixture: origen `usuario` con su check en PASS => "
                      "confianza `verificado`; con su check en FAIL o forzado => `no_verificado`. "
                      "Una persona que afirma un dato y supera la comprobacion esta al menos tan "
                      "verificada como una cifra recalculada.",
        "severidad": "BAJA - convencion, no norma. Que T7 la respete o la cambie, pero que la escriba.",
    },
]


def build() -> dict[str, Any]:
    casos = [dict(c) for c in CASES]
    for c in casos:
        c["identidadInternaDelDocumento"] = identidad_interna(c)
        c["identidadesIva"] = identidades_de_caso(c)

    # --- agregacion por periodo de IVA ------------------------------------
    periodos: dict[str, dict[str, int]] = {}
    for c in casos:
        idn = c["identidadesIva"]
        if not idn["aplica"]:
            continue
        p = periodos.setdefault(idn["ivaPeriod"], {
            "saldo472Cents": 0, "saldo477Cents": 0, "libroCuotaTotalCents": 0,
            "libroCuotaDeducibleCents": 0, "libroCuotaNoDeducibleAlCosteCents": 0,
            "libroCuotaRepercutidaCents": 0, "libroCuotaDevengadaIspAibCents": 0,
        })
        for k in p:
            p[k] += idn[k]
    for p in periodos.values():
        p["I-E8-15a"] = p["saldo472Cents"] - p["libroCuotaDeducibleCents"]
        p["I-E8-15b"] = p["libroCuotaTotalCents"] - (p["saldo472Cents"]
                                                     + p["libroCuotaNoDeducibleAlCosteCents"])
        p["I-E8-15c"] = p["saldo477Cents"] - (p["libroCuotaRepercutidaCents"]
                                              + p["libroCuotaDevengadaIspAibCents"])
    periodos = dict(sorted(periodos.items()))

    global_iva = {k: sum(p[k] for p in periodos.values()) for k in
                  ("saldo472Cents", "saldo477Cents", "libroCuotaTotalCents",
                   "libroCuotaDeducibleCents", "libroCuotaNoDeducibleAlCosteCents",
                   "libroCuotaRepercutidaCents", "libroCuotaDevengadaIspAibCents",
                   "I-E8-15a", "I-E8-15b", "I-E8-15c")}

    # --- comprobaciones del propio generador ------------------------------
    checks: list[dict[str, Any]] = []

    def add_check(cid: str, ok: bool, expected: Any, actual: Any, evidencia: str,
                  offenders: list[str] | None = None) -> None:
        checks.append({"id": cid, "status": "PASS" if ok else "FAIL", "expected": expected,
                       "actual": actual, "evidencia": evidencia, "offenders": offenders or []})

    add_check("F-01", len(casos) == 15, 15, len(casos),
              "quince casos sellados: los trece de §5.3 mas los dos de §R2.3 (O-23 y O-25)")

    ids = [c["id"] for c in casos]
    add_check("F-02", len(set(ids)) == len(ids) and ids == sorted(ids), sorted(set(ids)), ids,
              "identificadores de caso unicos y en orden")

    descuadrados = [c["id"] for c in casos if c["asiento"] and c["asiento"]["cuadreCents"] != 0]
    add_check("F-03", not descuadrados, 0, len(descuadrados),
              "I1 / I-E8-7a: todo asiento esperado cuadra a 0 centimos", descuadrados)

    mal_identidad = [f"{c['id']}:{c['identidadInternaDelDocumento']['desvioCents']}"
                     for c in casos if c["identidadInternaDelDocumento"]["desvioCents"] != 0]
    add_check("F-04", not mal_identidad, 0, len(mal_identidad),
              "RC-03: Sigma bases + cuotas (sin ISP/AIB) + suplidos - retencion leida - anticipo "
              "= total declarado, tolerancia 0", mal_identidad)

    mal_15a = [f"{p}:{v['I-E8-15a']}" for p, v in periodos.items() if v["I-E8-15a"] != 0]
    add_check("F-05", not mal_15a, 0, len(mal_15a),
              "I-E8-15a por periodo: Sigma 472 = Sigma cuota deducible del libro de recibidas", mal_15a)

    mal_15b = [f"{p}:{v['I-E8-15b']}" for p, v in periodos.items() if v["I-E8-15b"] != 0]
    add_check("F-06", not mal_15b, 0, len(mal_15b),
              "I-E8-15b por periodo: Sigma cuota total del libro = Sigma 472 + Sigma IVA no deducible "
              "incorporado al coste", mal_15b)

    mal_15c = [f"{p}:{v['I-E8-15c']}" for p, v in periodos.items() if v["I-E8-15c"] != 0]
    add_check("F-07", not mal_15c, 0, len(mal_15c),
              "I-E8-15c por periodo: Sigma 477 = repercutido de emitidas + devengado por ISP/AIB de "
              "recibidas (ver OBS-F1)", mal_15c)

    # Bloques de pasivo: cada bloque casa con la linea acreedora de su cuenta.
    mal_bloques: list[str] = []
    for c in casos:
        a = c["asiento"]
        if not a:
            continue
        for b in a["payableBlocks"]:
            # En un abono el pasivo va al DEBE: se comparan magnitudes, no lados.
            saldo = abs(_sum_account(a, b["accountCode"]))
            if saldo != b["amountCents"]:
                mal_bloques.append(f"{c['id']}:{b['accountCode']}:{saldo}!={b['amountCents']}")
    add_check("F-08", not mal_bloques, 0, len(mal_bloques),
              "O-3: cada bloque de pasivo casa centimo a centimo con la linea de su cuenta",
              mal_bloques)

    # La cuota del DOCUMENTO no se pierde: o llega a 472/477 o engorda el coste.
    mal_override: list[str] = []
    for c in casos:
        a = c["asiento"]
        if not a or not a["taxOverrides"]:
            continue
        override = sum(abs(o["quotaCents"]) for o in a["taxOverrides"])
        if a["sourceType"] == "INVOICE_OUT":
            destino = abs(_sum_account(a, "477"))
            nota = "477"
        else:
            destino = abs(_sum_account(a, "472")) + sum(l["nonDeductibleIncludedCents"] for l in a["lines"])
            nota = "472 + coste"
        if c["id"] == "C14":
            destino, nota = 0, "diferido al cobro (RC-25)"   # O-23: el devengo no ha nacido
        if destino != override:
            mal_override.append(f"{c['id']}:{override}!={destino} ({nota})")
    add_check("F-09", not mal_override, 0, len(mal_override),
              "ADR-0014 D3: la cuota del documento llega integra al asiento, sea a 472/477 sea "
              "incorporada al coste (art. 103 LIVA). La unica excepcion es C14, cuyo devengo se "
              "difiere al cobro por el art. 75.Dos LIVA", mal_override)

    # Los 25 checks, completos y en orden, en los quince casos.
    mal_rc = [c["id"] for c in casos if [k["id"] for k in c["reconcile"]["checks"]] != RC_IDS]
    add_check("F-10", not mal_rc, 25, 25,
              "RC-01..RC-25 completos y en el orden fijo del catalogo en los quince casos", mal_rc)

    # Confianza: ningun campo de origen `catalogo` puede ser `calculado` (O-10).
    mal_conf: list[str] = []
    for c in casos:
        for campo, v in c["reconcile"]["confianzaPorCampo"].items():
            if v["origin"] == "catalogo" and v["confidence"] == "calculado":
                mal_conf.append(f"{c['id']}:{campo}")
            if c["contexto"]["run"]["partial"] and v["confidence"] in ("calculado", "verificado"):
                mal_conf.append(f"{c['id']}:{campo}:parcial")
    add_check("F-11", not mal_conf, 0, len(mal_conf),
              "O-10 e I-E8-10: nada del catalogo es `calculado`, y un run parcial no tiene ningun "
              "campo `calculado` ni `verificado`", mal_conf)

    # FAIL => sin asiento (la puerta de postFromProposal).
    mal_puerta = [c["id"] for c in casos
                  if (c["reconcile"]["status"] == "FAIL") != (c["asiento"] is None)]
    add_check("F-12", not mal_puerta, 0, len(mal_puerta),
              "puerta de postFromProposal: FAIL implica que no hay asiento, y viceversa en el fixture",
              mal_puerta)

    # Elegibilidad para el lote, recomputada.
    mal_lote = [c["id"] for c in casos
                if c["reconcile"]["elegibleParaLote"] != elegible_lote(c["reconcile"]["checks"])]
    add_check("F-13", not mal_lote, 0, len(mal_lote),
              "elegibleParaLote = PASS global y ningun check con blocksBatch", mal_lote)

    # Los NIF que el fixture declara validos lo son, y el del caso negativo no.
    nif_ok = [nif_es_valido("B12345674"), nif_es_valido("A28017895"), nif_es_valido("12345678Z")]
    add_check("F-14", all(nif_ok) and not nif_es_valido("B12345675"),
              "[True, True, True] y False", f"{nif_ok} y {nif_es_valido('B12345675')}",
              "RC-11 rama ES: los NIF del fixture pasan modulo 23 / letra de CIF y el de N01 no")

    # Hamilton: el reparto de C12 no pierde ni crea centimos.
    c12 = next(c for c in casos if c["id"] == "C12")
    a12 = c12["asiento"]
    bases12 = sum(l["debitCents"] for l in a12["lines"] if l["accountCode"] == "600")
    cuotas12 = sum(l["debitCents"] for l in a12["lines"] if l["accountCode"] == "472")
    pasivo12 = -_sum_account(a12, "400")
    add_check("F-15", bases12 + cuotas12 == pasivo12, pasivo12, bases12 + cuotas12,
              "ADR-0014 D2: en divisa, Sigma bases convertidas + Sigma cuotas repartidas por Hamilton "
              "= el pasivo convertido. Residuo cero, sin linea de ajuste")

    # Ninguna cuenta de ajuste indebida en ningun asiento.
    prohibidas = {"669", "769"}
    mal_669 = [f"{c['id']}:{l['accountCode']}" for c in casos if c["asiento"]
               for l in c["asiento"]["lines"] if l["accountCode"] in prohibidas]
    add_check("F-16", not mal_669, 0, len(mal_669),
              "R2 / ADR-0014 D3.ii: ningun asiento de E8 lleva 669 ni 769; esas cuentas son del "
              "redondeo de tesoreria de T-08/T-09", mal_669)

    # C14: la factura de anticipo de cliente no lleva 477 (O-23).
    c14 = next(c for c in casos if c["id"] == "C14")
    tiene_477 = any(l["accountCode"] == "477" for l in c14["asiento"]["lines"])
    add_check("F-17", not tiene_477, False, tiene_477,
              "O-23 / art. 75.Dos LIVA: la factura de anticipo de cliente sin cobro NO lleva 477")

    # C11: exactamente dos lineas de IVA, mismo tipo, mismo importe (I-E8-18).
    c11 = next(c for c in casos if c["id"] == "C11")
    isp = [l for l in c11["asiento"]["lines"] if l["accountCode"] in ("472", "477")]
    ok_isp = (len(isp) == 2 and len({l["taxRateCode"] for l in isp}) == 1
              and isp[0]["debitCents"] == isp[1]["creditCents"])
    add_check("F-18", ok_isp, "dos lineas del mismo taxRateId y mismo importe",
              f"{len(isp)} lineas", "I-E8-18: efecto neto en tesoreria 0 en la autorrepercusion")

    # C03/C04: mismo total, distinta deducibilidad, y la cuota no deducible dentro del gasto.
    c03 = next(c for c in casos if c["id"] == "C03")
    c04 = next(c for c in casos if c["id"] == "C04")
    ok_ticket = (c03["asiento"]["totalDebitCents"] == c04["asiento"]["totalDebitCents"]
                 and c03["libroRegistro"]["cuotaNoDeducibleAlCosteCents"] == 112
                 and c04["libroRegistro"]["cuotaDeducibleCents"] == 112)
    add_check("F-19", ok_ticket, True, ok_ticket,
              "ADR-0014 D9: el mismo ticket, con y sin cualificar, mueve el mismo dinero y cambia "
              "solo el destino de los 112 centimos de cuota")

    # Casos negativos: todos apuntan a un caso base existente.
    huerfanos = [n["id"] for n in CASOS_NEGATIVOS if n["casoBase"] not in ids]
    add_check("F-20", not huerfanos, 0, len(huerfanos),
              "cada caso negativo referencia un caso base del fixture", huerfanos)

    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedBy": "docs/design/fixtures/build_extraccion_esperada.py",
        "note": "E8 - propuesta normalizada, resultado de reconcile() y asiento de "
                "postFromProposal() esperados para los QUINCE casos comprometidos en "
                "docs/design/E8-documentos-asientos.md §5.3 y §R2.3 de la validacion contable. "
                "Sellado por experto-contable (T8). Centimos enteros; los asientos cuadran a 0 y "
                "las identidades de IVA I-E8-15a/15b/15c salen 0 por periodo y en global.",
        "source": {
            "diseno": "docs/design/E8-documentos-asientos.md",
            "validacion": "docs/design/E8-validacion-documentos.md",
            "adr": "docs/adr/0014-estados-transaccion-fx-y-tolerancia-reconcile.md",
            "plan": "seeds/npgc.csv", "plantillas": "lib/ledger/templates/",
            "fiscalYear": FISCAL_YEAR, "refDate": REF_DATE, "baseCurrency": BASE_CURRENCY,
        },
        "convenciones": CONVENCIONES,
        "contextoComun": {
            "accountMap": dict(sorted(ACCOUNT_MAP.items())),
            "taxRates": dict(sorted(TAX_RATES.items())),
            "analyticTypePorCuenta": dict(sorted(ACCOUNT_ANALYTIC.items())),
            "organization": ORG_GENERAL,
            "counterparties": dict(sorted(CONTRAPARTES.items())),
            "exchangeRates": [RATE_USD_EUR],
        },
        "reglasReconcile": [{"id": rc, "regla": RC_TITLE[rc]} for rc in RC_IDS],
        "casos": casos,
        "casosNegativos": CASOS_NEGATIVOS,
        "identidadesIvaPorPeriodo": periodos,
        "identidadesIvaGlobales": global_iva,
        "observacionesParaT14": OBSERVACIONES_PARA_T14,
        "checks": checks,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    data = build()
    failed = [c for c in data["checks"] if c["status"] != "PASS"]
    for c in failed:
        print(f"FAIL {c['id']}: esperado {c['expected']} != {c['actual']}  {c['offenders']}",
              file=sys.stderr)
    if failed:
        return 2

    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if args.check:
        if not OUT.exists():
            print(f"falta {OUT}", file=sys.stderr)
            return 1
        if OUT.read_text(encoding="utf-8") != text:
            print(f"{OUT} difiere de la reconstruccion", file=sys.stderr)
            return 1
        print("OK: extraccion-esperada.json reproducible byte a byte")
        return 0

    OUT.write_text(text, encoding="utf-8")
    print(f"escrito {OUT}")
    print(f"  {len(data['casos'])} casos, {len(data['casosNegativos'])} variantes negativas, "
          f"{len(data['checks'])} comprobaciones del generador")
    for c in data["casos"]:
        a = c["asiento"]
        tot = a["totalDebitCents"] if a else 0
        print(f"  {c['id']}  {c['slug']:<38} total {tot:>10,}  "
              f"{c['reconcile']['status']:<4} {'sin asiento' if a is None else a['templateCode']}")
    for p, v in data["identidadesIvaPorPeriodo"].items():
        print(f"  {p}  472 = {v['saldo472Cents']:>9,}   477 = {v['saldo477Cents']:>9,}   "
              f"15a/15b/15c = {v['I-E8-15a']}/{v['I-E8-15b']}/{v['I-E8-15c']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
