"use client"

/**
 * E12 · T13 — **las cuatro escrituras de operador de una organización** (§5.5).
 *
 * Cuatro diálogos, y ni uno más. ADR-0020 D1 cierra la lista: añadir una quinta
 * operación exige enmendar el ADR, y por eso esta pantalla no tiene un hueco
 * genérico donde encajar «lo siguiente».
 */

import {
  planPurgeRetentionAction,
  planReassignPlanAction,
  planResetOrgAction,
  planUnblockAction,
  purgeRetentionAction,
  reassignPlanAction,
  resetOrgAction,
  unblockAction,
} from "@/app/(app)/admin/actions"
import { OperationDialog, type PreparedView } from "@/components/admin/operation-dialog"
import { useState } from "react"

export type UnblockOption = {
  kind: string
  targetKind: string
  label: string
  /** Objetivos concretos que hoy están atascados, si los hay. */
  targets: { id: string | null; ref: string | null; label: string }[]
}

type Props = {
  organizationId: string
  organizationName: string
  planCodes: string[]
  currentPlanCode: string | null
  unblockOptions: UnblockOption[]
}

const asPrepared = (r: { success: boolean; error?: string | null; data?: unknown }) =>
  r as { success: boolean; error?: string | null; data?: PreparedView | null }

export function OrganizationOperations({
  organizationId,
  organizationName,
  planCodes,
  currentPlanCode,
  unblockOptions,
}: Props) {
  const [planCode, setPlanCode] = useState(planCodes.find((c) => c !== currentPlanCode) ?? planCodes[0] ?? "")
  const [guardia, setGuardia] = useState(0)
  const [objetivo, setObjetivo] = useState(0)

  const opcion = unblockOptions[guardia]
  const target = opcion?.targets[objetivo]

  return (
    <div className="space-y-4" data-testid="admin-operations">
      <OperationDialog
        testId="op-reset-org"
        title="Vaciar la organización (reset-org)"
        description={
          "Vacía los libros de una organización de pruebas o de demo. Se NIEGA si existe un solo asiento " +
          "contabilizado: eso no es una operación de operador, es una decisión contable, y un asiento se anula " +
          "con contra-asiento (ADR-0003). No hay «--force»: lo impide la propia base de datos."
        }
        confirmLabel="Vaciar la organización"
        organizationId={organizationId}
        organizationName={organizationName}
        onPlan={async () => asPrepared(await planResetOrgAction(organizationId))}
        onRun={resetOrgAction}
      />

      <section className="rounded-lg border p-4 space-y-3" data-testid="op-unblock-picker">
        <div className="space-y-1">
          <h3 className="font-semibold">Levantar una guardia (unblock)</h3>
          <p className="text-sm text-muted-foreground max-w-3xl">
            Levanta <strong>la puerta</strong>, nunca el invariante: el que cerró la puerta sigue en FAIL y sigue
            moviendo el sello. La excepción <strong>caduca sola en 24 h</strong> y no se puede renovar; mientras viva,
            el periodo no se puede firmar como «validado automáticamente».
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Guardia</span>
            <select
              className="rounded-md border px-3 py-2 text-sm"
              value={guardia}
              onChange={(e) => {
                setGuardia(Number(e.target.value))
                setObjetivo(0)
              }}
              data-testid="op-unblock-kind"
            >
              {unblockOptions.map((o, i) => (
                <option key={o.kind} value={i}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Objetivo</span>
            <select
              className="rounded-md border px-3 py-2 text-sm"
              value={objetivo}
              onChange={(e) => setObjetivo(Number(e.target.value))}
              data-testid="op-unblock-target"
            >
              {(opcion?.targets ?? []).map((t, i) => (
                <option key={`${t.id ?? t.ref ?? i}`} value={i}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {opcion && target ? (
          <OperationDialog
            testId="op-unblock"
            title={`Levantar: ${opcion.label}`}
            description="La excepción se registra con motivo, actor y caducidad, y mueve el sello mientras esté viva."
            confirmLabel="Levantar la guardia 24 h"
            organizationId={organizationId}
            organizationName={organizationName}
            extra={{
              kind: opcion.kind,
              targetKind: opcion.targetKind,
              targetId: target.id ?? "",
              targetRef: target.ref ?? "",
            }}
            onPlan={async () =>
              asPrepared(
                await planUnblockAction(organizationId, {
                  kind: opcion.kind,
                  targetKind: opcion.targetKind,
                  targetId: target.id,
                  targetRef: target.ref,
                })
              )
            }
            onRun={unblockAction}
          />
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="op-unblock-vacio">
            No hay ninguna guardia de esta clase atascada ahora mismo. No hay nada que levantar.
          </p>
        )}
      </section>

      <section className="rounded-lg border p-4 space-y-3" data-testid="op-plan-picker">
        <div className="space-y-1">
          <h3 className="font-semibold">Reasignar el plan</h3>
          <p className="text-sm text-muted-foreground max-w-3xl">
            Plan actual: <strong>{currentPlanCode ?? "sin suscripción"}</strong>. El cambio mueve los límites al
            instante y queda en los dos registros con el plan de antes y el de después.
          </p>
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Plan destino</span>
          <select
            className="rounded-md border px-3 py-2 text-sm"
            value={planCode}
            onChange={(e) => setPlanCode(e.target.value)}
            data-testid="op-plan-code"
          >
            {planCodes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <OperationDialog
          testId="op-reassign-plan"
          title={`Asignar el plan ${planCode}`}
          description="Gana motivo obligatorio y doble confirmación respecto del camino de E11 (ADR-0019 D9)."
          confirmLabel="Asignar el plan"
          organizationId={organizationId}
          organizationName={organizationName}
          extra={{ planCode }}
          onPlan={async () => asPrepared(await planReassignPlanAction(organizationId, planCode))}
          onRun={reassignPlanAction}
        />
      </section>

      <OperationDialog
        testId="op-purge-retention"
        title="Purgar lo que la retención ya ordena purgar"
        description={
          "Sólo lo que «expiresAt» declara vencido, nunca una copia con una restauración viva (I-E11-11), y " +
          "nunca una factura de plataforma (O-11). La fila del trabajo no se borra: pasa a EXPIRED."
        }
        confirmLabel="Purgar lo vencido"
        organizationId={organizationId}
        organizationName={organizationName}
        onPlan={async () => asPrepared(await planPurgeRetentionAction(organizationId))}
        onRun={purgeRetentionAction}
      />
    </div>
  )
}
