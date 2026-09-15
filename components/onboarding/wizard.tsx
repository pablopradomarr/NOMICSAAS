"use client"

/**
 * E11 · ola C · **T14** — el asistente de alta, seis pasos (§6.2, §10).
 *
 * Reanudable (el paso vive en `OnboardingRun.step`, no en el navegador), con
 * barra de progreso y «volver atrás» sin perder lo escrito. Cada paso enseña
 * **qué se ha sembrado**, no un spinner.
 *
 * Nada se calcula aquí: el componente pinta lo que el servidor le da.
 */

import {
  onboardingCompanyAction,
  onboardingDeleteDemoAction,
  onboardingFinishAction,
  onboardingFiscalYearAction,
  onboardingGotoStepAction,
  onboardingInviteAction,
  onboardingLoadDemoAction,
  onboardingRenamePrefixAction,
  type CompanyResult,
  type InvitesResult,
} from "@/app/(onboarding)/onboarding/actions"
import { SeedReportTable } from "@/components/onboarding/seed-report"
import { FormError } from "@/components/forms/error"
import { FormInput, FormSelect } from "@/components/forms/simple"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { BASE_CURRENCY_OPTIONS, PGC_VARIANT_OPTIONS, ROLE_OPTIONS, TIMEZONE_OPTIONS } from "@/lib/organization-options"
import type { SeedReport } from "@/models/onboarding"
import type { OnboardingStep } from "@/prisma/client"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useActionState, useState, useTransition } from "react"

/**
 * Los seis pasos como literales, y no el enum de Prisma: importar un VALOR de
 * `@/prisma/client` en un componente de cliente arrastra el cliente de Prisma
 * —y con él los módulos de Node— al paquete del navegador, y la compilación
 * falla. Los tipos sí se importan: se borran al compilar.
 */
const STEP = {
  COMPANY: "COMPANY",
  PLAN_ACCOUNTS: "PLAN_ACCOUNTS",
  FISCAL_YEAR: "FISCAL_YEAR",
  MEMBERS: "MEMBERS",
  DEMO: "DEMO",
  DONE: "DONE",
} as const satisfies Record<OnboardingStep, OnboardingStep>


export type WizardSeries = { id: string; code: string; kind: "ORDINARIA" | "RECTIFICATIVA"; prefix: string; issued: number }
export type WizardFiscalYear = { code: string; startDate: string; endDate: string; entries: number }
export type WizardOrganization = { id: string; name: string; pgcVariant: string; baseCurrency: string }

const STEPS: { step: OnboardingStep; label: string }[] = [
  { step: STEP.COMPANY, label: "Empresa" },
  { step: STEP.PLAN_ACCOUNTS, label: "Plan de cuentas" },
  { step: STEP.FISCAL_YEAR, label: "Ejercicio" },
  { step: STEP.MEMBERS, label: "Equipo" },
  { step: STEP.DEMO, label: "Demostración" },
  { step: STEP.DONE, label: "Listo" },
]

export function OnboardingWizard(props: {
  step: OnboardingStep
  organization: WizardOrganization | null
  report: SeedReport | null
  series: WizardSeries[]
  fiscalYear: WizardFiscalYear | null
  demo: { id: string; name: string; slug: string } | null
}) {
  const index = Math.max(0, STEPS.findIndex((s) => s.step === props.step))

  return (
    <div className="space-y-8 p-10 pb-16" data-testid="onboarding-wizard" data-step={props.step}>
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Puesta en marcha</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Seis pasos. Puedes salir y volver cuando quieras: el asistente recuerda por dónde ibas.
        </p>
      </header>

      <ProgressBar index={index} />

      <Separator />

      {props.step === STEP.COMPANY && <StepCompany />}
      {props.step === STEP.PLAN_ACCOUNTS && (
        <StepPlanAccounts organization={props.organization} report={props.report} series={props.series} />
      )}
      {props.step === STEP.FISCAL_YEAR && <StepFiscalYear fiscalYear={props.fiscalYear} />}
      {props.step === STEP.MEMBERS && <StepMembers />}
      {props.step === STEP.DEMO && <StepDemo demo={props.demo} />}
      {props.step === STEP.DONE && <StepDone report={props.report} demo={props.demo} />}
    </div>
  )
}

function ProgressBar({ index }: { index: number }) {
  return (
    <ol className="flex flex-wrap gap-2 text-xs" data-testid="onboarding-progress">
      {STEPS.map((s, i) => (
        <li
          key={s.step}
          aria-current={i === index ? "step" : undefined}
          className={
            i === index
              ? "rounded-sm bg-foreground px-2 py-1 font-medium text-background"
              : i < index
                ? "rounded-sm bg-muted px-2 py-1 text-muted-foreground"
                : "rounded-sm border px-2 py-1 text-muted-foreground"
          }
        >
          {i + 1}. {s.label}
        </li>
      ))}
    </ol>
  )
}

/** «Volver atrás» y «continuar»: el paso es un dato del servidor, no un salto. */
function StepNav({ back, next, nextLabel }: { back?: OnboardingStep; next?: OnboardingStep; nextLabel?: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const go = (step: OnboardingStep) =>
    start(async () => {
      const result = await onboardingGotoStepAction({ step })
      if (!result.success) setError(result.error ?? "No se ha podido cambiar de paso")
      else router.refresh()
    })

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        {back && (
          <Button variant="outline" size="sm" disabled={pending} onClick={() => go(back)} data-testid="onboarding-back">
            Volver atrás
          </Button>
        )}
        {next && (
          <Button size="sm" disabled={pending} onClick={() => go(next)} data-testid="onboarding-next">
            {pending ? "Guardando…" : (nextLabel ?? "Continuar")}
          </Button>
        )}
      </div>
      {error && <FormError>{error}</FormError>}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Paso 1 · Empresa
// ─────────────────────────────────────────────────────────────────────────────

function StepCompany() {
  const router = useRouter()
  const [state, action, pending] = useActionState(
    async (prev: Awaited<ReturnType<typeof onboardingCompanyAction>> | null, formData: FormData) => {
      const result = await onboardingCompanyAction(prev, formData)
      // A `/onboarding` SIN `?nueva=1`: con el parámetro puesto, el asistente
      // volvería a enseñar el paso 1 —«dar de alta otra»— en vez de continuar
      // con la que se acaba de crear.
      if (result.success) router.replace("/onboarding")
      return result
    },
    null as { success: boolean; error?: string; data?: CompanyResult } | null
  )

  return (
    <section className="space-y-6" data-testid="step-company">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">1 · Tu empresa</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Con estos datos se crea la organización y, en la misma operación, su plan contable, el mapa de cuentas de
          sistema, los tipos impositivos, el ejercicio y las series de facturación. Si algo fallara, no se guarda nada.
        </p>
      </div>

      <form action={action} className="max-w-2xl space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormInput title="Nombre" name="name" placeholder="Estudio Norte SL" required maxLength={128} autoFocus />
          <FormInput title="NIF / CIF" name="taxId" placeholder="B12345678" maxLength={32} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormSelect title="Moneda base" name="baseCurrency" items={[...BASE_CURRENCY_OPTIONS]} defaultValue="EUR" />
          <FormSelect title="Zona horaria" name="timezone" items={[...TIMEZONE_OPTIONS]} defaultValue="Europe/Madrid" />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <FormSelect
              title="Variante del Plan General Contable"
              name="pgcVariant"
              items={[...PGC_VARIANT_OPTIONS]}
              defaultValue="PYMES"
            />
            <p className="text-xs text-muted-foreground">
              PYMES es el plan abreviado; GENERAL incluye además los grupos 8 y 9.
            </p>
          </div>
          <div className="space-y-1">
            <FormInput title="Prefijo de la serie de facturación" name="seriesPrefix" defaultValue="FAC" maxLength={16} />
            <p className="text-xs text-muted-foreground">
              Se crean dos series, ordinaria y rectificativa, con el contador a cero. El prefijo se puede cambiar
              mientras no se haya expedido ninguna factura.
            </p>
          </div>
        </div>

        <Button type="submit" disabled={pending} data-testid="company-submit">
          {pending ? "Creando y sembrando…" : "Crear la organización"}
        </Button>

        {state && !state.success && <FormError>{state.error}</FormError>}
      </form>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Paso 2 · Plan de cuentas y series
// ─────────────────────────────────────────────────────────────────────────────

function StepPlanAccounts({
  organization,
  report,
  series,
}: {
  organization: WizardOrganization | null
  report: SeedReport | null
  series: WizardSeries[]
}) {
  return (
    <section className="space-y-6" data-testid="step-plan-accounts">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">2 · Esto es lo que se ha sembrado</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Variante <strong>{organization?.pgcVariant ?? "—"}</strong>, moneda base{" "}
          <strong>{organization?.baseCurrency ?? "—"}</strong>. Puedes revisar el árbol completo y cargar un plan propio
          desde Configuración → Plan de cuentas.
        </p>
      </div>

      <SeedReportTable report={report} />

      <Separator />

      <SeriesPrefixPanel series={series} />

      <div className="flex flex-wrap gap-3">
        <Button asChild variant="outline" size="sm">
          <Link href="/settings/accounts">Ver el plan de cuentas</Link>
        </Button>
      </div>

      <StepNav back={STEP.COMPANY} next={STEP.FISCAL_YEAR} />
    </section>
  )
}

function SeriesPrefixPanel({ series }: { series: WizardSeries[] }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  if (series.length === 0) {
    return <p className="text-sm text-muted-foreground">No hay ninguna serie de facturación dada de alta.</p>
  }

  const rename = (seriesId: string, prefix: string) =>
    start(async () => {
      setError(null)
      setOk(null)
      const result = await onboardingRenamePrefixAction({ seriesId, prefix })
      if (!result.success) setError(result.error ?? "No se ha podido cambiar el prefijo")
      else {
        setOk(`Prefijo cambiado a ${result.data?.prefix}`)
        router.refresh()
      }
    })

  return (
    <div className="space-y-3" data-testid="series-panel">
      <h3 className="text-base font-semibold">Series de facturación</h3>
      <p className="max-w-2xl text-sm text-muted-foreground">
        El prefijo sólo se puede cambiar mientras la serie no haya expedido ninguna factura (art. 6.1.a RD 1619/2012).
        A partir del primer número, la serie identifica facturas ya emitidas y renombrarla las reescribiría.
      </p>
      {series.map((s) => (
        <form
          key={s.id}
          className="flex flex-wrap items-end gap-3"
          data-testid={`series-${s.kind}`}
          action={(formData) => rename(s.id, String(formData.get("prefix") ?? ""))}
        >
          <FormInput
            title={s.kind === "ORDINARIA" ? "Serie ordinaria" : "Serie rectificativa"}
            name="prefix"
            defaultValue={s.prefix}
            maxLength={16}
            disabled={s.issued > 0}
          />
          <span className="pb-2 font-mono text-xs text-muted-foreground">
            {s.issued === 0 ? "sin números emitidos" : `${s.issued} número(s) emitido(s)`}
          </span>
          <Button type="submit" size="sm" variant="outline" disabled={pending || s.issued > 0}>
            Cambiar prefijo
          </Button>
        </form>
      ))}
      {ok && <p className="text-xs text-muted-foreground">{ok}</p>}
      {error && <FormError>{error}</FormError>}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Paso 3 · Ejercicio
// ─────────────────────────────────────────────────────────────────────────────

function StepFiscalYear({ fiscalYear }: { fiscalYear: WizardFiscalYear | null }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const submit = (formData: FormData) =>
    start(async () => {
      setError(null)
      const result = await onboardingFiscalYearAction({
        code: String(formData.get("code") ?? ""),
        startDate: String(formData.get("startDate") ?? ""),
        endDate: String(formData.get("endDate") ?? ""),
      })
      if (!result.success) setError(result.error ?? "No se ha podido ajustar el ejercicio")
      else router.refresh()
    })

  return (
    <section className="space-y-6" data-testid="step-fiscal-year">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">3 · Tu primer ejercicio</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          El alta creó un ejercicio provisional por año natural. Aquí se <strong>ajusta</strong>: no se crea otro, para
          que nunca haya dos solapados.
        </p>
      </div>

      {!fiscalYear ? (
        <p className="text-sm text-muted-foreground">Esta organización no tiene ningún ejercicio.</p>
      ) : fiscalYear.entries > 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="fiscal-year-locked">
          El ejercicio <strong>{fiscalYear.code}</strong> ya tiene {fiscalYear.entries} asiento(s): sus fechas no se
          cambian desde el asistente. Ve a Configuración → Ejercicios si necesitas revisarlo.
        </p>
      ) : (
        <form action={submit} className="flex max-w-2xl flex-wrap items-end gap-4">
          <FormInput title="Código" name="code" defaultValue={fiscalYear.code} maxLength={16} />
          <FormInput title="Inicio" name="startDate" type="date" defaultValue={fiscalYear.startDate} required />
          <FormInput title="Fin" name="endDate" type="date" defaultValue={fiscalYear.endDate} required />
          <Button type="submit" size="sm" disabled={pending} data-testid="fiscal-year-submit">
            {pending ? "Guardando…" : "Guardar y continuar"}
          </Button>
        </form>
      )}

      {error && <FormError>{error}</FormError>}

      <StepNav back={STEP.PLAN_ACCOUNTS} next={STEP.MEMBERS} nextLabel="Saltar este paso" />
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Paso 4 · Equipo
// ─────────────────────────────────────────────────────────────────────────────

function StepMembers() {
  const router = useRouter()
  const [state, action, pending] = useActionState(
    async (prev: Awaited<ReturnType<typeof onboardingInviteAction>> | null, formData: FormData) => {
      const result = await onboardingInviteAction(prev, formData)
      if (result.success) router.refresh()
      return result
    },
    null as { success: boolean; error?: string; data?: InvitesResult } | null
  )

  return (
    <section className="space-y-6" data-testid="step-members">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">4 · Tu equipo</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Escribe los correos separados por coma o salto de línea. Consulta ve todo sin poder editar; Edición registra
          operaciones; Administración además configura y gestiona personas. Puedes saltarte este paso.
        </p>
      </div>

      <form action={action} className="max-w-2xl space-y-4">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Correos</span>
          <textarea
            name="emails"
            rows={3}
            className="w-full rounded-md border bg-background p-2 text-sm"
            placeholder="ana@estudionorte.es, luis@estudionorte.es"
            data-testid="invite-emails"
          />
        </label>
        <FormSelect title="Rol" name="role" items={[...ROLE_OPTIONS]} defaultValue="EDITOR" />
        <Button type="submit" size="sm" disabled={pending} data-testid="invite-submit">
          {pending ? "Invitando…" : "Enviar invitaciones"}
        </Button>
        {state && !state.success && <FormError>{state.error}</FormError>}
      </form>

      {state?.success && state.data && (
        <div className="space-y-2 text-sm" data-testid="invite-result">
          {state.data.invited.length > 0 && (
            <ul className="space-y-1">
              {state.data.invited.map((i) => (
                <li key={i.email}>
                  <span className="font-medium">{i.email}</span>
                  {i.inviteUrl && <span className="ml-2 font-mono text-xs text-muted-foreground">{i.inviteUrl}</span>}
                </li>
              ))}
            </ul>
          )}
          {state.data.skipped.map((s) => (
            <p key={s.email} className="text-xs text-muted-foreground">
              {s.email}: {s.reason}
            </p>
          ))}
        </div>
      )}

      <StepNav back={STEP.FISCAL_YEAR} next={STEP.DEMO} nextLabel="Saltar este paso" />
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Paso 5 · Demo, en su propia organización (O-6)
// ─────────────────────────────────────────────────────────────────────────────

function StepDemo({ demo }: { demo: { id: string; name: string; slug: string } | null }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<{ name: string; entries: number } | null>(null)

  const load = () =>
    start(async () => {
      setError(null)
      const result = await onboardingLoadDemoAction()
      if (!result.success) setError(result.error ?? "No se han podido cargar los datos de demostración")
      else {
        setLoaded({ name: result.data?.name ?? "", entries: result.data?.entries ?? 0 })
        router.refresh()
      }
    })

  const remove = (id: string) =>
    start(async () => {
      setError(null)
      const result = await onboardingDeleteDemoAction(id)
      if (!result.success) setError(result.error ?? "No se ha podido borrar la organización de demostración")
      else router.refresh()
    })

  return (
    <section className="space-y-6" data-testid="step-demo">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">5 · ¿Quieres datos de ejemplo?</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Los datos de demostración se cargan en una <strong>organización aparte</strong>, nunca en la tuya: así tus
          libros nacen limpios y la demostración se puede borrar entera cuando ya no la necesites. Los asientos se
          contabilizan por el mismo motor que usarás tú, con su validación y su cuadre.
        </p>
      </div>

      {demo ? (
        <div className="space-y-3" data-testid="demo-present">
          <p className="text-sm">
            Organización de demostración: <strong>{demo.name}</strong>
          </p>
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" size="sm" disabled={pending} onClick={() => remove(demo.id)} data-testid="demo-delete">
              {pending ? "Borrando…" : "Borrar la organización de demostración"}
            </Button>
          </div>
          <p className="max-w-2xl text-xs text-muted-foreground">
            Se borra la organización entera. No existe ningún botón que borre un asiento contabilizado: un asiento sólo
            se anula con su contra-asiento.
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          <Button size="sm" disabled={pending} onClick={load} data-testid="demo-load">
            {pending ? "Contabilizando el ejemplo…" : "Sí, crear la organización de demostración"}
          </Button>
        </div>
      )}

      {loaded && (
        <p className="text-sm" data-testid="demo-loaded">
          Creada <strong>{loaded.name}</strong> con {loaded.entries} asiento(s) contabilizados por el motor.
        </p>
      )}
      {error && <FormError>{error}</FormError>}

      <StepNav back={STEP.MEMBERS} next={STEP.DONE} nextLabel="No, gracias" />
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Paso 6 · Listo
// ─────────────────────────────────────────────────────────────────────────────

function StepDone({ report, demo }: { report: SeedReport | null; demo: { id: string; name: string } | null }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const finish = () =>
    start(async () => {
      setError(null)
      const result = await onboardingFinishAction()
      if (!result.success) setError(result.error ?? "No se ha podido cerrar el asistente")
      else router.push("/dashboard")
    })

  return (
    <section className="space-y-6" data-testid="step-done">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">6 · Todo listo</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Tu organización está configurada y puede contabilizar. Esto es lo que quedó sembrado:
        </p>
      </div>

      <SeedReportTable report={report} />

      {demo && (
        <p className="text-sm text-muted-foreground">
          Tienes además la organización de demostración <strong>{demo.name}</strong>, que puedes borrar entera cuando
          quieras desde el conmutador de organizaciones.
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <Button size="sm" disabled={pending} onClick={finish} data-testid="onboarding-finish">
          {pending ? "Cerrando…" : "Ir al panel"}
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href="/settings/organization">Ajustar las preferencias</Link>
        </Button>
      </div>
      {error && <FormError>{error}</FormError>}
    </section>
  )
}
