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
