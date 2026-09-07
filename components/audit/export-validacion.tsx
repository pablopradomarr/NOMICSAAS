"use client"

import { Button } from "@/components/ui/button"

/**
 * E7 · T13 — Exportar `validacion.json` de un barrido sellado.
 *
 * El fichero es **exactamente** el que escribe `scripts/run-invariants.ts`
 * (`{ run_id, ledgerHash, gitSha, organizationId, refDate, sello, checks }`),
 * porque quien lo consume —un auditor externo, un script de la asesoría— no
 * tiene por qué distinguir si salió de la línea de órdenes o de la pantalla.
 * Se compone **en el servidor** y aquí sólo se descarga: el navegador no
 * reconstruye una foto sellada.
 */
export function ExportValidacionButton({ filename, json }: { filename: string; json: string }) {
  const download = (): void => {
    const blob = new Blob([json], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={download} data-testid="export-validacion">
      Exportar validacion.json
    </Button>
  )
}
