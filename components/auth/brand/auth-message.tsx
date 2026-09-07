/**
 * E13 · T5 — Mensajes de error/éxito de los formularios de acceso.
 *
 * Sin rojo/verde semáforo (marca CFOnomic): el error es texto carbón sobre blanco con borde izquierdo 2px
 * carbón y prefijo "⚠"; el éxito usa el mismo tratamiento sin el prefijo de aviso. `role="alert"` para que
 * el lector de pantalla lo anuncie; el `id` se pasa como `errorId` a `LineInput` vía `aria-describedby`.
 */
export function AuthError({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <p
      id={id}
      role="alert"
      className="border-l-2 border-[var(--nomic-carbon)] bg-[var(--nomic-white)] py-1 pl-3 font-[family-name:var(--font-open-sans)] text-sm text-[var(--nomic-carbon)]"
    >
      <span aria-hidden="true">⚠ </span>
      {children}
    </p>
  )
}

export function AuthSuccess({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <p
      id={id}
      role="status"
      className="border-l-2 border-[var(--nomic-carbon)] bg-[var(--nomic-white)] py-1 pl-3 font-[family-name:var(--font-open-sans)] text-sm text-[var(--nomic-carbon)]"
    >
      {children}
    </p>
  )
}
