"use client"

import { createPromptVersionAction, setActivePromptAction } from "@/app/(app)/settings/prompts/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E8 · T17 — Versiones del prompt de una organización (§6, G-10).
 *
 * Append-only por dentro y por fuera: aquí sólo se puede **añadir** una versión
 * y **elegir** cuál rige. Volver a git es una opción de primera clase, no un
 * caso raro: el prompt del repositorio es el único que pasa por revisión.
 */

export type PromptVersionView = {
  id: string
  code: string
  version: number
  content: string
  sha256: string
  notes: string | null
  createdAt: string
  isActive: boolean
}

export function PromptVersionsPanel({
  code,
  gitVersion,
  gitSha,
  gitContent,
  versions,
  activeVersionId,
  isAdmin,
}: {
  code: string
  gitVersion: number
  gitSha: string
  gitContent: string
  versions: readonly PromptVersionView[]
  activeVersionId: string | null
  isAdmin: boolean
}) {
  const router = useRouter()
  const [content, setContent] = useState("")
  const [notes, setNotes] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const create = () =>
    startTransition(async () => {
      setError(null)
      setMessage(null)
      const state = await createPromptVersionAction({ code, content, notes: notes.trim() || undefined })
      if (!state.success) {
        setError(state.error ?? "No se ha podido crear la versión")
        return
      }
      setContent("")
      setNotes("")
      setMessage(`Versión ${state.data?.version} creada. Todavía no rige: actívela cuando quiera usarla.`)
      router.refresh()
    })

  const activate = (versionId: string | null) =>
    startTransition(async () => {
      setError(null)
      setMessage(null)
      const state = await setActivePromptAction({ code, versionId: versionId ?? "" })
      if (!state.success) {
        setError(state.error ?? "No se ha podido fijar la versión vigente")
        return
      }
      setMessage(versionId ? "Versión vigente actualizada." : "La organización vuelve al prompt de git.")
      router.refresh()
    })

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-lg font-semibold">Prompt de git (sólo lectura)</h3>
          <p className="font-code text-xs text-muted-foreground">
            {code}.v{gitVersion} · sha {gitSha.slice(0, 16)}
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          Es el que rige mientras la organización no fije el suyo.{" "}
          {activeVersionId === null ? (
            <strong>Ahora mismo es el vigente.</strong>
          ) : (
            <>
              Ahora rige una versión de la organización.{" "}
              {isAdmin && (
                <button type="button" className="underline underline-offset-2" onClick={() => activate(null)}>
                  Volver al prompt de git
                </button>
              )}
            </>
          )}
        </p>
        <pre className="max-h-72 overflow-auto rounded-md border bg-muted/30 p-3 font-code text-[11px] whitespace-pre-wrap">
          {gitContent}
        </pre>
      </section>

      <section className="space-y-2">
        <h3 className="text-lg font-semibold">Versiones de la organización</h3>
        {versions.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-6 text-sm text-muted-foreground">
            Esta organización no ha creado ninguna versión: extrae con el prompt de git.
          </p>
        ) : (
          <ul className="divide-y rounded-md border text-sm" data-testid="prompt-versions">
            {versions.map((version) => (
              <li key={version.id} className={cn("space-y-1 px-3 py-2", version.isActive && "bg-muted/50")}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-code text-xs">v{version.version}</span>
                  {version.isActive && (
                    <span className="rounded-md bg-[#0A0A0A] px-1.5 py-0.5 text-[11px] leading-none text-white">
                      vigente
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {new Date(version.createdAt).toLocaleString("es-ES")}
                  </span>
                  <span className="font-code text-[11px] text-muted-foreground">sha {version.sha256.slice(0, 16)}</span>
                  <div className="ml-auto flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setExpanded((current) => (current === version.id ? null : version.id))}
                    >
                      {expanded === version.id ? "Ocultar texto" : "Ver texto"}
                    </Button>
                    {isAdmin && !version.isActive && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => activate(version.id)}
                        data-testid={`activate-prompt-${version.version}`}
                      >
                        Activar
                      </Button>
                    )}
                  </div>
                </div>
                {version.notes && <p className="text-xs text-muted-foreground">{version.notes}</p>}
                {expanded === version.id && (
                  <pre className="max-h-72 overflow-auto rounded-md border bg-muted/30 p-3 font-code text-[11px] whitespace-pre-wrap">
                    {version.content}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {isAdmin && (
        <section className="space-y-2">
          <h3 className="text-lg font-semibold">Nueva versión</h3>
          <p className="text-sm text-muted-foreground">
            Se inserta como la siguiente del histórico y no sustituye a ninguna. Recuerde lo que el prompt no puede
            pedir nunca al modelo: la cuenta contable, el proyecto, el centro de coste, la deducibilidad, la retención,
            la fecha de recepción ni la calificación de inversión del sujeto pasivo. Esas decisiones son del catálogo o
            de una persona.
          </p>
          <Textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={12}
            className="font-code text-xs"
            placeholder="Texto del prompt…"
            data-testid="prompt-content"
          />
          <Input
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Nota de la versión (opcional)"
            data-testid="prompt-notes"
          />
          <Button type="button" onClick={create} disabled={pending || content.trim().length < 40} data-testid="create-prompt-version">
            {pending ? "Guardando…" : "Crear versión"}
          </Button>
        </section>
      )}

      {error && (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert">
          {error}
        </p>
      )}
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </div>
  )
}
