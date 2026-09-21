/**
 * E12 · ronda 1 (auditor H-4) — **los FAIL que produce el SUSTRATO**, en un
 * solo sitio.
 *
 * La organización efímera de la suite de aceptación y la del fixture de CI
 * nacen igual: por el motor, con el fixture `ejercicio-completo`, sin alta de
 * plataforma y sin retención ejecutada. Eso deja unos pocos invariantes en FAIL
 * **por lo que la organización ES**, no por lo que el producto hace mal.
 *
 * La lista está aquí, y no duplicada en dos ficheros, porque el hallazgo H-4 fue
 * exactamente ése: la suite de aceptación los declaraba con su motivo y el job
 * de CI **no hacía esa distinción** — sembraba un barrido con sello
 * `REQUIERE REVISIÓN`, lo publicaba en el resumen del PR y **seguía en verde**.
 * Un job verde con un sello rojo es peor que un job rojo.
 *
 * **Reglas de esta lista**, y son las que la hacen un control y no una excusa:
 *
 *  1. es **cerrada**: cualquier FAIL que no esté aquí pone el job en rojo;
 *  2. cada entrada lleva **su motivo escrito**, y el motivo dice por qué es del
 *     sustrato y no del producto;
 *  3. quitar un FAIL de aquí nunca rompe nada —si ya no ocurre, no ocurre—;
 *     añadir uno es una decisión que se lee en el diff.
 */

export const FAIL_DEL_SUSTRATO: Readonly<Record<string, string>> = {
  "I-E9-14":
    "el fixture no abre el ejercicio siguiente, así que la apertura no puede casar línea a línea con el cierre de 2026",
  "I-E11-5":
    "la organización de la suite nace por SQL de arnés, sin el alta de plataforma que le daría suscripción (E11 · D9)",
  "I-E11-10":
    "sin política de retención ejecutada sobre una organización recién creada no hay purga que comprobar",
  "I-E8-17":
    "el puente al 111 compara el abono a 4751 del diario con lo PRACTICADO según la propuesta de la extracción, y las " +
    "retenciones del fixture se contabilizan por plantilla, sin documento: con sustrato documental cargado el bloque se " +
    "evalúa y el término practicado es 0. Es el fixture, no el producto (ronda 1 de E12, anotado para E14)",
}

/** Los FAIL que NO están declarados. Si hay alguno, quien llame se pone rojo. */
export function failesNoDeclarados(ids: readonly string[]): string[] {
  return [...new Set(ids)].filter((id) => FAIL_DEL_SUSTRATO[id] === undefined).sort()
}

/**
 * E12 · **ronda 2 (H-4 PARCIAL del auditor)** — el criterio del sello, de
 * verdad.
 *
 * La ronda 1 escribió la puerta así:
 *
 * ```ts
 * const selloLimpio = sello === "VALIDADO AUTOMÁTICAMENTE" || fallos.length > 0
 * ```
 *
 * y eso es **vacuo**: el sustrato deja SIEMPRE tres FAIL declarados, así que la
 * segunda rama es siempre cierta y la primera no se evalúa nunca. El job podía
 * publicar en el resumen del PR un sello `REQUIERE REVISIÓN` por **cualquier**
 * motivo —un aviso por encima del umbral, un cambio de motor, una revisión
 * forzada, una excepción de operador viva— y seguir en verde. La puerta de los
 * FAIL no declarados sí funcionaba, y es lo que salvaba el job; el sello, no.
 *
 * El criterio correcto no cuenta FAIL: **mira cada razón del sello y exige que
 * esté explicada por la lista cerrada de arriba**. Una y sólo una clase de
 * razón puede estarlo —la que enumera los invariantes en FAIL, y sólo si TODOS
 * los que enumera están declarados—; cualquier otra razón, sea de la naturaleza
 * que sea, deja el sello rojo **fuera** de la lista y pone el job en rojo.
 *
 * Así el criterio 13 («el ciclo sale con sello VALIDADO AUTOMÁTICAMENTE») pasa a
 * ser comprobable sobre el fixture de CI: o el sello está verde, o su rojez está
 * enteramente declarada con motivo escrito. Nada más.
 */
export type RazonDeSello = { kind: string; message: string; code?: string }

/** El prefijo con el que `seal()` enumera los invariantes en FAIL. */
const PREFIJO_INVARIANTES = "invariantes en FAIL: "

/**
 * Las razones del sello que la lista cerrada **no** explica, cada una con el
 * motivo por el que no lo está. Vacío ⇔ el sello rojo es enteramente del
 * sustrato declarado.
 */
export function motivosNoExplicadosPorElSustrato(razones: readonly RazonDeSello[]): string[] {
  const out: string[] = []
  for (const razon of razones) {
    if (razon.kind === "INVARIANTE" && razon.message.startsWith(PREFIJO_INVARIANTES)) {
      const ids = razon.message
        .slice(PREFIJO_INVARIANTES.length)
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id !== "")
      const noDeclarados = failesNoDeclarados(ids)
      if (noDeclarados.length > 0) {
        out.push(`invariante(s) en FAIL sin declarar: ${noDeclarados.join(", ")}`)
      }
      continue
    }
    out.push(`${razon.kind} · ${razon.message}`)
  }
  return out
}
