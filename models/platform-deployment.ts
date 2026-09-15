/**
 * E11 · ola C — **¿están desplegadas las tablas de plataforma?**
 *
 * Las pantallas de suscripción y de copias (T22) leen tablas que crean las
 * migraciones M1, M2 y M5 (olas A y B). Durante la épica, y en cualquier
 * instalación que todavía no las haya aplicado, esas tablas **no existen**: la
 * consulta no devuelve vacío, falla con `42P01`.
 *
 * Lo que este módulo evita es la única salida mala: que la pantalla reviente con
 * un error de Postgres delante del usuario. Lo que **no** hace es fingir que hay
 * datos: si las tablas no están, la pantalla lo dice con todas las letras. Nunca
 * un cero que en realidad es un «no lo sé».
 *
 * Es un puente con fecha de caducidad: en cuanto las tres migraciones estén
 * aplicadas en todos los entornos, `platformDeployment()` devuelve `ready` y el
 * aviso desaparece solo.
 */

import type { AnyClient } from "@/models/ledger"

export type PlatformDeployment = {
  /** `subscriptions` + `plans`: el plan, su estado y sus límites. */
  billing: boolean
  /** `usage_runs`: las seis cifras del mes. */
  usage: boolean
  /** `backup_jobs` + `restore_jobs`: las copias y sus verificaciones. */
  backups: boolean
  /** `platform_invoices`: nuestras facturas con su serie. */
  invoices: boolean
}

/** Una sola consulta, sin catálogo por tabla: `to_regclass` no lanza si falta. */
export async function platformDeployment(db: AnyClient): Promise<PlatformDeployment> {
  const rows = await db.$queryRaw<
    { subscriptions: string | null; plans: string | null; usage_runs: string | null; backup_jobs: string | null; restore_jobs: string | null; platform_invoices: string | null }[]
  >`
    SELECT to_regclass('public.subscriptions')::text      AS subscriptions,
           to_regclass('public.plans')::text              AS plans,
           to_regclass('public.usage_runs')::text         AS usage_runs,
           to_regclass('public.backup_jobs')::text        AS backup_jobs,
           to_regclass('public.restore_jobs')::text       AS restore_jobs,
           to_regclass('public.platform_invoices')::text  AS platform_invoices`
  const row = rows[0]
  return {
    billing: Boolean(row?.subscriptions && row?.plans),
    usage: Boolean(row?.usage_runs),
    backups: Boolean(row?.backup_jobs && row?.restore_jobs),
    invoices: Boolean(row?.platform_invoices),
  }
}
