"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useRouter } from "next/navigation"
import { useState } from "react"

/**
 * E9 · T18 — Selector de periodo de `/reports/vat`.
 *
 * El periodo se escribe con el formato del **régimen vigente en esa fecha**:
 * `AAAA-Qn` en trimestral y `AAAA-MM` en mensual. El régimen es un dato fechado
 * (D8.1) y por eso el selector no lo impone: lo enseña la cabecera y el
 * servidor lo resuelve con la vigencia del día.
 */
export function VatPeriodPicker({ period, year, tab }: { period: string; year: number; tab: string }) {
  const router = useRouter()
  const [value, setValue] = useState(period)
  const [yearValue, setYearValue] = useState(String(year))

  const go = (): void => {
    router.push(`/reports/vat?tab=${tab}&period=${encodeURIComponent(value.trim())}&year=${yearValue.trim()}`)
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <Label htmlFor="vat-period" className="text-xs">
          Periodo de liquidación
        </Label>
        <Input
          id="vat-period"
          data-testid="vat-period"
          className="h-8 w-32"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="2026-Q1"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="vat-year" className="text-xs">
          Año (prorrata)
        </Label>
        <Input
          id="vat-year"
          data-testid="vat-year"
          className="h-8 w-24"
          value={yearValue}
          onChange={(event) => setYearValue(event.target.value)}
        />
      </div>
      <Button type="button" size="sm" variant="outline" onClick={go} data-testid="vat-period-go">
        Ver
      </Button>
    </div>
  )
}
