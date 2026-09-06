"use client"

import { updateCategoryFiscalAction } from "@/app/(app)/settings/organization/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E8 · T17 — Deducibilidad y cuenta por defecto de cada categoría (O-10, O-17).
 *
 * Dos columnas y una idea: **la cuenta la decide el catálogo y la deducibilidad
 * la decide una persona**. El modelo de lenguaje no rellena ninguna de las dos
 * —el esquema que se le manda ni siquiera las contiene—, porque elegir entre
 * 607 y 623 es elegir MC1 o MC2, y decidir si una comida con un cliente deduce
 * es criterio profesional, no lectura de un PDF.
 */

export type CategoryFiscalView = {
  code: string
  name: string
  defaultAccountCode: string | null
  defaultDeductibility: string
}

const DEDUCTIBILITY_LABEL: Readonly<Record<string, string>> = {
  FULL: "Deducible",
  NONE: "No deducible",
  REQUIERE_DECISION: "Requiere decisión",
}

export function CategoryDeductibilityTable({
  categories,
  canEdit,
}: {
  categories: readonly CategoryFiscalView[]
  canEdit: boolean
}) {
  const router = useRouter()
  const [draft, setDraft] = useState<Record<string, CategoryFiscalView>>({})
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const valueOf = (category: CategoryFiscalView): CategoryFiscalView => draft[category.code] ?? category

  const patch = (category: CategoryFiscalView, change: Partial<CategoryFiscalView>) =>
    setDraft((current) => ({ ...current, [category.code]: { ...valueOf(category), ...change } }))

  const save = (category: CategoryFiscalView) =>
    startTransition(async () => {
      setError(null)
      setSaved(null)
      const value = valueOf(category)
      const state = await updateCategoryFiscalAction({
        code: category.code,
        defaultAccountCode: value.defaultAccountCode ?? "",
        defaultDeductibility: value.defaultDeductibility,
      })
      if (!state.success) {
        setError(state.error ?? "No se ha podido guardar la categoría")
        return
      }
      setSaved(category.code)
      router.refresh()
    })

  return (
    <section className="space-y-2">
      <h3 className="text-lg font-semibold">Cuenta y deducibilidad por defecto de cada categoría</h3>
      <p className="max-w-3xl text-sm text-muted-foreground">
        <strong>Requiere decisión</strong> es el valor correcto para hostelería, restauración, atenciones a clientes,
        espectáculos y combustible de turismos (art. 96 LIVA y art. 95.Tres.2ª): con él, el documento no entra en la
        confirmación por lote y hay que decidir la deducibilidad en cada factura, con su motivo. El producto no detecta
        automáticamente qué gasto es deducible por naturaleza, y lo dice en vez de fingir que sí.
      </p>

      {categories.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-6 text-sm text-muted-foreground">
          No hay categorías configuradas en esta organización.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm" data-testid="category-deductibility">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Categoría</th>
                <th className="px-3 py-2 text-left font-medium">Cuenta por defecto</th>
                <th className="px-3 py-2 text-left font-medium">Deducibilidad</th>
                {canEdit && <th className="px-3 py-2 text-right font-medium">Acciones</th>}
              </tr>
            </thead>
            <tbody className="divide-y">
              {categories.map((category) => {
                const value = valueOf(category)
                return (
                  <tr key={category.code} className="h-9" data-category={category.code}>
                    <td className="px-3 py-1">
                      <span className="font-code text-xs">{category.code}</span>{" "}
                      <span className="text-muted-foreground">{category.name}</span>
                    </td>
                    <td className="px-3 py-1">
                      <Input
                        className="h-8 w-32 font-code text-xs"
                        value={value.defaultAccountCode ?? ""}
                        disabled={!canEdit}
                        placeholder="629"
                        onChange={(event) => patch(category, { defaultAccountCode: event.target.value })}
                        aria-label={`Cuenta por defecto de ${category.code}`}
                      />
                    </td>
                    <td className="px-3 py-1">
                      <select
                        className="h-8 rounded-md border bg-transparent px-1 text-xs"
                        value={value.defaultDeductibility}
                        disabled={!canEdit}
                        onChange={(event) => patch(category, { defaultDeductibility: event.target.value })}
                        aria-label={`Deducibilidad de ${category.code}`}
                      >
                        {Object.entries(DEDUCTIBILITY_LABEL).map(([option, label]) => (
                          <option key={option} value={option}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </td>
                    {canEdit && (
                      <td className="px-3 py-1 text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() => save(category)}
                          className={cn(saved === category.code && "border-[#0A0A0A]")}
                        >
                          {saved === category.code ? "Guardado" : "Guardar"}
                        </Button>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {error && (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
