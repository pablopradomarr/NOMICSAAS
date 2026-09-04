import { describe, expect, it } from "vitest"
import { buildPlan } from "@/lib/accounts/codes"
import {
  NPGC_HEADER,
  parseCsvRows,
  parseCustomPlanCsv,
  parseNpgcCsv,
  planDiff,
  MAX_IMPORT_ROWS,
  resolveImportedParents,
  rowNumbersByCode,
  seedRowsToPlanAccounts,
} from "@/lib/accounts/csv"
import type { PlanAccount } from "@/lib/accounts/types"

const HEADER = NPGC_HEADER.join(",")
const row = (
  code: string,
  name = `Cuenta ${code}`,
  parent = code.length > 1 ? code.slice(0, code.length - 1) : "",
  extra = ",DEUDORA,,,,0,0,1,"
) => `${code},${name},${code.length},${parent},${code[0]}${extra}`

describe("parseCsvRows", () => {
  it("caso vacío", () => {
    expect(parseCsvRows("")).toEqual([])
  })

  it("un registro con comillas, comas dentro y comillas escapadas", () => {
    expect(parseCsvRows('a,b\n"uno, dos","di ""hola"""\n')).toEqual([
      ["a", "b"],
      ["uno, dos", 'di "hola"'],
    ])
  })

  it("respeta el delimitador dentro de comillas (hallazgo 6)", () => {
    // Con el `split(";").join(",")` anterior, este `;` partía el campo en dos.
    expect(parseCsvRows('Cuenta;Descripción\n705;"Servicios; consultoría"\n', ";")).toEqual([
      ["Cuenta", "Descripción"],
      ["705", "Servicios; consultoría"],
    ])
    // Y una coma dentro de un fichero con `;` sigue siendo texto, no separador.
    expect(parseCsvRows("Cuenta;Descripción\n705;Servicios, varios\n", ";")).toEqual([
      ["Cuenta", "Descripción"],
      ["705", "Servicios, varios"],
    ])
  })

  it("rechaza delimitadores imposibles", () => {
    expect(() => parseCsvRows("a,b\n", '"')).toThrow(TypeError)
    expect(() => parseCsvRows("a,b\n", ";;")).toThrow(TypeError)
  })

  it("ignora líneas en blanco y CRLF", () => {
    expect(parseCsvRows("a,b\r\n1,2\r\n\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ])
  })
})

describe("parseNpgcCsv", () => {
  it("fichero vacío y cabecera incorrecta → CSV_HEADER", () => {
    expect(parseNpgcCsv("").ok).toBe(false)
    const mala = parseNpgcCsv("codigo,nombre\n1,Uno\n")
    expect(mala.ok).toBe(false)
    if (!mala.ok) expect(mala.errors[0].code).toBe("CSV_HEADER")
  })

  it("cabecera sola: 0 filas, sin error", () => {
    const result = parseNpgcCsv(`${HEADER}\n`)
    expect(result.ok && result.value).toEqual([])
  })

  it("un registro se parsea con todos los campos", () => {
    const result = parseNpgcCsv(
      `${HEADER}\n` +
        `7,Ventas e ingresos,1,,7,ACREEDORA,,,,0,0,1,\n` +
        `70,Ventas,2,7,7,ACREEDORA,,,,0,0,1,\n` +
        `705,Prestaciones de servicios,3,70,7,ACREEDORA,PYG,1. INCN,INGRESO_DIRECTO,0,0,1,1. INCN\n`
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[2]).toEqual({
      code: "705",
      name: "Prestaciones de servicios",
      level: 3,
      parentCode: "70",
      group: "7",
      nature: "ACREEDORA",
      statement: "PYG",
      epigraph: "1. INCN",
      analyticType: "INGRESO_DIRECTO",
      bidirectional: false,
      isContra: false,
      pymes: true,
      epigraphPymes: "1. INCN",
    })
  })

  it("rechaza padre inexistente, código con cero a la izquierda y nivel incoherente", () => {
    const huerfana = parseNpgcCsv(`${HEADER}\n${row("705")}\n`)
    expect(huerfana.ok).toBe(false)

    const ceroIzquierda = parseNpgcCsv(`${HEADER}\n0705,Mala,4,,0,DEUDORA,,,,0,0,1,\n`)
    expect(ceroIzquierda.ok).toBe(false)
    if (!ceroIzquierda.ok) expect(ceroIzquierda.errors[0].row).toBe(1)

    const nivelMalo = parseNpgcCsv(`${HEADER}\n7,Grupo,2,,7,DEUDORA,,,,0,0,1,\n`)
    expect(nivelMalo.ok).toBe(false)
    if (!nivelMalo.ok) expect(nivelMalo.errors[0].field).toBe("nivel")
  })

  it("rechaza enums desconocidos y duplicados", () => {
    const enumMalo = parseNpgcCsv(`${HEADER}\n7,Grupo,1,,7,MIXTA,,,,0,0,1,\n`)
    expect(enumMalo.ok).toBe(false)
    const duplicado = parseNpgcCsv(`${HEADER}\n${row("7", "A", "")}\n${row("7", "B", "")}\n`)
    expect(duplicado.ok).toBe(false)
  })
})

describe("planDiff (idempotencia, criterio 2)", () => {
  const incoming = seedRowsToPlanAccounts([
    { code: "7", name: "Ventas", level: 1, parentCode: null, group: "7", nature: "ACREEDORA", statement: null, epigraph: null, analyticType: null, bidirectional: false, isContra: false, pymes: true, epigraphPymes: null },
    { code: "70", name: "Ventas de mercaderías", level: 2, parentCode: "7", group: "7", nature: "ACREEDORA", statement: null, epigraph: null, analyticType: null, bidirectional: false, isContra: false, pymes: true, epigraphPymes: null },
    { code: "705", name: "Prestaciones de servicios", level: 3, parentCode: "70", group: "7", nature: "ACREEDORA", statement: "PYG", epigraph: "1. INCN", analyticType: "INGRESO_DIRECTO", bidirectional: false, isContra: false, pymes: true, epigraphPymes: "1. INCN" },
  ])

  it("plan vacío: se crea todo", () => {
    const diff = planDiff(buildPlan([]), incoming, "seed")
    expect(diff.create.map((a) => a.code)).toEqual(["7", "70", "705"])
    expect(diff.update).toEqual([])
    expect(diff.skip).toEqual([])
  })

  it("segunda pasada: 0 creadas, 0 actualizadas — y no pisa el renombrado del ADMIN", () => {
    const existente = incoming.map((a) => (a.code === "705" ? { ...a, name: "Honorarios", origin: "SEED" as const } : a))
    const diff = planDiff(buildPlan(existente), incoming, "seed")
    expect(diff.create).toEqual([])
    expect(diff.update).toEqual([])
    expect(diff.skip).toHaveLength(3)
  })

  it("policy `import` refresca la clasificación pero nunca el nombre", () => {
    const existente = incoming.map((a) =>
      a.code === "705" ? { ...a, name: "Honorarios", epigraph: "5. Otros", origin: "CSV_IMPORT" as const } : a
    )
    const diff = planDiff(buildPlan(existente), incoming, "import")
    expect(diff.update).toEqual([{ code: "705", patch: { epigraph: "1. INCN" } }])
  })

  it("policy `import` NO toca una cuenta creada a mano por el usuario", () => {
    const existente: PlanAccount[] = incoming.map((a) =>
      a.code === "705" ? { ...a, epigraph: "5. Otros", origin: "MANUAL" } : a
    )
    const diff = planDiff(buildPlan(existente), incoming, "import")
    expect(diff.update).toEqual([])
    expect(diff.skip).toContain("705")
  })

  it("I-E2-2: un padre existente pierde `isPostable` cuando llega su primer hijo", () => {
    const existente = buildPlan(seedRowsToPlanAccounts([]).concat([{ ...incoming[2], isPostable: true }]))
    const conHijo = seedRowsToPlanAccounts([
      { code: "7050", name: "Consultoría", level: 4, parentCode: "705", group: "7", nature: "ACREEDORA", statement: "PYG", epigraph: "1. INCN", analyticType: "INGRESO_DIRECTO", bidirectional: false, isContra: false, pymes: true, epigraphPymes: "1. INCN" },
    ])
    const diff = planDiff(existente, conHijo, "seed")
    expect(diff.postableChanges).toEqual([{ code: "705", isPostable: false }])
  })
})

describe("parseCustomPlanCsv (criterio 7, riesgo R4)", () => {
  const defaults = {
    nature: "DEUDORA" as const,
    statement: null,
    epigraphCatalog: new Set(["1. Importe neto de la cifra de negocios"]),
    delimiter: ";",
  }
  const mapping = { code: "Cuenta", name: "Descripción", statement: "Masa", epigraph: "Epígrafe" }

  it("importa un fichero con separador `;` y columnas mapeadas", () => {
    const csv =
      "Cuenta;Descripción;Masa;Epígrafe\n" +
      "705;Servicios;PyG;1. Importe neto de la cifra de negocios\n" +
      "430;Clientes;Activo;\n"
    const result = parseCustomPlanCsv(csv, mapping, defaults)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.map((r) => r.code)).toEqual(["430", "705"])
    expect(result.value[0].statement).toBe("BALANCE_ACTIVO")
    expect(result.value[1].statement).toBe("PYG")
  })

  it("rechaza TODO el fichero si una fila tiene código `0705`, y da su número de fila", () => {
    const csv = "Cuenta;Descripción;Masa;Epígrafe\n705;Servicios;PyG;\n0705;Mala;PyG;\n"
    const result = parseCustomPlanCsv(csv, mapping, defaults)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0].row).toBe(2)
      expect(result.errors[0].code).toBe("CSV_ROW")
    }
  })

  it("rechaza un epígrafe fuera del catálogo (R-15)", () => {
    const csv = "Cuenta;Descripción;Masa;Epígrafe\n705;Servicios;PyG;Ventas varias\n"
    const result = parseCustomPlanCsv(csv, mapping, defaults)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0].code).toBe("CSV_ROW")
  })

  it("un fichero sin filas de datos falla; sin las columnas obligatorias, también", () => {
    expect(parseCustomPlanCsv("Cuenta;Descripción\n", mapping, defaults).ok).toBe(false)
    expect(parseCustomPlanCsv("A;B\n1;2\n", mapping, defaults).ok).toBe(false)
  })

  it("un `;` dentro de comillas sobrevive al import completo (hallazgo 6)", () => {
    const csv = 'Cuenta;Descripción;Masa;Epígrafe\n705;"Servicios; consultoría";PyG;\n'
    const result = parseCustomPlanCsv(csv, mapping, defaults)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0].name).toBe("Servicios; consultoría")
  })

  it("rechaza un fichero con más de MAX_IMPORT_ROWS filas (hallazgo 8)", () => {
    const filas = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `${700000 + i};Cuenta ${i};PyG;`).join("\n")
    const result = parseCustomPlanCsv(`Cuenta;Descripción;Masa;Epígrafe\n${filas}\n`, mapping, defaults)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0].message).toContain(String(MAX_IMPORT_ROWS))
  })

  it("el error de padre huérfano señala el nº de fila del fichero (hallazgo 9)", () => {
    const csv = "Cuenta;Descripción;Masa;Epígrafe\n705;Servicios;PyG;\n999999;Rara;PyG;\n"
    const parsed = parseCustomPlanCsv(csv, mapping, defaults)
    if (!parsed.ok) throw new Error("import fallido")
    const numeros = rowNumbersByCode(csv, mapping, ";")
    expect(numeros.get("999999")).toBe(2)
    const resolved = resolveImportedParents(parsed.value, buildPlan([]), numeros)
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) {
      const huerfana = resolved.errors.find((e) => e.message.includes("999999"))
      expect(huerfana?.row).toBe(2)
    }
  })

  it("resolveImportedParents cuelga las filas del plan existente", () => {
    const csv = "Cuenta;Descripción;Masa;Epígrafe\n7050001;Cliente X;PyG;\n"
    const parsed = parseCustomPlanCsv(csv, mapping, defaults)
    if (!parsed.ok) throw new Error("import fallido")
    const plan = buildPlan(
      seedRowsToPlanAccounts([
        { code: "705", name: "Servicios", level: 3, parentCode: null, group: "7", nature: "ACREEDORA", statement: "PYG", epigraph: null, analyticType: null, bidirectional: false, isContra: false, pymes: true, epigraphPymes: null },
      ])
    )
    const resolved = resolveImportedParents(parsed.value, plan)
    expect(resolved.ok && resolved.value[0].parentCode).toBe("705")

    const huerfana = resolveImportedParents(
      [{ ...parsed.value[0], code: "999999" }],
      buildPlan([])
    )
    expect(huerfana.ok).toBe(false)
  })
})
