# MICRO ERP SAAS — Reglas del proyecto

ERP SaaS de contabilidad y control de gestión para **empresas de proyectos/servicios** (PYMEs españolas), construido sobre el fork de [TaxHacker](https://github.com/vas3k/TaxHacker). Producto de CFOnomic.

## Stack (heredado de TaxHacker, no cambiar sin ADR)
- Next.js 16 (App Router, Server Actions, Turbopack) · React 19 · TypeScript 6 · Tailwind 4 · shadcn/radix
- Prisma 7 + PostgreSQL (**Supabase** en producción; `docker compose` en local)
- Auth: better-auth · LLM: LangChain (OpenAI / Gemini / Mistral / OpenAI-compatible local) · Tests: vitest
- Importes SIEMPRE en **céntimos enteros** (`Int`), nunca `Float`. Moneda base por organización.

## Documentos canónicos (léelos antes de tocar código)
| Fichero | Qué es |
|---|---|
| `docs/SPEC-FUNCIONAL.md` | Qué construimos: PGC configurable, proyectos/CECOs/líneas de negocio, MC1-MC3, PyG analítica, cashflow, balance, diario, auditoría, roles |
| `docs/ARQUITECTURA.md` | Cómo: multi-tenant, motor contable determinista, capa de fiabilidad, módulos |
| `docs/MODELO-DATOS.md` | Esquema Prisma objetivo y reglas de integridad |
| `docs/spec/SPEC-FIABILIDAD.md` | Principios P1–P7 y componentes C1–C7. **Prevalece sobre cualquier prompt de agente** |
| `docs/AUDITORIA-FIABILIDAD.md` | Fase 1: gaps de TaxHacker (6 ALTA) que el ERP debe cerrar |
| `docs/ROADMAP.md` | Épicas y orden de ejecución |
| `docs/adr/` | Decisiones de arquitectura (una por fichero, inmutables) |
| `seeds/npgc.csv` | Cuadro de cuentas PGC 2007 (906 filas) con mapeo a estados financieros y tipo analítico |

## Principios no negociables (resumen de SPEC-FIABILIDAD)
1. **El LLM extrae y redacta; el código calcula.** Ninguna cifra contable sale de un modelo. OCR → propuesta → validación determinista → asiento.
2. **Partida doble siempre.** Todo movimiento económico es un asiento con Σdebe = Σhaber (tolerancia 0). Un asiento descuadrado no se persiste: la BD lo impide (constraint + trigger), no solo la app.
3. **Los informes son vistas del libro diario.** PyG, balance, cashflow, PyG analítica se derivan por SQL/código del diario; nunca se almacenan cifras "de informe" que puedan divergir.
4. **Cuadre verificable**: invariantes I1–I10 definidos UNA sola vez en `.claude/skills/fiabilidad/SKILL.md` (partida doble, `Activo = Pasivo + PN`, PyG = líneas 6/7 excluyendo regularización/cierre/apertura y = saldo 129 si regularizado, Σ matriz analítica = PyG contable, Σ imputado = saldo CECO, cashflow = Δ57x, unicidad, fechas, plan, tenant). Tienen tests y se exponen en la pestaña Auditoría.
5. **Segregación**: quien implementa ≠ quien revisa ≠ quien audita cifras. El `auditor-fiabilidad` se lanza en contexto limpio.
6. **Trazabilidad**: cada asiento referencia documento origen (`File`), extracción (`ExtractionRun` con modelo+prompt-hash), usuario y timestamp. Nada se borra: se anula con contra-asiento.
7. **Multi-tenant estricto**: toda tabla de negocio lleva `organizationId`; toda query pasa por el helper de tenant; RLS en Supabase como segunda barrera.

## Cómo trabajar aquí (flujo de agentes)
- Entrada por **`/epica <nombre>`** (planifica) o **`/sprint <épica>`** (ejecuta). El `orquestador` reparte trabajo; nunca escribe código de producto él mismo.
- Toda tarea de código sigue: `arquitecto` (diseño + contrato) → `dev-backend` / `dev-frontend` (implementación + tests) → `qa-tester` (tests e2e/invariantes) → `revisor-codigo` (PR review) → `auditor-fiabilidad` (solo si toca cifras, motor contable o informes).
- Cambios **Nivel 2** (motor contable, invariantes, esquema de asientos, reglas de imputación, prompt del auditor, RLS) requieren ADR + aprobación humana explícita antes de merge. Nivel 1 (docs, tests, refactor con diff cero) se implementa y se notifica.
- Antes de dar por terminada cualquier tarea: `npm run lint && npm run test` en verde y `runs/registro.jsonl` actualizado con el run.
- Idioma: código e identificadores en inglés; UI, docs, commits y comentarios de dominio en **español**. Términos contables en español oficial del PGC.

## Convenciones de código
- Server Actions en `app/(app)/<modulo>/actions.ts`; lógica de dominio en `models/` (acceso a datos SIEMPRE vía `tenantDb(orgId)` de `lib/db.ts`); motor contable puro en `lib/ledger/` y `lib/analytics/` (funciones puras, sin `Date.now()` implícito, sin IO, sin LLM). Rutas: se conservan las heredadas de TaxHacker (`unsorted`, `transactions`, `settings`, `apps`, `dashboard`) y se añaden `ledger/`, `reports/`, `analytics/`, `audit/`; las de configuración contable cuelgan de `settings/`.
- Roles: enum `ADMIN | EDITOR | VIEWER` (`Membership.role`); toda server action empieza por `requireOrg(minRole)`.
- Validación de entrada con `zod` en `forms/`. Un schema por entidad.
- Tests unitarios junto al fichero (`*.test.ts`). Invariantes contables en `lib/ledger/invariants.test.ts` con fixtures fijos (vacío, un asiento, negativos, cierre de ejercicio).
- Migraciones Prisma nombradas `NNNN_<que_hace>`; nunca editar una migración aplicada.
- Prohibido: `any`, `Float` para dinero, cálculos en prompts, borrar asientos, `Date.now()` dentro de `lib/ledger/` y `lib/analytics/` (el hook `.claude/hooks/guard.sh` lo bloquea antes de escribir).
- Anulación de asientos: SOLO por contra-asiento (`reversesEntryId`); no existe flag que excluya líneas de los informes.

## Comandos
```
npm run dev        # http://localhost:7331
npm run test       # vitest
npm run lint
npx prisma migrate dev --name <nombre>
npx tsx seeds/import_npgc.ts --org <id> --variant PYMES   # (a crear en E2) carga NPGC en una organización
npx tsx scripts/run-invariants.ts --org <id>            # (a crear en E7) invariantes I1–I10 → validacion.json
```
