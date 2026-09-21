#!/usr/bin/env python3
"""
E12 · ronda 1 (auditor H-1) — Generador del SUSTRATO DOCUMENTAL MINIMO.

    python3 docs/design/fixtures/build_documental_minimo.py [--check]

## Por que existe

La matriz de deteccion de C4 tiene diez inyecciones (§3.5 del diseno). Cinco
—#4 `allocation_lines`, #5 `proposal_sha`, #6 el byte del documento, #8
`UsageRun` y #9 la cuota del 303— salian **WARN: no ejercida** porque el fixture
`ejercicio-completo` no trae ni un documento, ni una extraccion, ni un parte de
horas, ni un consumo, ni una liquidacion de IVA sellada. El aserto pedia 5 de 10
y el criterio 15 pide **las diez**: la enmienda E-9 («NO_VERIFICABLE no es un
aprobado») incumplida justo por el control que la vigila.

Este fichero declara ese sustrato, y lo declara **aqui** —en Python, sin tocar
`lib/`, sin TypeScript y sin base de datos— por la misma razon que los otros
doce generadores: un sustrato que se inventa el arnes en tiempo de ejecucion no
es reproducible, y la primera vez que alguien cambie una cifra nadie sabra si el
test cambio de opinion o el producto.

## Que NO hace

**No toca el libro diario.** Ni un asiento, ni una linea, ni una cuenta: las
doce cifras canonicas de §3.2 y los cinco sellos del fixture completo tienen que
seguir siendo exactamente los mismos con el sustrato cargado. Los documentos,
las extracciones, el consumo y los partes de horas viven al lado del diario, no
dentro. Lo unico que se apoya en el diario —la liquidacion de IVA— se declara
aqui con las cuentas y los importes que el fixture YA tiene contabilizados: la
liquidacion se calcula leyendo el libro registro, no anadiendo nada.

## Que declara, y por que cada cosa

  · **dos documentos** con sus bytes (texto determinista) y su `sha256`, que es
    el que el almacen tendra que devolver. Dos y no uno: con uno solo, una
    inyeccion que borrase la fila pasaria por «no habia documentos».
  · **una extraccion por documento**, con la propuesta normalizada y su
    `proposalSha` en forma canonica de ADR-0011 (claves ordenadas, sin
    espacios): es la que I-E8-11 recomputa. Se calcula aqui, en Python, y el
    cargador comprueba que el producto saca la misma — un tercer camino mas.
  · **un empleado y sus partes de horas** de 2026, que son la BASE del driver
    `HOURS`: sin partes aprobados, una regla `HOURS` reparte sobre cero y la
    inyeccion #4 no tendria una sola linea que alterar (E10 · D1).
  · **una regla de imputacion** del CECO de estructura a los proyectos, con
    driver `HOURS`.
  · **el consumo del mes**, que el producto sella como `UsageRun` con su
    `sourceHash` (I-E11-1).
  · **la liquidacion de IVA** del trimestre, que el producto sella con su
    `bookHash` leyendo el libro registro del propio fixture (I-E8-15a/b/c).

Escribe `tests/fixtures/documental-minimo.json`. Con `--check` no escribe:
reconstruye, compara byte a byte y falla si difiere.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys

RAIZ = pathlib.Path(__file__).resolve().parents[3]
SALIDA = RAIZ / "tests" / "fixtures" / "documental-minimo.json"

SCHEMA_VERSION = "1.0"


def canonical_json(value: object) -> str:
    """
    La forma canonica de ADR-0011, reimplementada: claves ordenadas, sin
    espacios, `undefined` fuera. Es la misma que `lib/extraction/hash.ts`
    (`canonicalJson`) y se escribe aqui a proposito, no se importa: si un dia
    las dos dejan de coincidir, el cargador lo dice al cargar.
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_hex(data: bytes | str) -> str:
    return hashlib.sha256(data.encode("utf-8") if isinstance(data, str) else data).hexdigest()


# ─────────────────────────────────────────────────────────────────────────────
# 1 · Los dos documentos
# ─────────────────────────────────────────────────────────────────────────────

def documentos() -> list[dict]:
    """
    Bytes de TEXTO y no un PDF binario: lo que las inyecciones #6 y el barrido
    del almacen miran es el `sha256`, y un texto legible hace que, cuando algo
    falle, se pueda abrir el fichero y leer lo que dice.
    """
    cuerpos = [
        (
            "DOC-1",
            "factura-servicios-2026-02.txt",
            "text/plain",
            "\n".join(
                [
                    "FACTURA RECIBIDA",
                    "Numero: SG-2026-0042",
                    "Fecha: 2026-02-10",
                    "Proveedor: Servicios Generales SL (B58818501)",
                    "Concepto: Servicios de mantenimiento",
                    "Base imponible: 100000 centimos",
                    "IVA 21%: 21000 centimos",
                    "Total: 121000 centimos",
                    "",
                ]
            ),
        ),
        (
            "DOC-2",
            "ticket-restaurante-2026-03.txt",
            "text/plain",
            "\n".join(
                [
                    "TICKET",
                    "Numero: TK-2026-0007",
                    "Fecha: 2026-03-12",
                    "Proveedor: Cafeteria del Puerto SL (B12345674)",
                    "Concepto: Comida de trabajo",
                    "Base imponible: 1122 centimos",
                    "IVA 10%: 112 centimos",
                    "Total: 1234 centimos",
                    "",
                ]
            ),
        ),
    ]
    salida = []
    for ref, filename, mimetype, contenido in cuerpos:
        raw = contenido.encode("utf-8")
        salida.append(
            {
                "ref": ref,
                "filename": filename,
                "mimetype": mimetype,
                "contenido": contenido,
                "sha256": sha256_hex(raw),
                "sizeBytes": len(raw),
            }
        )
    return salida


# ─────────────────────────────────────────────────────────────────────────────
# 2 · Las dos extracciones
# ─────────────────────────────────────────────────────────────────────────────

def propuesta_doc1() -> dict:
    return {
        "version": 1,
        "docKind": "FACTURA_RECIBIDA",
        "documentNumber": "SG-2026-0042",
        "counterparty": {"name": "Servicios Generales SL", "taxId": "B58818501"},
        "documentDate": "2026-02-10",
        "accrualDate": "2026-02-10",
        "receptionDate": "2026-02-14",
        "operationDate": "2026-02-10",
        "currency": "EUR",
        "lines": [
            {
                "kind": "OPERACION",
                "baseCents": 100000,
                "taxRateCode": "IVA_21",
                "description": "Servicios de mantenimiento",
                "accountCode": "629",
            }
        ],
        "taxes": [{"taxRateCode": "IVA_21", "baseCents": 100000, "quotaCents": 21000}],
        "totalCents": 121000,
        "description": "Factura de servicios de mantenimiento",
    }


def propuesta_doc2() -> dict:
    return {
        "version": 1,
        "docKind": "TICKET",
        "documentNumber": "TK-2026-0007",
        "counterparty": {"name": "Cafeteria del Puerto SL", "taxId": "B12345674"},
        "documentDate": "2026-03-12",
        "accrualDate": "2026-03-12",
        "receptionDate": "2026-03-12",
        "operationDate": "2026-03-12",
        "currency": "EUR",
        "lines": [
            {
                "kind": "OPERACION",
                "baseCents": 1122,
                "taxRateCode": "IVA_10",
                "description": "Comida de trabajo",
            }
        ],
        "taxes": [{"taxRateCode": "IVA_10", "baseCents": 1122, "quotaCents": 112}],
        "totalCents": 1234,
        "description": "Ticket de restaurante",
    }


def extracciones(docs: list[dict]) -> list[dict]:
    plantilla = "Extrae los campos de la factura adjunta y devuelve JSON conforme al esquema."
    # **La version del esquema NO es la vigente del producto, a proposito.**
    # `readDocumentsInvariantInput` recomputa `schema_sha` SOLO cuando el run
    # declara la version vigente (`EXTRACTION_SCHEMA_VERSION`), y lo compara con
    # el sha del esquema de HOY: un fixture no puede conocer ese sha sin
    # importar `ai/schema.ts`, que es del productor. Declarando otra version, el
    # sello del esquema no se contrasta y el de la propuesta —que es el que la
    # inyeccion #5 toca— si.
    esquema = {"type": "object", "required": ["documentNumber", "totalCents"], "version": "v1-fixture"}
    salida = []
    for doc, propuesta in zip(docs, [propuesta_doc1(), propuesta_doc2()]):
        prompt = f"{plantilla}\nDocumento: {doc['filename']}"
        salida.append(
            {
                "documento": doc["ref"],
                "kind": "LLM",
                "provider": "fixture",
                "model": "documental-minimo-1",
                "promptCode": "extraction",
                "promptSource": "GIT",
                "prompt": prompt,
                "promptSha": sha256_hex(prompt),
                "schemaVersion": "v1-fixture",
                "schema": esquema,
                "schemaSha": sha256_hex(canonical_json(esquema)),
                "proposal": propuesta,
                # Lo que I-E8-11 recomputara sobre la fila. Tercer camino.
                "proposalSha": sha256_hex(canonical_json(propuesta)),
                "pagesSent": 1,
                "pagesTotal": 1,
            }
        )
    return salida


# ─────────────────────────────────────────────────────────────────────────────
# 3 · Horas, regla de imputacion, consumo y liquidacion
# ─────────────────────────────────────────────────────────────────────────────

def partes() -> list[dict]:
    """
    Doce partes de 2026, repartidos entre los dos proyectos del fixture que
    tienen coste directo. Minutos enteros y fechas dentro del ejercicio: el
    driver `HOURS` sella su ventana (`timeHash`) y una fecha fuera la moveria.
    """
    filas = []
    for mes in range(1, 13):
        proyecto = "P-01" if mes % 2 == 1 else "P-02"
        dia = 10 + (mes % 5)
        filas.append(
            {
                "date": f"2026-{mes:02d}-{dia:02d}",
                "projectCode": proyecto,
                # 7 h los meses impares, 5 h los pares: una base desigual, que es
                # lo que hace que el reparto por horas no coincida con el reparto
                # a partes iguales y la inyeccion #4 signifique algo.
                "minutes": 420 if mes % 2 == 1 else 300,
            }
        )
    return filas


def fixture() -> dict:
    docs = documentos()
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedBy": "docs/design/fixtures/build_documental_minimo.py",
        "note": (
            "E12 · ronda 1 (H-1) — sustrato documental minimo para que las diez inyecciones de §3.5 se "
            "ejerzan. NO toca el libro diario: las doce cifras canonicas y los cinco sellos del fixture "
            "`ejercicio-completo` no se mueven con este sustrato cargado."
        ),
        "fiscalYear": "2026",
        "documentos": docs,
        "extracciones": extracciones(docs),
        "empleado": {
            "code": "EMP-DOC-01",
            "name": "Empleada de proyectos",
            "email": "emp-doc-01@fixture.local",
            "hireDate": "2025-01-07",
            "rate": {"validFrom": "2025-01-07", "basis": "COSTE_EMPRESA_CON_SS", "costCentsPerHour": 2500},
        },
        "partes": partes(),
        "reglaImputacion": {
            "code": "AL-DOC-HORAS",
            "name": "Estructura a proyectos por horas imputadas",
            "sourceCostCenterCode": "CC-GA",
            "targetKind": "PROJECTS",
            "driver": "HOURS",
            "period": "YEAR",
            "priority": 90,
            "sourceShareBps": 10000,
            "zeroBaseFallback": "SKIP_WARN",
            "validFrom": "2026-01-01",
        },
        "uso": {
            "periodMonth": "2026-12-01",
            "nota": "El consumo lo CALCULA el producto contando lo que hay; aqui solo se declara el mes.",
        },
        "liquidacionIva": {
            "periodKind": "TRIMESTRAL",
            "period": "2026-Q1",
            "periodStart": "2026-01-01",
            "periodEnd": "2026-03-31",
            "nota": (
                "Las cifras las calcula el producto leyendo el libro registro del propio fixture: sellar la "
                "liquidacion no anade un apunte al diario, lo cierra."
            ),
        },
        "esperado": {
            "documentos": len(docs),
            "extracciones": 2,
            "partes": 12,
            "minutosTotales": sum(p["minutes"] for p in partes()),
            "reglas": 1,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="no escribe: compara byte a byte")
    args = parser.parse_args()

    contenido = json.dumps(fixture(), indent=2, ensure_ascii=False) + "\n"

    if args.check:
        if not SALIDA.exists():
            print(f"FALLO — {SALIDA} no existe", file=sys.stderr)
            return 1
        actual = SALIDA.read_text(encoding="utf-8")
        if actual != contenido:
            print(f"FALLO — {SALIDA} no se reproduce byte a byte", file=sys.stderr)
            return 1
        print(f"OK — {SALIDA.relative_to(RAIZ)} se reproduce byte a byte")
        return 0

    SALIDA.parent.mkdir(parents=True, exist_ok=True)
    SALIDA.write_text(contenido, encoding="utf-8")
    print(f"escrito {SALIDA.relative_to(RAIZ)} ({len(contenido)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
