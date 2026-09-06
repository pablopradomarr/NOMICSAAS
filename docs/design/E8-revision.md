# E8 — Revisión de código (contexto limpio)

**Revisor:** `revisor-codigo` · **Fecha:** 2026-09-06 · **Diff:** `git diff 607f53c...HEAD` (7 commits: `34c9f85`, `181af21`, `9eaa41e`, `7a8a1c3`, `da107af`, `130096e`, `1652150`) · **157 ficheros, +36 344 / −969**
**Base documental:** `CLAUDE.md`, `docs/design/E8-documentos-asientos.md`, `docs/adr/0014-estados-transaccion-fx-y-tolerancia-reconcile.md`, `docs/design/E8-validacion-documentos.md`, `docs/ESTADO.md`.

## Comandos ejecutados

| Comando | Resultado |
|---|---|
| `npm run lint` | **OK** — 0 errores, 12 warnings (todos preexistentes, en `hooks/`) |
| `npm run test` | **OK** — 56 ficheros, **1294 pasan**, 11 `skip` (los mismos 11 de `607f53c`: `describe.skipIf(!TEST_DATABASE_URL)`, **ningún `skip` nuevo**) |
| `npm run test:integration` | **FALLA** — 84 ficheros, 1689 pasan, **1 falla**: `tests/integration/authz-actions.test.ts` |
| `npm run test:integration:rls` | **OK** — 10 ficheros, 155 pasan |
| `npm run build` | **OK** |

## Checklist

- [x] **Dinero en `Int` céntimos.** Ni un `parseFloat`/`toFixed` fuera de `lib/money.ts` en el código nuevo; `/100` sólo en formateo de pantalla (`reconcile.ts:1211`). `reverseConvert` y el reparto Hamilton operan en `BigInt`. `forms/transactions.ts` sustituye `parseFloat(val)*100` por `parseCents()` (G-07).
- [x] **Tenant.** Las cuatro tablas nuevas entran en `TENANT_MODELS` y en `BUSINESS_DELEGATES` de ESLint; `ExchangeRate` en `GLOBAL_REFERENCE_MODELS`. El SQL crudo de la bandeja va siempre envuelto en `tenantTransaction`. Suite RLS en verde con las cinco tablas nuevas añadidas a `TABLAS_CON_FORCE`.
- [x] **Motor puro.** `lib/extraction/**`, `lib/ledger/postFromProposal.ts`, `lib/fx/convert.ts`, `lib/ledger/invariants-e8.ts`: sin `Date.now()`, `new Date()`, `prisma`, `fetch`, LLM ni `Math.random`. `refDate` viaja en el contexto.
- [x] **Asientos.** Cuadre por construcción + trigger diferido de E3 intacto; ningún `delete`; anulación por traslado a `voided_entry_id` con histórico append-only por trigger.
- [x] **P1/P4 — ninguna cifra del LLM llega al diario.** `ai/schemas/extraction.v1.json` es `additionalProperties: false` y **no contiene** `accountCode`, `projectId`, `costCenterId`, `deductibility`, `withholding`, `receptionDate`, `paymentKey`, `simplifiedQualified` ni la calificación ISP. `reconcile()` reescribe `normalized.withholding` desde `ctx.counterparty` (`reconcile.ts:1193-1204`), así que la retención leída nunca contabiliza. `confirmProposalAction` recalcula `reconcile` **en servidor** antes de construir el asiento y `postFromProposal` vuelve a cerrar la puerta.
- [x] **Nada lee cifras de una caché.** `files.cached_parse_result` eliminada de la BD (migración §7) y sin una sola lectura en producto; lo histórico migrado a runs `IMPORTED` que `postFromProposal` rechaza. `lib/analyze-queue.ts` sólo cachea contadores de UI.
- [x] **Inmutabilidad en BD.** `extraction_runs` y `prompt_versions`: `REVOKE UPDATE, DELETE` + política `RESTRICTIVE … USING (false)`; `exchange_rates` igual, con `ENABLE`+`FORCE` pese a ser global. `partial` lo escribe un trigger `BEFORE INSERT`, no quien inserta.
- [x] **CHECK D1 y triggers de estado.** Las cuatro ramas explícitas; trigger de transición y traslado de asiento; `invoice_series` sin huecos y con `kind` inmutable; techo duro 0–5 c en `redondeo_tolerancia_cents`; `categories` sin subgrupo 64; pareja de divisa en `journal_lines`.
- [x] **Secretos.** Ninguna clave en logs: `llmProvider.ts:211` registra sólo `{message, status}`; `attempts[]` guarda códigos, no cuerpos. Cifrado AES-GCM de `lib/encryption.ts` sin tocar. La URL de tasas es fija (`FRANKFURTER_BASE_URL`, sin entrada de usuario en el host ni en la ruta).
- [x] **Uploads.** `assertAcceptableUpload` (lista blanca + sniff de contenido + 25 MB) y `sha256OfBuffer` al ingerir, con `sizeBytes`.
- [x] **Transacciones.** Confirmación atómica: run de revisión → asiento → `Transaction POSTED` → `AuditLog` en una sola `runLedgerTransaction`, con `abortWith` para que un error tipado no deje COMMIT a medias. Idempotencia doble: de negocio (`alreadyPosted`) y de formulario (`idempotencyKeyFor` con el nº de anulaciones). El cálculo puro y la llamada FX quedan **fuera** de la transacción.
- [x] **`hashVersion = 3` sin romper v2.** `HASH_VERSION = 2` conservada, `HASH_VERSION_CURRENT = 3`, despacho por versión en TS y en `app.journal_entry_hash` (SQL). Fixtures de E3–E6 byte a byte y `ledgerHash` intacto (tests en verde).
- [x] **Migraciones sin SUPERUSER.** `ALTER TYPE` en migración propia; ni `ALTER ROLE`, ni `OWNER TO`, ni extensiones; backfills y siembras íntegramente bajo `NO FORCE → DML → FORCE` sobre las cinco tablas tocadas; `DROP COLUMN cached_parse_result` **después** del backfill. `app_maintenance` ya existe desde `20260906090000`.
- [x] **Rendimiento.** Bandeja con un `DISTINCT ON (file_id)` más agregados `COUNT(*) FILTER`, todo dentro de la transacción de `tenantPage` (4 consultas fijas, sin N+1); cota de 256 KB por run en la BD; memo de tasas por petición; cola sin bloquear la UI (`runId` + SSE).
- [x] **UX.** Cuatro badges de confianza (`✓ verificado` incluido), bloque «Las cuatro fechas» explicadas, fila de cuadre con `data-descuadre`, pestaña Documento para el drill-down ≤ 3 clics, `loading.tsx`/`error.tsx` en `/unsorted`, `/unsorted/[fileId]` y `/unsorted/batch`.
- [x] **Tests no debilitados.** Las modificaciones a tests existentes son consecuencias legítimas del diseño (57→58 `AccountKey`, `hashVersion` 2→3, traslado de `journalEntryId` a `voidedEntryId` en E3-adversarial, `files.sha256 NOT NULL` en el fixture RLS), todas con su comentario y su aserción **reforzada**, no relajada.
- [x] **Herencia de TaxHacker.** Split, categorías, campos personalizados, import/export CSV, email-sync, cola de análisis, previews, duplicados y `items-detect` conservados. Sólo se retiran `app/api/currency/route.ts` y `components/agents/currency-converter.tsx`, ambos previstos por el diseño.
- [x] **Nivel 2 con ADR.** ADR-0014 APROBADO cubre D1…D14; ADR-0005 rige el resto. **No hay BLOQUEO por Nivel 2 sin ADR.**

## Hallazgos

| # | Fichero:línea | Severidad | Problema | Sugerencia |
|---|---|---|---|---|
| 1 | `docs/ESTADO.md` (sin tocar en el diff) | **BLOQUEA** | E8 aplaza deuda estructural que ningún documento fecha: 523→173 y valor actual del aplazamiento (E9), RECC/REDEME (E9), `DUA_IMPORTACION` con plantilla `null` (E9), 668/768 (E9), G-14 (E12), G-15 (E11), serie ORDINARIA no sembrada, rate limit de proceso, y el **endurecimiento condicional** de `files.sha256`. `runs/registro.jsonl` sólo anota aplazamientos intra-épica (a T13/T15/T17). CLAUDE.md §Estándar de calidad: «el revisor bloquea si una épica añade deuda sin fecha». | Escribir la tabla de deuda con épica de cierre en `ESTADO.md` (es el entregable de **T22**, aún no ejecutada). El bloqueo se levanta al cerrarla; no impide seguir con T20/T21. |
| 2 | `forms/extraction.ts:112` + `lib/extraction/reconcile.ts:1459-1468,1924` + `app/(app)/unsorted/actions.ts:266` | **DEBE** | `simplifiedQualified` viaja en el `proposal` que acepta `confirmProposalAction`, y `reconcile` lo honra tal cual (`deductibility: "FULL"`, origen `usuario`, confianza `verificado`). Un EDITOR —o un POST directo— deduce el IVA de un ticket **sin pasar por `markSimplifiedQualifiedAction`** y sin `AuditLog` con `MARK_SIMPLIFIED_QUALIFIED`. Rompe O-1/R3 y el criterio 5 («marcado como cualificado por un EDITOR ⇒ …, con `AuditLog`»). | Que `confirmProposalSchema` rechace `simplifiedQualified` (como rechaza las cifras vetadas) y que la marca sólo pueda venir del run de revisión creado por `markSimplifiedQualifiedAction`; o, si se acepta en línea, exigir `reason ≥ 10` y emitir el `AuditLog` específico dentro de la misma transacción. |
| 3 | `app/(app)/unsorted/actions.ts:820-824` vs `components/unsorted/proposal-form.tsx:619,637` | **DEBE** | «Con algún campo `no verificado`, exige motivo» (§6 del diseño) se aplica **sólo en el cliente**: el servidor exige `forceReason` únicamente para RC-12. Un control de auditoría que vive en el navegador no es un control. | Calcular en `confirmProposalActionImpl` los campos `no_verificado` de `judged.result.fieldOrigins` y devolver error si no hay `forceReason` de ≥ 10 caracteres, con su `AuditLog`. El diálogo actual ya envía el motivo, así que el cambio es sólo defensivo. |
| 4 | `lib/ledger/postFromProposal.ts:367,471-481` | **DEBE** | `originalAmountCents` se obtiene **deshaciendo la conversión** del importe en euros en vez de tomarse del importe original de `reconciled.normalized`. El round-trip es lossy salvo para tasas próximas a 1: con `rateMicro = 920000` falla en 1 600 de 20 000 importes; con 500000, en 10 000. La línea de deuda en divisa —que es exactamente lo que la NRV 11ª.2.1 revalorizará en E9— queda con céntimos que no son los del documento, y además entra en el `entryHash` v3. El test `postFromProposal.test.ts:337` pasa porque usa 1,08. | Propagar el importe original de la propuesta hasta la línea (los bloques de pasivo y el total ya se conocen antes de convertir) y usar `reverseConvert` sólo como aserción de coherencia, no como fuente. Añadir un caso con tasa < 1 (p. ej. USD→EUR 0,92) al golden test. |
| 5 | `tests/integration/authz-actions.test.ts:69` | **DEBE** | `npm run test:integration` está **en rojo**: el test agota los 5 000 ms por defecto. Medido: el `await import("@/app/(app)/settings/actions")` cuesta **6 853 ms** en este entorno (el grafo completo de la app), no es flaky —falla en las tres ejecuciones y también en aislamiento—. La épica no puede cerrarse con la suite roja. | Mover el `import` a `beforeAll` (los otros tres tests del fichero pasan precisamente porque el módulo ya está cargado) o dar `timeout` explícito al `it`. No tocar el aserto. |
| 6 | `prisma/migrations/20260913100000_e8_documentos/migration.sql:343` | PUEDE | El trigger admite `PROPOSED → DRAFT`, transición que §2.3 del diseño no enumera («permite `DRAFT→PROPOSED→POSTED→VOID`, el atajo `DRAFT→POSTED` y `VOID→PROPOSED`»). Es inocua —`PROPOSED` no tiene asiento— pero es una rama de más respecto del contrato aprobado. | Documentarla en el diseño o retirarla. |
| 7 | `lib/fx/rates.ts:145` | PUEDE | `from`/`to` se interpolan en la query de Frankfurter tras `trim().toUpperCase()`, sin validar ISO-4217. El host y la ruta son fijos (no hay SSRF), pero un código con `&` inyectaría parámetros en la petición saliente. | `assertCurrencyCode` con `/^[A-Z]{3}$/` junto a `assertLocalDate`, o `URLSearchParams`. |
| 8 | `lib/fx/rates.ts:236` | PUEDE | `BigInt(roundHalfEven(value * 1_000_000))` multiplica en `Number` el valor JSON de la fuente antes de pasar a entero. No es dinero y el resultado es determinista, pero es la única aritmética en coma flotante del camino de la tasa. | Parsear el literal decimal del JSON a micros con aritmética entera, o dejar constancia del porqué junto a la línea. |
| 9 | `7a8a1c3` (commit) | PUEDE | El commit mezcla el lote T6/T10/T11/T12 con T18/T19 (facturas emitidas y deuda del camino de entrada), como advierte el encargo. **No hay que partirlo**: el árbol resultante es correcto y coherente, `runs/registro.jsonl` los separa en dos runs (`e8_olaB_extraccion_fx` y `e8_olaB_t18_t19`) con su alcance y su deuda, y el `git log` conserva la trazabilidad por registro. | Dejarlo como está y anotar en el registro de la épica que la trazabilidad de T18/T19 es por `run_id`, no por commit. |
| 10 | `app/(app)/unsorted/page.tsx:69` | PUEDE | `limit: 200` fijo y sin `OFFSET`: el diseño §9 pide `LIMIT/OFFSET`. Con más de 200 ficheros sin revisar la bandeja trunca en silencio. | Paginar por `searchParams`, o al menos avisar en pantalla de que hay más. |
| 11 | — (falta de test) | PUEDE | El test de rendimiento de la bandeja (criterio 31: < 150 ms con 2 000 ficheros y 6 000 runs) todavía no existe. `e8-extraccion-fx.test.ts:241` comprueba el «sin N+1» funcionalmente, pero no el tiempo. | Es alcance de **T20**; queda anotado para que no se pierda al cerrar la épica. |

## Veredicto

**BLOQUEADO** por el hallazgo 1 (deuda de E8 sin épica ni fecha en `docs/ESTADO.md`, CLAUDE.md §Estándar de calidad). No hay bloqueo de Nivel 2: ADR-0014 está APROBADO y el diff no se aparta de sus decisiones D1…D14.

Levantado ese bloqueo —es el entregable de **T22**, aún no ejecutada— quedan **4 DEBE** (2, 3, 4, 5) y **6 PUEDE**. Los tres DEBE de producto son acotados y no afectan al núcleo: el motor de reconciliación, el mapeo a plantillas, la inmutabilidad en base de datos, la convivencia de `hashVersion` y el aislamiento por tenant están bien resueltos y bien probados.

---

# Ronda 2 — verificación del cierre (`git diff 1652150...008fa0d`)

**Fecha:** 2026-09-06 · **Commit:** `008fa0d` · 36 ficheros, +3 430 / −127 · **1 migración nueva** (`20260915090000_e8_ronda1_transiciones`).

| Comando | Ronda 1 | Ronda 2 |
|---|---|---|
| `npm run lint` | OK (0 err · 12 warn) | **OK** — 0 errores, los mismos 12 warnings preexistentes |
| `npm run test` | 1294 pasan · 11 skip | **OK** — 59 ficheros, **1321 pasan**, **11 skip** (los mismos; +27 tests, ninguno nuevo saltado) |
| `npm run test:integration` | **1 FALLA** / 1689 | **OK** — 90 ficheros, **1740 pasan, 0 fallan** |
| `npm run test:integration:rls` | OK (155) | **OK** — 155 |
| `npm run build` | OK | **OK** — compila y typechequea |

## Cierre por hallazgo

| # | Sev. ronda 1 | Estado | Evidencia verificada |
|---|---|---|---|
| 1 | BLOQUEA | **CERRADO** | `docs/ESTADO.md` §«E8 — deuda y decisiones»: **14 deudas** con estado, **épica de cierre** (E7/E9/E11/E12) y fundamento, más la tabla de lo cerrado en la ronda. Cubre 523→173, RECC/REDEME, DUA, 668/768, G-14, G-15, serie ORDINARIA, `files.sha256`, split en UI, rate limit, `exchange_rates` global, `resolveRectifiedEntry`, y la trazabilidad por `run_id` de #9 |
| 2 | DEBE | **CERRADO** | `forms/extraction.ts:137` `submittedProposalSchema = extractionProposalSchema.omit({simplifiedQualified:true})` (hereda `.strict()`), usado en `confirmProposalSchema` y `previewProposalSchema`; la marca se **recupera del run sellado** (`actions.ts:656`), que sólo escribe `markSimplifiedQualifiedAction` con su `AuditLog`. Tests: `forms/extraction.test.ts:39-60` (4 casos) y `e8-actions.test.ts:560` de extremo a extremo |
| 3 | DEBE | **CERRADO** | `actions.ts:903-915`: `unverifiedFieldsOf` une procedencias **recalculadas ∪ selladas** y exige `forceReason ≥ MOTIVO_MIN` **en el servidor**, con `camposNoVerificados` en el `AuditLog` (`:1025`). Ya no es un control de navegador |
| 4 | DEBE | **CERRADO** | `postFromProposal.ts:341-356,632+`: `taxOverridesOriginal` recorre el **mismo** camino (`resolvePayableBlocks`→`splitPayableBlocks`, mismo Hamilton) sobre las cifras del documento; `reverseConvert` queda de red de seguridad. Tests con `rateMicro = 920 000`: el round-trip pierde > 1 000 de 20 000 importes, la línea de pasivo lleva el céntimo del papel, y en documento **mixto** la suma de originales = total del documento |
| 5 | DEBE | **CERRADO** | LangChain y `sharp` pasan a `await import()` (`llmProvider.ts:42,54,58,66`; `lib/previews/*`). Medido por mí: **6 853 → 4 601 ms** con la suite de integración compitiendo por la CPU, y la suite completa pasa. Sin tocar timeout ni aserto |
| 6 | PUEDE | **CERRADO** | `20260915090000_e8_ronda1_transiciones`: `CREATE OR REPLACE FUNCTION` sin `ALTER ROLE`/`OWNER TO`/extensiones, no toca datos ni RLS, no edita una migración aplicada. `PROPOSED → DRAFT` retirada; test en `e8-esquema.test.ts` |
| 7 · 8 | PUEDE | **CERRADO** | `assertCurrencyCode` (`rates.ts:91`) en la frontera; `rateMicroFromValue` (`:117`) pasa el literal decimal a micros con `BigInt`, con redondeo por el séptimo decimal y respaldo documentado para notación exponencial |
| 10 · 11 | PUEDE | **CERRADO** | `LIMIT/OFFSET` por `?page=` con rango y total a la vista (`unsorted/page.tsx:66,190`); `e8-bandeja-perf.test.ts`: 2 000 ficheros / 6 000 runs, **mediana < 150 ms** y test de que la paginación no trunca |
| 9 | PUEDE | **ANOTADO** | Se acepta no partir `7a8a1c3`; queda escrito en `ESTADO.md` |

## Lo nuevo, con lupa

- **`vatBookRowFromEntry` / I-E8-7a no son tautológicos.** `models/ledger.ts:1734-1745` construye **dos derivaciones independientes**: la fila del libro registro sale de las líneas de 472/477 del **asiento** (`vatBookRowFromEntry`) y el contraste sale de la **propuesta sellada** (`vatBookRowFromProposal`, convertida con la tasa del run y con `rectificationDelta`). `checkIE87a` las compara en cinco campos con tolerancia 0, más `Σdebe = Σhaber` y la coherencia cuota anotada ↔ contabilizada. Es exactamente el puente que los FAIL H-1/H-2 pedían.
- **Inyección de `readStoredFile`.** Decisión correcta y bien argumentada: `lib/files-integrity.ts` resuelve el raíz **dentro** de la función (no al cargar el módulo) para no arrastrar el rastreo de Next, y el lector se inyecta desde las cuatro entradas reales. Hay contención de ruta (`storedFilePath` rechaza salirse del directorio de la organización), lectura en **streaming**, y `sha256OfStoredFile` **nunca lanza**. Fichero ausente o ilegible ⇒ `diskError` ⇒ **I-E8-2 FAIL con la ruta** (`invariants-e8.ts:583-593`), no un WARN; sin lector, WARN honesto. La duplicación de la resolución de ruta está atada con un test que compara las dos.
- **Migración nueva.** Aditiva, idempotente, sin SUPERUSER. Correcta.
- **Tests.** El diff de tests es **puramente aditivo**: ni una aserción borrada, ni un `it` retirado, ni un `skip` nuevo (grep sobre las eliminaciones: cero). Seis ficheros nuevos, incluidos los quince casos sobre el **NPGC PYMES real** y el caso CHF que ejerce el Hamilton del residuo.

## Hallazgos residuales

| # | Fichero:línea | Severidad | Problema | Sugerencia |
|---|---|---|---|---|
| R2-1 | `lib/ledger/postFromProposal.ts:404-420` | PUEDE | El emparejamiento bloque ↔ línea es una cola FIFO **por `accountCode`** (`pending.shift()`). Con dos bloques de pasivo sobre la misma cuenta y distinto importe, un cambio de orden en la plantilla los intercambiaría en silencio; el test mixto sólo comprueba la **suma**. | Emparejar por importe convertido además de por cuenta, o aserción `reverseConvert(amount) ≈ fromDocument ± 2 c` que delate el cruce. |
| R2-2 | `lib/ledger/invariants-e8.ts:735-738` | PUEDE | Cuando `contrast` es `null` el documento se **salta** y el invariante degrada a WARN. Hoy es inalcanzable por malicia (`extraction_runs` es append-only en BD), pero un run sin propuesta reconstruible sale del puente sin dejar rastro individual. | Nombrar en la evidencia los `entryId` sin contraste, no sólo contarlos. |
| R2-3 | `tests/integration/authz-actions.test.ts:69` | PUEDE | El margen sigue siendo estrecho: 4 601 ms medidos bajo carga frente al techo de 5 000 ms. El grafo volverá a crecer. | Mover el `import` a `beforeAll` (coste una vez por fichero) o darle `timeout` explícito, como se sugirió en la ronda 1. |

## Veredicto ronda 2

**APROBADO.** El BLOQUEA y los cuatro DEBE están cerrados con evidencia verificada y con test que los ejerce; los seis PUEDE, también. Las cinco suites están en verde por primera vez en la épica. Quedan **tres PUEDE** nuevos (R2-1…R2-3), ninguno de ellos bloqueante: son endurecimiento, no defectos abiertos. Sin ronda 3.
