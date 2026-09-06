export type Task<T> = () => Promise<T>

export class ConcurrencyLimiter {
  private active = 0
  private max = 1
  private waiters: Array<() => void> = []
  private listeners = new Set<() => void>()

  setMax(max: number): void {
    this.max = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1
    this.fill()
    this.emit()
  }

  /** Lower the cap by 1 (used on rate-limit); never goes below 1. */
  reduceMax(): void {
    if (this.max <= 1) return
    this.max -= 1
    this.emit()
  }

  get getMax(): number {
    return this.max
  }

  get getActive(): number {
    return this.active
  }

  async run<T>(task: Task<T>): Promise<T> {
    await this.acquire()
    try {
      return await task()
    } finally {
      this.active -= 1
      this.fill()
      this.emit()
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getMaxSnapshot = (): number => this.max

  getActiveSnapshot = (): number => this.active

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1
      this.emit()
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  private fill(): void {
    while (this.waiters.length > 0 && this.active < this.max) {
      this.active += 1
      this.waiters.shift()?.()
      this.emit()
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

export const analyzeLimiter = new ConcurrencyLimiter()

export type AnalyzeDocState = "queued" | "analyzing" | "done" | "error"

export type AnalyzeCounts = {
  analyzing: number
  queued: number
  done: number
  error: number
  total: number
}

const EMPTY_COUNTS: AnalyzeCounts = { analyzing: 0, queued: 0, done: 0, error: 0, total: 0 }

/**
 * Per-file analyze progress, reported by each AnalyzeForm and aggregated
 * for the progress badge. Module singleton so all cards share one store.
 */
export class AnalyzeProgress {
  private states = new Map<string, AnalyzeDocState>()
  private listeners = new Set<() => void>()
  private cached: AnalyzeCounts = EMPTY_COUNTS

  setState(fileId: string, state: AnalyzeDocState): void {
    this.states.set(fileId, state)
    this.recompute()
  }

  clear(fileId: string): void {
    if (this.states.delete(fileId)) this.recompute()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getCountsSnapshot = (): AnalyzeCounts => this.cached

  private recompute(): void {
    let analyzing = 0
    let queued = 0
    let done = 0
    let error = 0
    for (const state of this.states.values()) {
      if (state === "analyzing") analyzing++
      else if (state === "queued") queued++
      else if (state === "done") done++
      else error++
    }
    this.cached = { analyzing, queued, done, error, total: this.states.size }
    for (const listener of this.listeners) listener()
  }
}

export const analyzeProgress = new AnalyzeProgress()

// ─────────────────────────────────────────────────────────────────────────────
// E8 · T12 — Cola de SERVIDOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hasta E8 la cola vivía en el navegador: cada tarjeta de `/unsorted` disparaba
 * su propia petición y un `ConcurrencyLimiter` del cliente decidía cuántas a la
 * vez. Eso tiene dos agujeros que la épica cierra:
 *
 *  · **Dos pestañas abiertas eran dos colas.** El límite de concurrencia del
 *    proveedor se rebasaba con sólo duplicar la pestaña, y la organización
 *    empezaba a comer 429 que nadie sabía explicar.
 *  · **La UI esperaba al LLM.** Si el usuario cerraba la pestaña a mitad, la
 *    extracción se perdía sin dejar rastro.
 *
 * Ahora el límite es **del servidor y por organización**, la petición devuelve
 * un `runId` y el estado viaja por `Progress` + SSE (§9). Las clases de arriba
 * se conservan porque el formulario heredado las sigue usando para pintar su
 * badge, y porque el limitador es la misma pieza a los dos lados.
 *
 * El estado es **de proceso**, no de negocio: si el servidor se reinicia, lo que
 * se pierde es la cola, no la evidencia —cada extracción terminada ya es una
 * fila inmutable en `extraction_runs`—.
 */

/** Peticiones de extracción por organización y ventana. Frena la ráfaga, no el uso. */
export const EXTRACTION_RATE_LIMIT = 60
export const EXTRACTION_RATE_WINDOW_MS = 60 * 1000

export const extractionRateLimitKey = (organizationId: string): string => `extract:${organizationId}`

/** Concurrencia por defecto si la organización no configura `llm_max_concurrency`. */
export const DEFAULT_ANALYZE_CONCURRENCY = 1

/**
 * Un limitador por organización: la concurrencia es un límite del PROVEEDOR de
 * esa organización, así que compartirlo entre tenants castigaría a una empresa
 * por el ritmo de otra.
 */
export class ServerAnalyzeQueue {
  private limiters = new Map<string, ConcurrencyLimiter>()

  limiterFor(organizationId: string, maxConcurrency: number): ConcurrencyLimiter {
    let limiter = this.limiters.get(organizationId)
    if (!limiter) {
      limiter = new ConcurrencyLimiter()
      this.limiters.set(organizationId, limiter)
    }
    limiter.setMax(maxConcurrency)
    return limiter
  }

  /** Encola respetando el máximo vigente de la organización. */
  async run<T>(organizationId: string, maxConcurrency: number, task: Task<T>): Promise<T> {
    return await this.limiterFor(organizationId, maxConcurrency).run(task)
  }

  /** Cuántas extracciones hay en vuelo ahora mismo para esta organización. */
  activeFor(organizationId: string): number {
    return this.limiters.get(organizationId)?.getActive ?? 0
  }

  /** Sólo para tests: olvida el estado de proceso. */
  reset(): void {
    this.limiters.clear()
  }
}

export const serverAnalyzeQueue = new ServerAnalyzeQueue()

/** Identificador de `Progress` de un lote de extracción. */
export const analyzeProgressId = (batchId: string): string => `extract:${batchId}`
