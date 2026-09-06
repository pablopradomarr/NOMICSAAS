/**
 * E8 · ronda 1 (QA · BUG-E8-2) — el contrato de «documento no disponible».
 *
 * Vive aparte del `route.ts` porque un módulo de ruta de Next sólo puede
 * exportar los verbos HTTP y su configuración, y porque el visor —que es
 * cliente— necesita las mismas constantes que el servidor.
 *
 * **Por qué un estado y no un 404.** Una ficha de `files` cuyos bytes no están
 * en el almacén no es «no encontrado»: es un documento que existió, que
 * respalda un asiento y que ya no se puede enseñar. Confundirlo con el 404 de
 * «no es tuyo» dejaba al revisor mirando un hueco sin explicación mientras
 * I-E8-2 marcaba FAIL en la pestaña Auditoría por ese mismo fichero.
 */

/** Cabecera con la que el visor distingue «no disponible» de «no existe». */
export const DOCUMENT_STATUS_HEADER = "X-Document-Status"

/** Valor de esa cabecera cuando la ficha existe y los bytes no. */
export const DOCUMENT_UNAVAILABLE = "NO_DISPONIBLE"

/** `410 Gone`: el recurso existió y ya no está. No es un 404. */
export const DOCUMENT_UNAVAILABLE_STATUS = 410

export type PreviewUnavailable = {
  status: typeof DOCUMENT_UNAVAILABLE
  fileId: string
  path: string | null
  message: string
}
