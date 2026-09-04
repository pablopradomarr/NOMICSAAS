# AUDITORÍA DE FIABILIDAD — TaxHacker (FASE 1, SPEC-FIABILIDAD v1.0)

| Campo | Valor |
|---|---|
| Repo auditado | vas3k/TaxHacker, commit `6cb7254b854b1f69c9e13775481e6aac79972424` (2026-08-11) |
| Stack | Next.js 16 (App Router, server actions) + Prisma/Postgres + LangChain (OpenAI / Google / Mistral / OpenAI-compatible) |
| Fecha auditoría | 2026-09-04 |
| Alcance | Flujo documento → LLM → transacción → stats/dashboard; import/export; email-sync; invoices; backups |
| Método | Lectura de código (Read/Grep). Todas las referencias `fichero:línea` son del commit indicado |

Leyenda principios: **P1** LLM decide/redacta, código calcula · **P2** fuente única por dominio · **P3** snapshot inmutable (timestamp+hash) · **P4** memoria nunca es fuente de cifras · **P5** calcula ≠ redacta ≠ audita · **P6** nivel de confianza en todo output · **P7** reproducible (git-sha, modelo, run_id, snapshot).

---

## 1. Flujo real de una cifra en TaxHacker (resumen de lectura)

1. Fichero subido → `File` (`lib/uploads.ts:208-229`, metadata = `{size}`; **sin hash**).
2. Cliente pulsa "Analyze with AI" → `POST /api/unsorted/analyze` (`app/api/unsorted/analyze/route.ts:16-112`) → construye prompt desde `Setting.prompt_analyse_new_file` + `Field.llm_prompt` (`ai/prompt.ts`) y JSON-schema desde `Field` (`ai/schema.ts`) → `ai/analyze.ts:25` → `ai/providers/llmProvider.ts:250-277` (cadena de proveedores, primero que responda).
3. El LLM devuelve **`total`, `currencyCode`, `vat`, `vat_rate`, `issuedAt`, `items[]` (cada item con su propio `total`)** → se guarda **tal cual** en `File.cachedParseResult` (`ai/analyze.ts:41`) y se devuelve al cliente.
4. Cliente fusiona salida LLM en el estado del formulario (`components/unsorted/analyze-form.tsx:238-243`); si hay moneda ≠ default, `CurrencyConverterTool` pide tasa a `/api/currency` y calcula `convertedTotal` **en el navegador** (`components/agents/currency-converter.tsx:49`).
5. Submit → `saveFileAsTransactionAction` (`app/(app)/unsorted/actions.ts:27-93`) → Zod (`forms/transactions.ts`) convierte `total` a céntimos (`:18`) pero `items` sólo hace `JSON.parse` (`:58-68`) → `createTransaction` (`models/transactions.ts:157-170`) inserta `items` como JSON sin validar.
6. Dashboard: `models/stats.ts` lee `Transaction` y suma en TypeScript (`lib/stats.ts`); no hay SQL agregado ni comprobación cruzada.

---

## 2.1 Inventario de componentes

| Componente (fichero) | Tipo | Entradas | Salidas | ¿Genera cifras? | ¿Escribe en memoria/BD? |
|---|---|---|---|---|---|
| `ai/analyze.ts` | Orquestador LLM (server) | prompt, schema, attachments (base64), fileId, userId | `{output: Record<string,string>, tokensUsed}` | **Sí (indirecto: pasa cifras del LLM)** | **Sí**: `File.cachedParseResult` (`:41`) |
| `ai/prompt.ts` | Constructor de prompt | plantilla (`Setting`), `Field[]`, `Category[]`, `Project[]` | string prompt | No | No |
| `ai/schema.ts` | Constructor JSON-schema | `Field[]` (type + llm_prompt) | JSON-schema con `items[]` recursivo (`:17-27`) | No (define que el LLM devuelva `total`, `vat`, items.total) | No |
| `ai/attachments.ts` | Tool (preprocesado) | `User`, `File` en disco, setting `llm_attachment_format` | ≤4 páginas en base64 (`:8,28`) | No | No (genera previews en disco vía `lib/previews`) |
| `ai/providers/llmProvider.ts` | Agente/Adapter LLM (LangChain) | `LLMSettings` (lista proveedores), `LLMRequest` | `LLMResponse {output, provider, error}`; `tokensUsed` **nunca se rellena** (`:124-127`) | **Sí**: todos los campos numéricos (`total`, `vat`, `vat_rate`, `items[].total`) salen del modelo; temperature=0 (`:56`) | No |
| `lib/analyze-queue.ts` | Limitador de concurrencia + progreso (cliente) | `maxConcurrency`, estados por fileId | contadores in-memory | No | No (memoria de proceso navegador) |
| `lib/stats.ts` | Cálculo determinista | `Transaction[]`, `Field[]` | totales por moneda, neto, campos incompletos | **Sí (código)** | No |
| `lib/llm-providers.ts` | Config estática | — | `PROVIDERS[]` (defaults gpt-4o-mini, gemini-2.5-flash, mistral-medium-latest) | No | No |
| `lib/config.ts` | Config entorno | env vars | `config.ai.openaiModelName` (default `gpt-4o-mini`, `:9`), `selfHosted` | No | No |
| `models/transactions.ts` | Modelo/CRUD | `TransactionData` (incl. `items` libre, `[key:string]:unknown`) | `Transaction` | No (persiste lo que recibe) | **Sí**: `Transaction` (`:157-183`); `items` JSON sin validar (`:164,180`) |
| `models/stats.ts` | Cálculo dashboard | `userId`, filtros, `defaultCurrency` | `DashboardStats`, `ProjectStats`, series temporales | **Sí (código TS, no SQL)** | No |
| `models/settings.ts` | Modelo Setting + resolución LLM | `Setting` rows, `config` | `SettingsMap`, `LLMSettings` (orden proveedores, modelos) | No | **Sí**: `Setting` upsert (`:141-150`), sin historial |
| `models/defaults.ts` / `models/defaults-data.ts` | Seed | constantes | `DEFAULT_PROMPT_ANALYSE_NEW_FILE` (`defaults-data.ts:1-18`), fields (`:290-451`), settings | No | **Sí**: upsert de Project/Category/Currency/Field/Setting (`defaults.ts:170-223`) |
| `models/export_and_import.ts` | Mapeo CSV ↔ Transaction | valores string CSV / valores BD | valores convertidos (`total*100` sin redondeo `:40,58`) | **Sí (conversión unidades)** | **Sí**: crea Category/Project (`:137-167`, **sin filtro userId** en `findFirst`) |
| `models/backups.ts` | Backup/restore JSON | filas Prisma / JSON | JSON por modelo | No | **Sí**: `model.create` en restore (`:276`) |
| `models/files.ts` | CRUD File | data libre (`any`) | `File` | No | **Sí**: `File` (`createFile`, `updateFile`, `deleteFile`) |
| `models/progress.ts` | Progreso de tareas largas | id, type, current/total | `Progress` | No | **Sí**: tabla `Progress` |
| `models/apps.ts` | KV por app | `user`, `app`, `data` JSON | JSON | No | **Sí**: `AppData` upsert (`:138-144`) |
| `forms/transactions.ts` | Validación Zod | `FormData` | `total`/`convertedTotal` → céntimos (`:18,32`); `items` → `JSON.parse` sin schema (`:58-68`); `.catchall(z.string())` | **Sí (redondeo a céntimos)** | No |
| `app/(app)/unsorted/actions.ts` | Server actions | `FormData` (fileId, campos, `items` JSON), `forceSave` | `Transaction`; split → N `File` nuevos | No | **Sí**: `Transaction`, `File.path/isReviewed` (`:78-81`), `File.cachedParseResult` con cifras de items (`:155-167`), `User.storageUsed` |
| `app/(app)/transactions/actions.ts` | Server actions CRUD | `FormData` | `Transaction` | No | **Sí**: `Transaction`, `File`, `Field.isVisibleInList`, `User.storageUsed` |
| `app/(app)/dashboard/page.tsx` + `components/dashboard/stats-widget.tsx` | Vista (RSC) | `searchParams` filtros | render de `getDashboardStats`, `getDetailedTimeSeriesStats`, `getProjectStats` | No (delegado a `models/stats.ts`) | No |
| `app/(app)/apps/email/actions.ts` | Server actions | config IMAP (password cifrado) | estado servidor | No | **Sí**: `AppData[app=email]` |
| `app/(app)/apps/email/scripts/fetch-emails.ts` | Script cron | — | log consola | No | Indirecto (vía `lib/email-sync/ingest.ts`) |
| `lib/email-sync/ingest.ts` | Ingesta IMAP | `EmailServer`, `User`, mensajes IMAP | `SyncResult` | No | **Sí**: `File` (vía `ingestUnsortedFile`, metadata `source:"email"`, `:60-72`), `AppData` con `FOR UPDATE` (`:94-113`), `User.storageUsed` |
| `lib/email-sync/filters.ts` / `imap-client.ts` / `types.ts` | Tools | criterios UID/SINCE | mensajes | No | No |
| `app/(app)/apps/invoices/actions.ts` | Server action | `InvoiceFormData` (items con `subtotal` calculado en cliente) | PDF + `Transaction type=income` | **Sí (código)**: suma subtotal+taxes+fees (`:72-75`), `total*100` sin redondeo (`:81`) | **Sí**: `Transaction`, `File`, `AppData[app=invoices]` |
| `app/(app)/apps/invoices/components/invoice-generator.tsx` | Reducer cliente | qty, unitPrice, tax % | `subtotal = qty×unitPrice` (`:39`), tax amount (`:52`) | **Sí (código cliente)** | No |
| `app/(app)/import/csv/actions.tsx` | Server actions | CSV → filas; mapeo columna→campo (cliente) | `Transaction[]` | No (delegado a `export_and_import.ts`) | **Sí**: `Transaction`, Category/Project implícitos |
| `app/api/unsorted/analyze/route.ts` | API (orquestador HTTP) | `{fileId}` | `ActionState<AnalysisResult>` | No | **Sí**: `User.aiBalance` decrement (`:106-107`, nunca se ejecuta, ver G-12) |
| `app/api/currency/route.ts` | API tasa de cambio | `from,to,date` | `{rate, source, cached}` | **Sí (tasa; de 3 fuentes externas: scraping xe.com `:28-67`, currency-api `:70-101`, frankfurter `:103-123`)** | No BD; caché in-memory 24h (`:17`) |
| `app/api/email/sync/route.ts` | API | — | resultado sync | No | Indirecto |
| `app/api/progress/[progressId]/route.ts` | API SSE | progressId | stream `Progress` | No | **Sí**: `getOrCreateProgress` |
| `app/api/stripe/*`, `app/api/auth/*` | API facturación/auth | webhooks Stripe, sesiones | — | No (fuera de dominio contable del usuario) | **Sí**: `User.membershipPlan/aiBalance` |
| `components/unsorted/analyze-form.tsx` | UI cliente (formulario de revisión) | `File.cachedParseResult`, salida LLM, settings | `FormData` para guardar | No | No (estado React); **fusiona memoria + LLM + usuario sin marca de origen** (`:128-141`, `:238-243`) |
| `components/agents/currency-converter.tsx` | Tool cliente | total, monedas, fecha | `convertedTotal = round(total×rate×100)/100` (`:49`) | **Sí (código cliente)** | No |
| `components/agents/items-detect.tsx` | Tool cliente | `items[]` del LLM | UI + split | No (muestra `item.total*100`, `:56`) | Indirecto vía `splitFileIntoItemsAction` |
| `prisma/schema.prisma` — `Transaction` | Tabla | — | `total Int?` (céntimos), `convertedTotal Int?`, `items Json`, `files Json` (sin FK), `extra Json?` (`:169-202`) | — | Fuente de verdad de cifras; **sin campos de procedencia/tasa/confianza** |
| `prisma/schema.prisma` — `File.cachedParseResult` | Columna JSON (`:163`) | — | último output LLM o cifras de split | — | **Memoria reutilizable de cifras**, sobrescrita en cada análisis, sin timestamp/modelo |
| `prisma/schema.prisma` — `Setting` | Tabla (`:91-102`) | — | `code`, `value` (incluye prompt del sistema, modelos, api keys) | — | **Sin `updatedAt`, sin versión** |
| `prisma/schema.prisma` — `AppData` | Tabla KV JSON (`:215-224`) | — | config email/invoices | — | JSON libre por app |
| `prisma/schema.prisma` — `Progress` | Tabla (`:226-238`) | — | current/total | — | Sólo progreso UI; no es log de runs |

---

## 2.2 Matriz de cumplimiento (P1–P7)

Valores: **C** = CUMPLE · **P** = PARCIAL · **NC** = NO CUMPLE · **N/A**.

| Componente | P1 | P2 | P3 | P4 | P5 | P6 | P7 | Evidencia clave |
|---|---|---|---|---|---|---|---|---|
| `ai/analyze.ts` | **NC** | P | NC | **NC** | NC | NC | **NC** | Devuelve `output` del LLM con `total`/`vat`/`items` sin ninguna validación aritmética (`:35-47`); guarda en `cachedParseResult` (`:41`) descartando `response.provider`; sólo `console.log` (`:38-39`), sin run_id/modelo/prompt/hash |
| `ai/prompt.ts` | N/A | P | N/A | N/A | N/A | N/A | **NC** | Plantilla viene de `Setting` editable (`route.ts:96`), no de git; no se persiste el prompt final generado |
| `ai/schema.ts` | **NC** | N/A | N/A | N/A | N/A | N/A | P | Pide al LLM `total` (`Field.type=number`), `vat`, `vat_rate` e `items[].total` (`:17-27`); ningún campo de confianza en el schema; schema deriva de `Field` en BD (no git) |
| `ai/attachments.ts` | N/A | C | **NC** | N/A | N/A | N/A | P | Lee fichero en disco sin verificar hash; recorta a 4 páginas (`:8,28`) sin registrar que el LLM no vio el documento completo (riesgo: totales de página 5+) |
| `ai/providers/llmProvider.ts` | **NC** | N/A | N/A | N/A | NC | NC | **NC** | Cifras 100% generadas por el modelo; `openai_compatible` parsea texto libre con `JSON.parse` sin validar contra schema (`:106-118`); cadena de fallback entre proveedores distintos (`:252-270`) sin registrar cuál produjo el resultado; `tokensUsed` nunca se asigna (`:124-127`) |
| `lib/analyze-queue.ts` | N/A | N/A | N/A | C | N/A | N/A | N/A | Sólo concurrencia y contadores UI; no toca cifras |
| `lib/stats.ts` | **C** | C | N/A | C | P | NC | P | Sumas deterministas en código (`:3-43`); sin nivel de confianza; sin tests |
| `lib/llm-providers.ts` | N/A | N/A | N/A | N/A | N/A | N/A | C | Constantes en git |
| `models/transactions.ts` | **NC** | P | N/A | N/A | N/A | NC | P | `items` persistido tal cual (`:164,180`) — no valida Σitems = total; `findDuplicateTransaction` usa `"USD"` como default (`:138`) en vez de `default_currency`; `TransactionData` admite `[key:string]:unknown` (`:24`) |
| `models/stats.ts` | **NC** | C | N/A | C | P | NC | NC | Cálculo en TS, no SQL; `profitPerCurrency` = `income - expenses[currency]` → `NaN` si la moneda no tiene gastos y omite monedas sólo-gasto (`:28-33`, `:67-72`); series temporales asignan `0` a toda transacción en moneda ≠ default sin `convertedTotal` (`:165-170`, `:263-268`) → infra-reporte silencioso; sin tests |
| `models/settings.ts` | N/A | C | N/A | N/A | N/A | N/A | **NC** | Prompt y modelo por usuario en BD (`:120-134`); `getLLMSettings` elige modelo en runtime (`:41-101`); no hay historial de cambios |
| `models/defaults*.ts` | N/A | C | N/A | N/A | N/A | N/A | P | Prompt por defecto en git (`defaults-data.ts:1-18`) pero se copia a BD en el seed (`defaults.ts:216-222`) y desde ahí diverge sin control |
| `models/export_and_import.ts` | **NC** | **NC** | N/A | N/A | N/A | N/A | P | `num * 100` sin `Math.round` (`:40,58`) → céntimos no enteros para columna `Int`; `importProject/importCategory` hacen `findFirst` **sin `userId`** (`:140-144`, `:156-160`) → puede enlazar categoría/proyecto de otro tenant |
| `models/backups.ts` | N/A | N/A | **NC** | N/A | N/A | N/A | **NC** | Backup de `Transaction` omite `items` (`:185-205`); backup de `File` omite `cachedParseResult` (`:155-165`); restore ignora errores por fila (`:274-281`) y cuenta como insertada |
| `models/files.ts` | N/A | C | **NC** | N/A | N/A | N/A | N/A | `createFile/updateFile` aceptan `any` (`:283,292`); ningún hash de contenido |
| `forms/transactions.ts` | P | N/A | N/A | N/A | N/A | N/A | C | Redondeo a céntimos correcto (`:18,32`); `items` = `JSON.parse` sin schema Zod (`:58-68`); `.catchall(z.string())` deja pasar cualquier campo extra (`:70`) |
| `app/(app)/unsorted/actions.ts` | **NC** | **NC** | NC | **NC** | NC | NC | NC | Guarda `items` sin cruzar con `total`; `splitFileIntoItemsAction` copia el binario N veces y escribe cifras del LLM (`item.total`, en unidades no céntimos) en `cachedParseResult` (`:148-168`), creando N "memorias" con cifras como semilla de N transacciones |
| `app/(app)/transactions/actions.ts` | P | C | N/A | C | N/A | NC | P | Persistencia directa del formulario humano; sin procedencia |
| `app/(app)/dashboard` (+ `stats-widget.tsx`) | P | C | N/A | C | P | **NC** | NC | Muestra cifras de `models/stats.ts` sin indicar confianza ni monedas excluidas; no hay snapshot del conjunto de transacciones usado |
| `app/(app)/apps/email` + `lib/email-sync` | N/A | C | P | C | N/A | N/A | P | Watermark UID con lock `FOR UPDATE` (`ingest.ts:94-113`) correcto; metadata registra `messageId/from/subject` (`:64-71`) pero sin hash de adjunto → re-ingesta si se resetea `lastProcessedUid` |
| `app/(app)/apps/invoices` | **P** | C | N/A | C | N/A | NC | P | Total calculado en código (`actions.ts:72-75`) ✓, pero confía en `item.subtotal` y `tax.amount` calculados en cliente (no recalcula `qty×unitPrice` en servidor); `totalAmount * 100` sin redondeo (`:81`); campo `status:"pending"` (`:87`) no existe en modelo y se descarta silenciosamente |
| `app/(app)/import/csv` | P | **NC** | NC | C | N/A | NC | P | Sin hash/snapshot del CSV; hereda el bug de redondeo y el cross-tenant de `export_and_import.ts` |
| `app/api/unsorted/analyze/route.ts` | NC | C | NC | NC | NC | NC | **NC** | Orquesta sin `run_id`; `aiBalance` sólo decrementa si `tokensUsed > 0` (`:106-107`) → nunca (ver llmProvider) |
| `app/api/currency/route.ts` | **P** | **NC** | NC | P | N/A | NC | **NC** | Tasa es código (✓) pero: 3 fuentes heterogéneas (`:126-130`, xe.com por scraping HTML `:48-55`), la `source` se devuelve pero **no se persiste** en `Transaction`; caché in-memory (`:17`); "hoy" se convierte silenciosamente en "ayer" (`:171-174`) |
| `components/agents/currency-converter.tsx` | P | NC | N/A | N/A | NC | NC | NC | Conversión aritmética en navegador (`:49`), editable por usuario, tasa/fecha/fuente no llegan al servidor |
| `components/unsorted/analyze-form.tsx` | NC | NC | N/A | **NC** | NC | **NC** | NC | Precarga `cachedParseResult` como valores del formulario (`:128-141`); mezcla LLM+memoria+usuario en un solo estado sin origen (`:238-243`); `hasAnalyzed` se deduce de la memoria (`:69-71`) |
| `prisma/schema.prisma` — `Transaction` | P | C | **NC** | N/A | N/A | **NC** | **NC** | Céntimos `Int` ✓; sin `sourceFileHash`, `exchangeRate`, `rateSource`, `extractionRunId`, `confidence`; `files Json` sin FK (`:183`) |
| `prisma/schema.prisma` — `File.cachedParseResult` | NC | NC | NC | **NC** | N/A | NC | NC | Memoria mutable de cifras (`:163`), sin `parsedAt`, `model`, `promptHash` |
| `prisma/schema.prisma` — `Setting` | N/A | C | N/A | N/A | N/A | N/A | **NC** | Sin `updatedAt`/`version` (`:91-102`) → prompt del sistema no auditable |
| `prisma/schema.prisma` — `AppData`, `Progress` | N/A | C | N/A | C | N/A | N/A | P | JSON libre; `Progress` es progreso UI, no log de ejecución |

### Respuestas a las preguntas de la spec

| Pregunta | Respuesta | Evidencia |
|---|---|---|
| ¿El LLM devuelve total + items y se guardan sin validar Σitems = total? | **Sí.** No existe ninguna comprobación. Además `total` se almacena en céntimos y `items[].total` en unidades decimales (inconsistencia de unidad dentro de la misma fila). | `ai/schema.ts:17-27`, `forms/transactions.ts:18` vs `:58-68`, `models/transactions.ts:164`, `components/agents/items-detect.tsx:56` |
| ¿La conversión de moneda es código o LLM? | **Código** (tasa de API externa × total, en el navegador). El LLM no interviene. Pero la tasa y su fuente no se persisten y el usuario puede sobrescribir el resultado. | `app/api/currency/route.ts:132-147`, `components/agents/currency-converter.tsx:49`, `components/unsorted/analyze-form.tsx:344-359` |
| ¿Stats/dashboard se calculan en SQL/código? | **Código TS** (reduce en memoria tras `findMany`), no SQL. Determinista pero con dos bugs (NaN en profit; exclusión silenciosa de monedas no convertidas). | `models/stats.ts:25-33`, `:165-170`, `lib/stats.ts:3-17` |
| ¿`cachedParseResult` es una memoria que se reutiliza? | **Sí.** Se precarga como valores del formulario en cada render, se sobrescribe en cada análisis y el split la usa para sembrar cifras en ficheros nuevos. | `components/unsorted/analyze-form.tsx:128-141`, `ai/analyze.ts:41`, `app/(app)/unsorted/actions.ts:155-167` |
| ¿Hay registro de qué modelo/prompt produjo cada extracción? | **No.** `response.provider` se descarta; el modelo elegido depende del orden de fallback en runtime; sólo `console.log`. | `ai/analyze.ts:35-41`, `ai/providers/llmProvider.ts:250-277`, `models/settings.ts:41-101` |
| ¿Los prompts del sistema son editables por usuario sin versionado? | **Sí.** `prompt_analyse_new_file` y los `llm_prompt` de Field/Category/Project se editan desde la UI y se guardan en tablas sin `updatedAt` ni historial. | `components/settings/llm-settings-form.tsx:109-110`, `forms/settings.ts:24`, `app/(app)/settings/actions.ts:46`, `prisma/schema.prisma:91-102,134-151` |

---

## 2.3 Informe de gaps

Severidad: **ALTA** = puede producir una cifra errónea sin detección · **MEDIA** = rompe trazabilidad/reproducibilidad · **BAJA** = mejora. Esfuerzo: S (<1 día) / M (1-3 días) / L (>3 días).

| ID | Descripción | Principio | Sev. | Evidencia | Propuesta de corrección para el ERP | Esf. |
|---|---|---|---|---|---|---|
| G-01 | `total`, `vat`, `vat_rate` e `items[].total` son generados por el LLM y persistidos sin validación aritmética (Σitems ≠ total, base+IVA ≠ total no se detecta). Unidades mezcladas: `total` en céntimos, `items[].total` en unidades. | P1 | **ALTA** | `ai/schema.ts:17-27`; `forms/transactions.ts:18,58-68`; `models/transactions.ts:164`; `defaults-data.ts:362-370,422-440` | El LLM devuelve sólo *candidatos* tipados (`ExtractionCandidate`) con `raw_text` y bbox/página. Un módulo determinista `reconcile()` recalcula `total = Σ(qty×price)` (+IVA) desde items, compara con el total leído con tolerancia 0,01, y fija el estado: `calculado` si cuadra, `no verificado` si no. Zod estricto para `items` (céntimos `Int`, `currency` ISO). Persistir siempre en céntimos. | M |
| G-02 | Sólo se envían ≤4 páginas al LLM sin marcar la extracción como parcial: un total en página 5+ se pierde o se inventa. | P1/P6 | **ALTA** | `ai/attachments.ts:8,28` | Registrar `pagesAnalyzed/pagesTotal` en el run; si `pagesAnalyzed < pagesTotal` → confianza máxima `interpretación IA` y bloqueo de auto-guardado. | S |
| G-03 | `File.cachedParseResult` actúa como memoria de cifras: se precarga en el formulario, se sobrescribe sin historial y el split la usa para sembrar N ficheros con cifras del LLM. El usuario no distingue memoria de dato nuevo. | P4/P1 | **ALTA** | `analyze-form.tsx:69-71,128-141`; `ai/analyze.ts:41`; `unsorted/actions.ts:148-168` | Sustituir por tabla `ExtractionRun` (append-only: `fileHash, model, promptHash, schemaHash, output, createdAt, gitSha`). El formulario carga desde el run concreto y muestra el origen de cada campo; el split crea *líneas* dentro de la misma transacción (no ficheros clonados). Nunca leer cifras de una caché. | M |
| G-04 | Conversión de moneda: 3 fuentes heterogéneas (scraping HTML de xe.com, CDN jsdelivr, Frankfurter) con fallback silencioso; la tasa, la fuente y la fecha efectiva no se persisten; el cálculo se hace en el navegador y es editable. Un cambio de fuente altera `convertedTotal` sin rastro. | P1/P2/P7 | **ALTA** | `app/api/currency/route.ts:28-67,126-147,171-174`; `currency-converter.tsx:49`; `schema.prisma:178-179` | Una sola fuente oficial (BCE vía Frankfurter para EUR) con tabla `ExchangeRate(date, from, to, rate, source, fetchedAt)` persistida; conversión en servidor en el momento de guardar; columnas `exchangeRate`, `rateDate`, `rateSource` en la transacción; `convertedTotal` no editable (si el usuario fuerza, se marca `no verificado` + motivo). | M |
| G-05 | `profitPerCurrency` produce `NaN` cuando una moneda tiene ingresos sin gastos y omite monedas con sólo gastos. | P1 | **ALTA** | `models/stats.ts:28-33,67-72` | Agregar en SQL (`SUM(CASE type…) GROUP BY currency`) con `COALESCE(…,0)`; test unitario con fixtures multi-moneda. | S |
| G-06 | Series temporales asignan importe 0 a toda transacción cuya moneda ≠ default y sin `convertedTotal` → gráficos infra-reportan sin aviso. | P1/P6 | **ALTA** | `models/stats.ts:165-170,263-268` | Exigir `convertedTotal` para toda transacción no-default (G-04) y, en agregados, devolver `excludedCount/excludedAmount` que la UI muestre como "✗ N transacciones sin convertir". | S |
| G-07 | `parseFloat(value) * 100` sin `Math.round` en import CSV e invoices → céntimos no enteros para columna `Int` (fallo o truncado según driver). | P1 | MEDIA | `models/export_and_import.ts:40,58`; `apps/invoices/actions.ts:81` | Función única `toCents(decimalString): bigint` (parseo decimal exacto, sin float) usada por todos los caminos de entrada; test con `19.99`, `0.1+0.2`. | S |
| G-08 | `importProject/importCategory` buscan por `code`/`name` sin `userId` → posible enlace cross-tenant o fallo de FK compuesta. | P2 | MEDIA | `models/export_and_import.ts:140-144,156-160`; `schema.prisma:185-188` | Todas las consultas de catálogo con `userId` obligatorio (helper `scoped(prisma, userId)`); test de aislamiento multi-tenant. | S |
| G-09 | No se registra proveedor/modelo/prompt/schema/tokens por extracción; el proveedor real depende del fallback en runtime; `response.provider` se descarta. | P7 | MEDIA | `ai/analyze.ts:35-41`; `llmProvider.ts:250-277`; `models/settings.ts:41-101` | `ExtractionRun` (G-03) con `provider, model, promptHash, schemaHash, temperature, tokensIn/Out, latencyMs, gitSha, runId`; el fallback registra la cadena de intentos. | M |
| G-10 | Prompt del sistema y `llm_prompt` de Field/Category/Project editables desde UI, guardados en BD sin `updatedAt` ni versión; el prompt efectivo no está en git. | P7 | MEDIA | `forms/settings.ts:24`; `settings/actions.ts:46`; `llm-settings-form.tsx:109`; `schema.prisma:91-102,134-151` | Prompts y schemas versionados en git (`prompts/*.md` + `CHANGELOG`); en BD sólo `promptVersion` seleccionada; tabla `PromptOverride` con historial si se permite personalización. Cada run guarda `promptHash`. | M |
| G-11 | Sin snapshot inmutable del documento fuente: `File.metadata` sólo guarda `size`; el fichero en disco puede reemplazarse; dedupe por (total, merchant, fecha, moneda) y no por hash. | P3 | MEDIA | `lib/uploads.ts:228`; `models/transactions.ts:136-155`; `schema.prisma:153-167` | `File.sha256` obligatorio al ingerir (y verificado antes de cada análisis); dedupe primaria por hash; storage write-once (objeto inmutable, versionado si se re-sube). | S |
| G-12 | `tokensUsed` nunca se rellena → `aiBalance` nunca se decrementa y no hay métrica de coste; el único log es `console.log`. | P7 | MEDIA | `llmProvider.ts:124-127`; `analyze/route.ts:106-107`; `ai/analyze.ts:38-39` | Leer `usage_metadata` de LangChain y persistir en `ExtractionRun`; logger estructurado (JSON) con `runId`. | S |
| G-13 | Sin nivel de confianza: valores LLM, de memoria y del usuario se fusionan en un mismo estado; `Transaction` no tiene campos de procedencia. | P6 | MEDIA | `analyze-form.tsx:128-141,238-243`; `schema.prisma:169-202` | Cada campo numérico persistido lleva `{value, status ∈ {calculado, comprobado, validado, interpretación IA, no verificado}, source ∈ {llm, user, computed, import}, runId}` (tabla `FieldProvenance` o JSON tipado). La UI colorea por estado y el dashboard muestra el peor estado del agregado. | M |
| G-14 | Roles no separados: el mismo output del LLM extrae cifras y redacta `name/description`; el único auditor es el humano en el formulario; no existe validación automática. | P5 | MEDIA | `ai/schema.ts:3-31`; `defaults-data.ts:295,305`; `analyze-form.tsx` | Tres pasos con contratos distintos: (1) *Extractor* LLM → candidatos; (2) *Calculador* determinista → cifras + estado; (3) *Auditor* (reglas + opcionalmente segundo LLM en modo verificación con otro prompt/modelo) que sólo puede degradar confianza. La *redacción* (name/description) es un cuarto paso que recibe cifras ya cerradas. | L |
| G-15 | Backups omiten `Transaction.items` y `File.cachedParseResult`; el restore silencia errores por fila y los cuenta como insertados. | P3/P7 | MEDIA | `models/backups.ts:185-205,155-165,274-281` | Backup = dump completo versionado con `schemaVersion` + manifest con hashes; restore transaccional (todo o nada) con informe de filas rechazadas. | S |
| G-16 | Dos fuentes de verdad para los hechos de un documento (`File.cachedParseResult` vs `Transaction`), y `Transaction.files` es JSON sin FK. | P2 | MEDIA | `schema.prisma:163,183`; `unsorted/actions.ts:135-172` | Relación `TransactionFile` con FK; `Transaction` es la única fuente de cifras; `ExtractionRun` es evidencia, nunca fuente. | S |
| G-17 | `openai_compatible` parsea texto libre con `JSON.parse` sin validar contra el schema → tipos no garantizados (`total` como string, campos ausentes). | P1 | BAJA | `llmProvider.ts:106-118` | Validar toda salida (cualquier proveedor) con el mismo Zod derivado del schema antes de devolverla; rechazar y registrar si no valida. | S |
| G-18 | Caché de tasas en memoria de proceso (se pierde en cada despliegue) y "hoy" se convierte en "ayer" sin informar. | P7 | BAJA | `app/api/currency/route.ts:17,171-174` | Cubierto por tabla `ExchangeRate` (G-04); devolver `rateDate` efectiva al cliente. | S |
| G-19 | `findDuplicateTransaction` asume `"USD"` si no hay moneda, ignorando `default_currency`. | P1 | BAJA | `models/transactions.ts:138` | Moneda obligatoria en el modelo (`NOT NULL`), default resuelto en una sola función. | S |
| G-20 | Sin tests de `models/stats.ts`, `lib/stats.ts`, `ai/*`; sólo existen tests de Zod, cola y email-sync. | P7 | BAJA | `forms/transactions.test.ts`, `lib/analyze-queue.test.ts`, `lib/email-sync/*.test.ts`; `.github/workflows/ci.yml` | Golden tests: documentos de ejemplo → salida esperada del calculador; tests de agregados multi-moneda; test que falla si el prompt cambia sin bump de versión. | M |
| G-21 | Invoices: el servidor confía en `item.subtotal` y `tax.amount` calculados en el cliente en lugar de recalcular `qty×unitPrice`. | P1 | BAJA | `apps/invoices/actions.ts:72-75`; `invoice-generator.tsx:39,52` | Recalcular en servidor desde `qty, unitPrice, taxRate` con aritmética entera; el cliente sólo previsualiza. | S |
| G-22 | Email-sync: adjuntos sin hash → re-ingesta duplicada si se resetea `lastProcessedUid`; `metadata.messageId` no se usa para dedupe. | P3 | BAJA | `lib/email-sync/ingest.ts:58-74`; `filters.ts:12-26` | Dedupe por `sha256(adjunto)` + `messageId` (índice único por usuario). | S |

**Totales:** ALTA 6 (G-01…G-06) · MEDIA 10 (G-07…G-16) · BAJA 6 (G-17…G-22) · **22 gaps**.

---

## 3. Cobertura de principios (vista agregada)

| Principio | Estado global | Componentes que lo cumplen | Bloqueo principal |
|---|---|---|---|
| P1 código calcula | **NO CUMPLE** | `lib/stats.ts`, `forms/transactions.ts` (céntimos), `invoices/actions.ts` (parcial) | Todas las cifras de origen (total, IVA, items) nacen en el LLM y nunca se recalculan (G-01) |
| P2 fuente única | PARCIAL | `Transaction` como tabla de cifras | `cachedParseResult` duplica hechos; tasa de cambio de 3 fuentes; catálogos sin scope de usuario (G-04, G-08, G-16) |
| P3 snapshot inmutable | **NO CUMPLE** | — (email-sync tiene watermark, no hash) | Sin hash de ficheros ni de conjuntos de datos usados en agregados (G-11) |
| P4 memoria ≠ cifras | **NO CUMPLE** | `lib/analyze-queue.ts` (memoria sólo de estado UI) | `cachedParseResult` (G-03) |
| P5 separación de roles | **NO CUMPLE** | — | Un solo prompt extrae + redacta; auditor = humano (G-14) |
| P6 nivel de confianza | **NO CUMPLE** | — | Ningún campo de procedencia/estado en modelo ni UI (G-13) |
| P7 reproducible | **NO CUMPLE** | `lib/llm-providers.ts`, `defaults-data.ts` (constantes en git), CI con vitest | Sin run log, sin versión de prompt, modelo resuelto en runtime (G-09, G-10, G-12) |

---

## 4. Conclusión para el ERP

1. **Se hereda tal cual**: modelo `Transaction` en céntimos `Int` con `extra Json` para campos dinámicos; `Field/Category/Project` con `llm_prompt` como mecanismo de configuración; adapter multi-proveedor LangChain (`llmProvider.ts`) con `temperature=0`; cola de concurrencia (`analyze-queue.ts`); ingesta IMAP con watermark y lock `FOR UPDATE`; generación de previews (`lib/previews`); validación Zod de formularios.
2. **Se envuelve con capa de fiabilidad**: `ai/analyze.ts` + `route.ts` pasan a ser el paso *Extractor* que sólo produce candidatos y escribe en `ExtractionRun` (hash fichero, modelo, promptHash, gitSha, tokens); `models/stats.ts` se reescribe en SQL agregado pero conserva su API; `api/currency` se reduce a una fuente persistida en `ExchangeRate` y la conversión pasa al servidor; `export_and_import` y `invoices` usan un único `toCents` y scope por usuario.
3. **Se reescribe**: el contrato LLM→BD (nuevo `reconcile()` determinista que recalcula totales/IVA desde items y asigna nivel de confianza P6); `File.cachedParseResult` desaparece (sustituido por runs append-only); `analyze-form.tsx` se rehace para mostrar origen y estado de cada campo y bloquear guardado de cifras `no verificado`; prompts y schemas salen de `Setting` y viven versionados en git; backups pasan a dump completo transaccional con manifest de hashes.
4. Orden recomendado: G-01/G-03/G-13 (contrato cifras + procedencia) → G-04/G-05/G-06 (moneda y agregados) → G-09/G-10/G-11 (trazabilidad) → resto.
