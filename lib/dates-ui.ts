/**
 * Formato de fechas para pantalla **en UTC**, idéntico en servidor y navegador.
 *
 * `new Date(iso).toLocaleDateString("es-ES")` formatea con la zona horaria de
 * quien lo ejecuta. El servidor corre en UTC y el navegador en Europe/Madrid,
 * así que durante las dos horas anteriores a medianoche UTC devuelven **días
 * distintos**: React lo denuncia como desajuste de hidratación, regenera el
 * árbol y la pantalla deja de responder a la navegación mientras dura. Lo
 * destapó el e2e de la bandeja a las 22:5x UTC, y no es un artefacto del arnés:
 * un usuario en España que abriera la bandeja a la una de la madrugada veía lo
 * mismo.
 *
 * Se formatea desde las piezas UTC del ISO, que son las mismas en los dos
 * lados. Son **fechas de auditoría** (subida, extracción): las que deciden el
 * trimestre de IVA o el ejercicio son `LocalDate` (`YYYY-MM-DD`) y no pasan por
 * aquí, porque no llevan hora ni zona.
 */

const dosDigitos = (n: number): string => String(n).padStart(2, "0")

/** `d/m/aaaa` en UTC. */
export function fechaUtc(iso: string | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`
}

/** `d/m/aaaa, hh:mm` en UTC. */
export function fechaHoraUtc(iso: string | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return `${fechaUtc(d)}, ${dosDigitos(d.getUTCHours())}:${dosDigitos(d.getUTCMinutes())}`
}
