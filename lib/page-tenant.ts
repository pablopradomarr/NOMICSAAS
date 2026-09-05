import { AuthzError, requireOrg, type OrgContext } from "@/lib/authz"
import { runWithRequestTenant } from "@/lib/db"
import { Role } from "@/prisma/client"
import { notFound, redirect } from "next/navigation"
import type { ReactNode } from "react"

/**
 * E6-perf · una transacción por petición en los Server Components.
 *
 * ## El problema
 * `tenantDb(orgId)` envuelve CADA operación en su propia transacción para poder
 * fijar `app.current_org` con `SET LOCAL` (barrera 2, RLS). Una página como
 * `/settings/fiscal-years` hace tres lecturas, `/ledger` seis, y el layout otras
 * tres **en paralelo con la página**: con el `max: 10` que trae `pg` por
 * defecto, dos pestañas abiertas agotaban el pool y Prisma cortaba con
 * «Transaction API error: Unable to start a transaction in the given time».
 *
 * ## La forma de la solución
 * `tenantPage()` resuelve la organización con `requireOrg`, abre UNA
 * `tenantTransaction` para todo el render y la publica en el AsyncLocalStorage.
 * El `db` que recibe el cuerpo de la página es el de siempre (`TenantClient`),
 * pero la extensión de tenant ya encuentra la transacción abierta y despacha
 * cada operación sobre ella: cero cambios en `models/`, una sola conexión.
 *
 * ## Reglas de uso
 * - **Nada de `Promise.all` de lecturas** dentro del cuerpo: comparten conexión,
 *   `pg` las encola igual (no hay paralelismo que ganar) y emite el
 *   DeprecationWarning «client is already executing a query». En serie.
 * - **Nada asíncrono que escape del cuerpo.** Todo lo que consulte la base tiene
 *   que estar `await`-eado ANTES de devolver el JSX: un Server Component hijo
 *   que consultara por su cuenta lo haría con la transacción ya cerrada. Las
 *   páginas de este repositorio pasan datos ya resueltos a componentes de
 *   cliente, que es justamente lo que hace esto seguro.
 * - `readOnly: true` (por defecto en las páginas que no emiten `ReportRun`)
 *   convierte la transacción en `READ ONLY`: la BASE rechaza una escritura desde
 *   un RSC con el error 25006, no la buena voluntad de quien la escribe.
 */
export type TenantPageOptions = {
  /** Rol mínimo. Por defecto `VIEWER`. */
  minRole?: Role
  /**
   * Responder 404 en lugar de propagar el `FORBIDDEN`. Para las pantallas de
   * administración que no deben confirmar siquiera que existen (miembros).
   */
  notFoundOnForbidden?: boolean
  /**
   * `SET TRANSACTION READ ONLY`. Se deja en `false` en las páginas que llaman a
   * una server action que persiste algo (los informes y el panel emiten un
   * `ReportRun` sellado durante el render).
   */
  readOnly?: boolean
}

/** Props de una página cuyos filtros viven en la URL. */
export type SearchParamsProps = { searchParams: Promise<Record<string, string | string[] | undefined>> }

/** Lo que ve el cuerpo de la página: el contexto de organización + sus props. */
export type TenantPageContext<Props> = OrgContext & Props

/**
 * Envuelve el cuerpo de una página RSC. Uso:
 *
 * ```tsx
 * export default tenantPage(async ({ db, org, role, searchParams }) => { … })
 * export default tenantPage(async ({ db, org }) => { … }, { minRole: Role.ADMIN })
 * ```
 */
export function tenantPage<Props extends object = Record<string, never>>(
  render: (context: TenantPageContext<Props>) => Promise<ReactNode>,
  options: TenantPageOptions = {}
): (props: Props) => Promise<ReactNode> {
  const { minRole = Role.VIEWER, notFoundOnForbidden = false, readOnly = true } = options

  return async function TenantPage(props: Props): Promise<ReactNode> {
    let context: OrgContext
    try {
      context = await requireOrg(minRole)
    } catch (error) {
      if (error instanceof AuthzError) {
        // Sin organización no hay nada que renderizar: se va a crear la primera.
        if (error.code === "NO_ORGANIZATION") redirect("/organizations/new")
        if (notFoundOnForbidden) notFound()
      }
      throw error
    }

    return await runWithRequestTenant(
      context.org.id,
      context.user.id,
      async () => await render({ ...props, ...context }),
      { readOnly }
    )
  }
}

/** Alias con la otra forma de nombrarlo; misma función. */
export const withPageTenant = tenantPage
