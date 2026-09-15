# ADR-0019 — Plataforma SaaS: facturación y límites por organización, backup/restore como criterio de reproducibilidad, almacenamiento de objetos, cron de plataforma, portabilidad irrenunciable y serie de facturación propia

**Estado:** **APROBADO por Pablo** (permiso general delegado de 2026-09-04)
**el 2026-09-15**, **D1 … D8**; **D9 APROBADA por Pablo en chat el 2026-09-15**
(ronda de integración de las tres olas) · **Nivel:** 2 · **Fecha:** 2026-09-15 ·
**Ronda 2** (validación contable incorporada, más **O-16** y **O-17** del cierre) ·
**Épica:** E11 ·
**Diseño:** `docs/design/E11-plataforma-saas.md` ·
**Validación contable:** `docs/design/E11-validacion-plataforma.md` —
**OBSERVACIONES**: cinco bloqueantes (**O-1, O-3, O-4, O-7, O-9/O-10**), diez no
bloqueantes (**O-2, O-5, O-6, O-8, O-11…O-15**) y **C-1…C-7 respondidas**.
**Las quince están incorporadas**, y este ADR pasa de seis decisiones a **ocho**:
**D7** nace de O-3 y **D8** de O-9/O-10 · **D5 de la ronda 1 (CAPEX en el
`budgetHash`) SALE de este ADR** con el alcance (§«Lo que sale») ·
**Complementa:** ADR-0001 («planes/membresía a nivel organización»), ADR-0002 y
ADR-0009 (multi-tenant y RLS estricta), ADR-0003 (informes derivados, sellos,
anulación por contra-asiento), ADR-0011 (forma canónica de los hashes), ADR-0012
(cachés por hash y motivos de sello), ADR-0014 D8 (clave de periodo `AAAA-Qn`),
ADR-0015 D3 (retención de runs), ADR-0017 (su R4 se cierra aquí) ·
**No enmienda ninguno.** En la ronda 1 enmendaba ADR-0018 D2; al salir el CAPEX,
**ya no**.

> **Firmado.** Las tareas que bloqueaba —**T2, T3, T4, T7, T8, T9, T15, T16, T17,
> T18 y T20** del plan de §15 del diseño— quedan **desbloqueadas**: E11 puede pasar
> a **`/sprint E11`** en las tres olas de §16.

---

## Contexto

Tras E10 el ERP es contablemente completo. **No es todavía un producto que alguien
pueda contratar y operar sin nosotros.** Lo que falta no es funcionalidad contable;
es plataforma. Los hechos del código que fuerzan cada decisión:

1. **La facturación heredada son cuatro columnas sueltas en `Organization`**
   (`membershipPlan`, `membershipExpiresAt`, `storageLimit`, `aiBalance`), que E1
   movió de `User` a `Organization` (T11) y dejó ahí. El plan vive en una constante
   de TypeScript (`PLANS` en `lib/stripe.ts`) y **el único límite aplicado en
   servidor es el de almacenamiento** (`lib/files.ts:165`). `aiBalance` nunca se
   decrementa (G-12); `membershipExpiresAt` en el pasado no impide ni una escritura.
2. **El webhook no es idempotente y puede crear tenants.** Stripe reintenta por
   diseño y el efecto se aplica otra vez; si no encuentra el `stripeCustomerId`,
   `getOrCreateCloudUser` **da de alta un usuario y una organización** con el email
   del cliente; y devuelve `400` a todo evento no manejado, que Stripe interpreta
   como fallo y **reintenta indefinidamente**.
3. **El backup es el gap G-15 de `AUDITORIA-FIABILIDAD.md`, literalmente**, y el
   último MEDIA abierto junto a G-14: cubre **9 tablas de las 66**, ninguna
   contable; `modelFromJSON` captura el error por fila **y suma igual a
   `insertedCount`**; `preprocessRowData` **adivina tipos** (`!isNaN(Number(value))`
   convierte la cuenta `0400` en `400`); `REMOVE_EXISTING_DATA = true` **borra el
   destino antes** de comprobar si el archivo sirve; y no hay manifest, ni firma, ni
   verificación.
4. **Los ficheros no persisten donde se despliega.** `lib/files.ts:7` resuelve contra
   `FILE_UPLOAD_PATH`, que en Vercel es `/tmp`: el `sha256 NOT NULL` de E8 y el
   invariante I-E8-2 vigilan hoy **unos bytes que el despliegue siguiente no tiene**.
5. **No hay reloj.** `etc/crontab` es del contenedor Docker. Los recurrentes de E9 no
   se generan solos, el barrido de E7 es un script a mano y la retención de
   ADR-0015 D3 es otro: **todo el trabajo automático del motor contable depende de
   una persona con una terminal**.
6. **La validación contable (ronda 2) destapó cinco defectos bloqueantes** que
   ninguna de las seis decisiones de la ronda 1 cubría, y dos de ellos son de fondo:
   un límite de plan **impedía registrar un hecho contable ya ocurrido**, y
   **nuestra propia serie de facturación no la vigilaba nadie** mientras se le exige
   al cliente I-E8-20.

---

## Decisión

### D1 · Facturación y límites por ORGANIZACIÓN, con el plan versionado y el uso derivado

1. **`Plan` es catálogo global versionado por vigencia** (`@@unique [code,
   validFrom]`, `EXCLUDE USING gist`), con los **límites como columnas** —no JSON—
   para que la base los pueda comprobar y un cambio de forma exija migración. El
   catálogo lo cambia una **migración**: `plans` lleva `ENABLE` + `FORCE` con
   `RESTRICTIVE … USING (false)` en escritura, patrón de `exchange_rates`.
2. **`Subscription` por organización, una y sólo una**, con FK a la **versión**
   contratada: un cambio de límites **no reescribe retroactivamente** lo prometido.
3. **`SubscriptionEvent` append-only con `stripeEventId` UNIQUE.** Ésa es la
   idempotencia. Un evento cuyo cliente no resuelve devuelve `200` y queda como
   `ORPHAN_WEBHOOK`: **un webhook no puede dar de alta un tenant**. Un evento no
   manejado devuelve `200`, no `400`.
4. **El estado se traduce a acceso por una función pura**, `accessLevelOf`, definida
   **una sola vez** y verificada por I-E11-5. La consume `requireOrg`.
5. **El uso NO se almacena.** No existe contador que se incremente al escribir: las
   seis métricas se **derivan** por agregado SQL y se cachean en `UsageRun` por
   `sourceHash` + `gitSha` (patrón de `ReportRun`, ADR-0012). **`aiBalance` se
   retira como saldo**: es la cifra que P2/P4 prohíben y además nunca funcionó.
   **O-14**: la migración M4 **comprueba y aborta** si encuentra `aiBalance > 0` e
   imprime el importe **en euros al precio de venta** — un saldo prepagado es un
   pasivo (438/485 en **nuestra** contabilidad) y darlo de baja exige canje o
   devolución aceptados, no una novación unilateral. *Verificado sobre el preview: 1
   organización, saldo 0. El punto decae, pero se comprueba, no se supone.*
6. **O-5 · el recuento de `entries` excluye** contra-asientos, asientos de sistema
   (`REGULARIZATION`/`CLOSING`/`OPENING` y T-25…T-28) y los de una organización de
   demo. *Corregir un error no puede costar el doble que dejarlo, cuando el
   contra-asiento es el único camino admitido (ADR-0003).*
7. **Los límites se aplican en el servidor, en la misma transacción que la
   escritura**, por un único guardián `assertWithinLimit()`, en las **siete**
   acciones de cuota **dura** (D7 explica por qué el posteo no está entre ellas).
   Superar un límite devuelve un error **legible, en español, con la cifra
   concreta** y **no deja nada a medias**. **I-E11-4** lo verifica, incluido un test
   estático sobre el AST.

### D2 · Backup y restauración como criterio de reproducibilidad (P7), **con el enunciado ampliado por O-1**

1. **Formato 2.0**, con `manifest.json` (sha256 por entrada), `signature.txt`
   (HMAC-SHA256 con `keyId` rotable), `data/<tabla>.jsonl`, `files/<sha256>` y
   `seals.json`. El formato 1.0 de TaxHacker **no se lee ni se escribe**: no existe
   ni un backup 1.0.
2. **El inventario se deriva de `TENANT_MODELS`, no se escribe a mano**, y
   **I-E11-7** falla si `TENANT_MODELS ⊄ inventario`. Es la decisión que impide
   repetir por cuarta vez el mismo fallo (BUG-E7-1, BUG-E9-5, BUG-E10-1).
3. **`organization_id` no se vuelca**: lo inyecta `tenantDb` al restaurar, así que
   un backup **no puede aterrizar en otra organización** por accidente.
4. **La restauración va SIEMPRE a una organización nueva.** Nunca se sobrescribe una
   con datos: el diario es append-only y «vaciar y volver a meter» lo contradice; el
   restore actual borra **antes** de validar; y verificar P7 exige un destino limpio.
5. **Una sola fila rechazada aborta el trabajo entero**, con tabla, línea y motivo.
   Se acaba el bucle que cuenta como insertada la fila que falló (G-15).
6. **O-1 · los tres hashes NO son criterio P7 suficiente.** `ledgerHash`,
   `analyticsKey` y `budgetHash` cubren importes y dimensiones; **si la forma
   canónica ordena por fecha/cuenta/importe, dos asientos con los `entryNumber`
   intercambiados dan el mismo hash** — y la numeración correlativa es lo primero
   que un auditor mira (art. 28.2 CCom). El éxito se define por **seis**
   comprobaciones, todas en un `restoreVerification.json`:
   1. **recuentos tabla a tabla** con `=`, no `⊇`;
   2. **numeración**: sin huecos ni duplicados por `(ejercicio, serie)`, y último
      número de cada `InvoiceSeries`;
   3. **recomputo de *todos* los sellos derivados** (`proposal_sha`, `schema_sha`,
      `prompt_sha`, `linesHash`, `checksHash`, `scheduleHash`, `inputHash`,
      `timeHash`, `ReportRun.validation`) sobre una lista **derivada del código**
      (`derivedSealColumns()`), no escrita a mano;
   4. **`AuditLog`**: recuento y sha256 de su forma canónica — sin esto se pierde
      quién forzó qué y con qué motivo;
   5. los **tres sellos** y el **estado del cierre** (`FiscalYear.status`/`closedAt`,
      `ClosingRun`);
   6. **barrido completo de las nueve familias** de invariantes sobre el destino, con
      su `checksHash`, y correspondencia `File` ↔ objeto.
   Y el ZIP incluye una sección **`global/exchange_rates.jsonl`** con las tasas
   **referenciadas** por lo volcado: `exchange_rates` es tabla global, **no está en
   `TENANT_MODELS`**, y sin ella el destino no reproduce `convertedTotal` (I-E8-5).
   El restore las inserta si faltan y **falla si una existe con otro valor**.
   *§11.1 de la ronda 1 prometía el barrido en prosa, pero el contrato de I-E11-2 no
   lo decía. Lo que no está en el enunciado no se ejecuta: H-1 de E9 y H-1 de E10.*
7. **O-2 · `DONE` queda reservado a `verified = true`.** Un resultado sin verificar
   es **`DONE_UNVERIFIED`**, con las seis comprobaciones enfrentadas a la vista y la
   organización **conservada y marcada** — borrarla sería destruir la evidencia. Un
   operador que filtre por `DONE` no puede leer como bueno lo que este ADR declara
   FAIL.
8. **El volcado sella al principio y al final**: si el sello cambió durante el
   volcado, `FAILED` y reencolado. *Un backup de un estado que nunca existió es peor
   que no tener backup.*
9. **Retención de los ZIP**: 30 días por defecto, configurable dentro del máximo del
   plan; nunca se borra uno con un `RestoreJob` vivo. **O-11**: los
   `StoredObject` de `kind = PLATFORM_INVOICE` **quedan excluidos** — son nuestras
   facturas emitidas, sujetas a conservación (art. 165.Uno LIVA, arts. 19–23
   RD 1619/2012), no ZIP de exportación. La retención **no** alcanza a libros ni
   justificantes (art. 30 CCom, seis años; diez con BIN, art. 26.5 LIS), y se dice
   así en la UI. **No existe borrado de organización** con asientos: el
   `onDelete: Cascade` es salvaguarda de integridad referencial, no camino de
   producto, y un test lo comprueba.

### D3 · Almacenamiento de objetos

1. **Driver único** con `LOCAL` (desarrollo y self-hosted) y `S3`. **Supabase
   Storage se consume por su endpoint S3** (P-3): un solo driver de red.
2. **Un bucket por entorno, con prefijo por organización**, y **no** un bucket por
   organización: eso obligaría a crear infraestructura **dentro de la transacción de
   alta** —justo lo que la siembra atómica no puede permitirse—, choca con las
   cuotas del proveedor y no aporta aislamiento que la política no dé.
3. **Clave determinista por contenido**
   `<prefijo>/<organizationId>/<kind>/<sha256[0:2]>/<sha256>`.
4. **`files.sha256` sigue siendo la verdad y I-E8-2 no cambia de enunciado**: sólo
   cambia de dónde se leen los bytes, y eso ya se **inyecta** desde H-3 de E8.
   **I-E11-6** extiende la comprobación al almacén, **filtrando por `kind`, no por
   prefijo** (O-12c): los ZIP y las copias de nuestras facturas viven en el mismo
   bucket y no son cuota del cliente.
5. **La migración verifica el sha antes de subir** y, si no coincide, **no sube y lo
   informa**: un fichero alterado no se propaga al almacén nuevo con la bendición de
   la migración.

### D4 · Cron de plataforma

1. **Una sola ruta**, `POST /api/cron/[job]`, autenticada por `CRON_SECRET` con
   comparación en tiempo constante. La llama un **GitHub Actions scheduled
   workflow** (P-5, sin coste) y **Vercel Cron diario como respaldo**. Un camino,
   dos relojes.
2. **Idempotencia por `CronRun` con `@@unique([job, periodKey])`**: se inserta
   primero; si choca, `200 {skipped:true}`.
3. **Troceado con cursor**, presupuesto de 240 s. **Un job que no cabe nunca se
   declara `DONE`.**
4. **Aislamiento por organización**: un fallo no detiene el job.
5. **O-13 · el reloj jamás entra en una cifra contable.** El job pasa **`refDate`
   explícito** (persistido en `CronRun.refDate`) y la ocurrencia **se fecha por su
   periodo de devengo**, nunca por el instante de ejecución — que es exactamente lo
   que `.claude/hooks/guard.sh` prohíbe en `lib/ledger`. Test obligatorio: lanzarlo
   **con dos días de retraso, o dos veces, produce el mismo asiento y el mismo
   `inputHash`** (I-E9-1b). Y se declara qué hace cada job **en mora**:
   `invariant-sweep`, `backup-worker` y `retention` corren; `recurring-due` genera
   sólo las ocurrencias de obligación devengada de D7 y deja el resto en `OMITIDA`
   con motivo `SUSCRIPCION_EN_MORA`, de modo que **I-E9-1a no falla por un impago
   nuestro**.
6. **Los scripts se conservan**: el cron invoca `run-invariants` y `prune-runs` como
   biblioteca. Un operador tiene que poder lanzarlos a mano.

### D5 ✚ · La portabilidad no la puede desactivar un precio (O-4)

La ronda 1 dejaba una contradicción entre D6 y la tabla de planes: FREE con
`maxBackupsMonth = 1`, `graceDays = 0` y retención de 7 días **no podía ejercer la
portabilidad que D6 le promete**. Gastado el único backup, `assertWithinLimit` lo
rechazaba. Tres reglas, y van en el ADR, no en la UI:

1. El **backup de salida** (`BackupTrigger.EXIT`, o cualquiera pedido por una
   organización que no esté en `FULL`) **no consume `maxBackupsMonth`**:
   `checkLimit` devuelve `ok` **sin mirar el uso**.
2. Tras `CANCELED`, **ventana mínima de descarga de 90 días** (`exportWindowUntil`),
   por encima de la retención del plan, con aviso al inicio y a falta de 15 días.
3. `maxBackupsMonth` **nunca** se aplica cuando `accessLevelOf ≠ FULL`.

### D6 · El impago retira la escritura ordinaria, nunca la lectura ni la exportación

`accessLevelOf` devuelve, como máximo castigo por impago, **`READ_ONLY`**. Jamás
`BLOCKED`, que se reserva a la organización desactivada por su propio ADMIN. En
`READ_ONLY` siguen funcionando: consultar, exportar informes, **pedir y descargar un
backup completo** (D5) y el checkout y el portal de Stripe, que es cómo se sale del
impago.

Se escribe como Nivel 2 por dos motivos: (a) parte de lo que custodiamos son **libros
y justificantes obligatorios de un tercero**, y retenerlos por una deuda comercial es
un riesgo legal que no queremos ni tener que discutir; (b) es exactamente la clase de
regla que alguien «optimiza» después para forzar un pago, y queda aquí para que
hacerlo exija enmendar un ADR.

### D7 ✚ · Ningún límite de plan puede impedir el registro de un hecho contable ya ocurrido (O-3)

Éste es el defecto contable de fondo que la validación destapó. El diseño declaraba
el principio correcto —«nadie debe dejar de contabilizar por miedo a la factura»— y
a continuación lo implementaba como **bloqueo duro**: `maxEntriesMonth` pasaba por el
guardián y el asiento 2 001 se rechazaba; y en `READ_ONLY`, `postEntryAction`
devolvía error.

La obligación de llevanza no es nuestra, **pero el impedimento sí lo creábamos
nosotros**: el art. 28.2 CCom (asientos dentro de los tres meses), el art. 164 LIVA y
los plazos del SII y de las autoliquidaciones no admiten «mi proveedor de software me
agotó la cuota». Un auditor que vea un diario con un salto de tres semanas y un
ticket que diga «límite de plan» **rechaza el sistema**, no al cliente.

> **Regla, textual:** *«Ningún límite de plan puede impedir el registro de un hecho
> contable ya ocurrido, ni en cuota agotada ni en mora.»*

1. **Dos clases de cuota.** **De recurso** (`maxMembers`, `maxOcrDocsMonth`,
   `maxStorageBytes`, `maxExportsMonth`, `maxBackupsMonth`, `maxOrganizations`):
   bloqueo legítimo, son recursos de la plataforma, no hechos contables. **Sobre el
   registro contable** (`softMaxEntriesMonth`, así llamada en el esquema para que
   nadie la cablee al guardián por descuido): **blanda, nunca rechaza un
   `postEntry`**.
2. **Régimen del límite blando**: aviso al 80 % y al 100 %, motivo
   `CUOTA_DE_ASIENTOS_SUPERADA` en cabecera y en `/settings/subscription`, **WARN en
   la familia `PLATAFORMA` de `/audit`**, bloqueo de lo **accesorio** (demo,
   importaciones masivas, nuevas organizaciones) y propuesta de cambio de plan **el
   mes siguiente**.
3. **La excepción es automática y registrada.** La ronda 1 admitía superar un límite
   «si existe un `AuditLog` de excepción con motivo», pero `/admin` es de sólo
   lectura y **nadie podía concederla**: un callejón sin salida. Ahora la concede el
   propio motor y queda en `PlatformAuditLog`.
4. **Qué sobrevive a `READ_ONLY`**, lista cerrada y verificada por I-E11-5: los
   **contra-asientos de anulación** (único camino de corrección, ADR-0003); los
   **asientos del sistema que cierran obligaciones ya devengadas** (recurrentes
   vencidos, devengo RECC T-36, liquidación de IVA del periodo, los cuatro del cierre
   si el ejercicio vence durante la mora); el **registro de documentos ya recibidos**
   (la anotación en el libro registro no se suspende porque no hayamos cobrado); y
   **exportar, consultar y pedir un backup**. El mensaje de mora lo dice en español y
   sin eufemismo: el cliente puede llevarse sus libros y la llevanza sigue siendo
   suya.
5. **O-16 · la asimetría entre subir y analizar.** Registrar un documento recibido
   incluye **subir el papel**: sin bytes no hay `sha256`, ni justificante, ni I-E8-2
   que valga. Por eso `uploadFileAction` **se permite en `READ_ONLY`** y
   `maxStorageBytes` es **dura en `FULL` y blanda fuera de `FULL`**, con aviso y
   excepción automática registrada. **`analyzeFileAction`, en cambio, se deniega**:
   el OCR es consumo de un proveedor que pagamos nosotros, **no un acto de
   llevanza**, y el documento se puede registrar y contabilizar a mano. Es la línea
   exacta que D7 traza: lo que la norma obliga a hacer no lo bloqueamos; lo que nos
   cuesta dinero, sí.

### D8 ✚ · La serie de facturación de la plataforma es NUESTRA, y se vigila como la del cliente (O-9, O-10, C-1…C-5)

`PlatformInvoice` guardaba `stripeInvoiceId`, un `number` **opcional**, importes y
dos URL. Con eso no se acredita ni la serie, ni el devengo, ni el tratamiento fiscal,
ni la conservación. Y **nuestra propia serie no la vigilaba nadie**, mientras a las
del cliente se les exige I-E8-20: es el defecto más difícil de defender ante un
auditor.

1. **Numeramos nosotros.** La correlatividad dentro de serie la asigna el expedidor
   (arts. 6.1.a y 7 RD 1619/2012). Stripe deja **huecos** (borradores anulados,
   `void`, `draft` no finalizadas) y según configuración numera por cliente: no puede
   ser nuestra serie. `PlatformInvoiceSeries` con `PLT-AAAA-NNNN` (ordinaria) y
   `PLT-R-AAAA-NNNN` (rectificativa), asignada al finalizar la factura en Stripe, que
   queda como **pasarela de cobro y generador del PDF**.
2. **`operationDate` (devengo) además de `issuedAt`** (C-2): el plazo de expedición
   para destinatario empresario llega al **día 16 del mes siguiente** (art. 11
   RD 1619/2012) y, cuando difieren, **ambas constan** (art. 6.1.f). El devengo del
   tracto sucesivo es la **exigibilidad** (art. 75.Uno.7º), anticipada por el cobro
   (art. 75.Dos): que Stripe cobre el día 3 una renovación exigible el día 1 **no
   mueve el devengo**. `ivaPeriod` se deriva de `operationDate` con la **misma clave
   canónica `AAAA-Qn`** del ERP (ADR-0014 D8).
3. **Tratamiento fiscal probado y revalidado en cada devengo** (C-1): `taxTreatment`
   ∈ {`REPERCUTIDO_ES`, `NO_SUJETO_LOCALIZACION_UE`, `NO_SUJETO_TERCER_PAIS`,
   `NO_SUJETO_CANARIAS_CEUTA_MELILLA`}, con país, NIF-IVA y **prueba de la
   validación VIES conservada en nuestro lado** (`vatValidatedAt`, fuente,
   referencia) **sellada en el devengo, no en el alta** — un NIF-IVA se da de baja.
   `automatic_tax` de Stripe es **motor de cálculo, no prueba y nunca responsable**:
   el sujeto pasivo es CFOnomic (art. 164 LIVA). **VIES caído o NIF inválido ⇒ se
   repercute 21 %**; nunca se presume válido. **O-15**: para nosotros la venta a
   empresario UE **no es «una ISP», es una no sujeción por localización** —la
   inversión la aplica el destinatario en su Estado—; en la **factura** sí se imprime
   la mención (art. 6.1.m). **Venta B2B-only** (P-1): admitir B2C UE obliga a OSS
   (modelos 035 y 369) por un segmento residual en un ERP para PYMEs.
4. **Rectificativas** (C-3): *refund* y prorrateo **negativo** son factura
   rectificativa en **serie específica**, con referencia, causa y modo (diferencias o
   sustitución), art. 15 RD 1619/2012. El prorrateo **positivo** es operación nueva,
   no rectifica nada.
5. **Moneda** (C-4): la factura puede ir en USD, pero **la cuota se expresa siempre
   además en euros** (`taxCentsEur`), a la tasa del **devengo**, de la misma
   `ExchangeRate` del ERP. **`RC-14` no aplica aquí**: la factura hay que emitirla
   igual, así que en día sin publicación se usa la **última tasa anterior al
   devengo** y **su fecha se imprime**. Se convierte una vez y se sella.
   `CHECK (currency IN ('EUR','USD'))` (O-12a): `totalCents Int` presupone dos
   decimales.
6. **Conservación** (C-5): el PDF se **copia a nuestro almacén** como `StoredObject`
   de `kind = PLATFORM_INVOICE`, indexado por `(serie, número)`. Un
   `hostedInvoiceUrl` **no es una copia conservada**: es un enlace a la copia de un
   tercero, sin compromiso de 6/10 años y sin acceso si se cierra la cuenta; y
   conservar por medios electrónicos fuera de España exige acceso completo en línea y
   su comunicación (art. 23 RD 1619/2012).
7. **I-E11-13**, espejo exacto de I-E8-20: numeración correlativa **sin huecos**, sin
   duplicados, `operationDate` **no decreciente** respecto del número, y toda
   rectificativa en serie `RECTIFICATIVA` referenciando una factura existente.
   Tolerancia 0, **y ejecutado en el barrido**, no sólo definido.
8. **O-17 · el 349 no espera a la pantalla.** El export 303/349 sale del alcance y va
   a **E14**, pero la obligación es actual (arts. 79–81 RIVA; trimestral, **mensual**
   pasados 50 000 € en el trimestre en curso o en alguno de los cuatro anteriores).
   Como los campos que la alimentan entran **ahora** (punto 3), **T23 escribe en
   `docs/deploy/e11-plataforma.md` las dos consultas SQL de operador** —la del 349 por
   NIF-IVA agrupada por **`operation_date`**, y la del umbral de periodicidad— con un
   test de integración que **las ejecuta**, para que no se pudran al cambiar una
   columna. La **pantalla** queda fechada en **E14** en `ESTADO.md`: el SQL es una
   salida, no un cierre.
9. **Plan FREE** (C-7): sin contraprestación **no hay operación sujeta** (art. 4.Uno
   LIVA) y **no se emite factura a cero** —ensucia la serie y no documenta nada—. No
   hay autoconsumo si el gratuito tiene finalidad comercial (*freemium*); sí lo
   habría si se concediera a vinculados, y entonces base = valor de mercado
   (art. 79.Cinco). *Parametrizable.*


### D9 ✚ · El SaaS es de USO INTERNO: `BILLING_PROVIDER=none` es el modo por defecto

**Aprobada por Pablo en chat el 2026-09-15**, tras aterrizar las tres olas. No
enmienda D1…D8: **las apaga**. D1…D8 describen el modo de pago y siguen vigentes
palabra por palabra el día que `BILLING_PROVIDER=stripe` se encienda.

> **La decisión, textual:** *el producto es de uso interno y no se cobra por
> ahora. Sin Stripe, sin facturas de plataforma, sin cobro. Toda organización
> nace con el plan `ILIMITADO`. `READ_ONLY` por impago NUNCA en modo interno.*

1. **`BILLING_PROVIDER=none` es el DEFECTO**, y es el defecto seguro: una
   instalación que se olvide de configurarlo **no cobra**, en vez de cobrar mal.
2. **Plan `ILIMITADO`**: una **fila más del catálogo** (no una constante de
   TypeScript — ése era el defecto que E11 vino a cerrar), con los **siete
   límites a `-1`**, `is_public = false` y sin `stripePriceId`. No es vendible y
   no aparece en el alta. Lo asigna **la propia alta** en la misma transacción
   que la organización y su membresía (`ensureSubscriptionForOrganization`): antes
   de D9 la fila la ponía sólo el backfill, así que toda organización creada
   después de la migración se quedaba sin suscripción y `getSubscriptionContext`
   la mandaba a `READ_ONLY` con un motivo que no era verdad.
3. **`accessLevelOf` devuelve `FULL` siempre** en este modo, cualquiera que sea
   el estado de la suscripción. *Donde no hay precio no puede haber mora, y
   `READ_ONLY` sería un castigo por una deuda que no existe.* Lo único que sigue
   produciendo `BLOCKED` es la desactivación que decide el propio ADMIN (D6).
4. **El administrador de plataforma puede cambiar el plan de una organización**,
   con `PlatformAuditLog` (`plan.changed`) y `AuditLog`. No es una comodidad: sin
   ella **los límites no se pueden ejercitar**, y un producto cuyos límites no se
   prueban es un producto cuyos límites no se saben. Quién lo es lo dice
   `PLATFORM_ADMIN_EMAILS`; vacía, en modo interno lo es el ADMIN de la
   organización (quien opera y quien administra son la misma persona) y en modo
   `stripe`, **nadie**: allí el plan se cambia donde está la tarjeta.
5. **Stripe queda como módulo apagado.** `/api/stripe/*` responde **404** —no 501
   ni 403: los dos confirmarían que la ruta existe—, **ninguna clave es
   necesaria** y la comprobación es de configuración, así que se resuelve antes
   de tocar el cliente, la sesión o la base de datos.
6. **No se emite ninguna factura de plataforma**, y es la respuesta correcta, no
   una omisión: sin contraprestación **no hay operación sujeta** (art. 4.Uno
   LIVA) y una factura a cero ensucia la serie sin documentar nada — que es
   exactamente lo que D8.9 ya decía del plan FREE.
7. **`/settings/subscription`** enseña «Modo interno: sin facturación», el plan y
   **el uso**. Sin portal, sin checkout y sin facturas. El uso se enseña igual:
   una instalación que no cobra no deja de tener derecho a saber cuánto consume.
8. **Migración aditiva M6** con el plan, el backfill (organizaciones sin
   suscripción, y las que M4 dejó en `FREE` **sin haber contratado nada**;
   ninguna con `stripe_subscription_id` se toca) y el baile
   `NO FORCE → backfill → FORCE`.

**Qué NO cambia.** Las dos clases de cuota de D7 siguen siendo las de D7: con los
límites a `-1`, `checkLimit` devuelve `ok` antes de mirar el uso y la cuota blanda
no avisa. El modo interno **no es un camino paralelo** en el guardián — es el
mismo guardián con otros números, que es lo que hace que asignar `STARTER` a una
organización sirva para probarlo.

---

## Lo que sale de este ADR (ronda 2)

- **La D5 de la ronda 1 — `BudgetCapexLine` en la forma canónica del
  `budgetHash`— desaparece.** Con el CAPEX fuera del alcance (§0.3 del diseño), la
  **enmienda a ADR-0018 D2** y el reversionado del fixture a v1.4 **se deciden en
  E12**, donde se implementan. **Este ADR ya no enmienda ningún otro.**
- **`/admin`** (lectura y escritura), el **export 303/349**, los **backups
  programados**, el **lector de `formatVersion 1.0`**, el **CSV dentro del ZIP**, la
  **restauración desde un ZIP ajeno por la UI** y **`email-sync` como job**: fuera,
  con motivo, en §0.3 del diseño.
- **Facturación por consumo, prorrateos y créditos**: el importe lo decide Stripe.
- **Ciclo comercial** (PDF al cliente, envío, cobro): **E14**. La fila de `ESTADO.md`
  que lo fechaba en E11 confundía dos numeraciones de `G-15`; el canónico de
  `AUDITORIA-FIABILIDAD.md` es **backups**, que sí cierra esta épica.
- **Plan de continuidad del operador**: el backup es una exportación del cliente, no
  el DR. Va al runbook.

---

## Alternativas descartadas

- **Contadores de uso incrementales**: cifra almacenada que diverge y que no baja al
  anular (P2/P4). La caché por hash es auditable; un contador no.
- **Bloquear el posteo al agotar cuota** (lo que decía la ronda 1): D7. Crea el
  impedimento que la norma no perdona y que el auditor imputa al sistema.
- **Verificar la restauración sólo con los tres hashes**: O-1. Dos asientos con los
  números intercambiados dan el mismo `ledgerHash`.
- **Que numere Stripe**: deja huecos y numera por cliente. Sólo cabría como
  expedición por tercero (art. 5 RD 1619/2012) con autorización previa, serie
  exclusiva y un control de huecos ejecutado — que es lo que I-E11-13 hace ya por
  nuestra cuenta.
- **Conservar nuestras facturas «en Stripe»**: un enlace no es una copia (C-5).
- **La demo dentro de la organización del cliente** (lo que decía la ronda 1): O-6.
  Exigiría marca por fila, exclusión en tres métricas y **un botón que borra asientos
  posteados**, que en este producto no puede existir.
- **Sembrar las series en el paso 4 del asistente** (ronda 1): O-7a. Quien abandona
  en el paso 3 hace **fallar I-E11-10 con datos limpios**, y un invariante que falla
  con datos limpios no distingue una manipulación.
- **Un bucket por organización**: crea infraestructura dentro de la transacción de
  alta.
- **Restaurar sobre la organización existente**: contradice el append-only y es el
  camino por el que el restore actual destruye datos.
- **Vender B2C en la UE**: obliga a OSS por un segmento residual (C-1).
- **Límites en JSON**: sin CHECK, sin tipo, rompe en silencio.
- **Ampliar `models/backups.ts` tabla a tabla**: multiplicar G-15 por 66.
- **Contabilizar la suscripción en el diario del cliente**: prohibido por I-E11-8, y
  desde O-8 también por el camino indirecto (`Transaction`/`ExtractionRun`/`File`).
  Nuestro ingreso no es su gasto contabilizado: su factura de proveedor entra por E8
  con su 472, su 62x y su cuadre.
- **Colas gestionadas (QStash, Inngest, SQS)**: un proveedor y un modo de fallo más a
  cambio de lo que `CronRun` + cursor resuelven.

---

## Consecuencias

**Positivas**

- El producto se puede contratar, operar y **abandonar** sin nosotros: el cliente se
  lleva sus datos en un archivo firmado que **se demuestra fiel** en seis
  comprobaciones, no en tres hashes.
- Se cierra **G-15**, el último gap MEDIA abierto junto a G-14, y con él las ocho
  deudas de plataforma.
- **D7 elimina la posibilidad de que el producto cree un incumplimiento contable a su
  cliente.** Es la consecuencia más importante de la ronda 2.
- **D8 nos aplica el mismo rigor que exigimos** (I-E11-13 ≡ I-E8-20).
- El motor contable pasa a **funcionar solo**, y **sin que el reloj toque una fecha
  contable** (D4.5).
- `aiBalance` y `storageLimit` dejan de ser cifras almacenadas y editables.
- **I-E11-7** y `derivedSealColumns()` hacen estructuralmente imposible el fallo que
  este proyecto ya ha cometido tres veces: la tabla —o el sello— nuevo que nadie
  añadió al inventario.

**Negativas / coste**

- **726 h y 28 tareas** (tras recortar 214 h y absorber 104 h de la validación). Sigue
  siendo la segunda épica más grande del proyecto.
- La **verificación ampliada de O-1** sube el techo de restauración de 25 a 30 min. No
  se recorta para ganar tiempo: era el bloqueante.
- Un **proveedor de almacenamiento nuevo** en la ruta crítica de la evidencia
  documental: si cae, I-E8-2 e I-E11-6 pasan a `INFO` en masa (y eso es correcto: no
  se miente con un PASS).
- Cuatro columnas de `Organization` quedan **deprecadas y vivas** hasta E12.
- `assertWithinLimit` entra en el camino caliente de siete acciones: techo de **25 ms
  y 2 consultas**, que hay que medir, no suponer.
- **La revalidación VIES en cada devengo** depende de un servicio intermitente; el
  fallback (repercutir 21 %) es conservador y puede exigir rectificativa posterior.

---

## Verificación

Este ADR se da por cumplido cuando:

1. **I-E11-1 … I-E11-13** están definidos en `.claude/skills/fiabilidad/SKILL.md`
   (familia `PLATAFORMA`), **se ejecutan** en el barrido de `/audit` y quedan en
   `invariant_runs`. *No basta con que existan: H-1 de E9 y H-1 de E10 fueron, las
   dos veces, invariantes escritos que nadie ejecutaba.*
2. Los **59 criterios** de §14 del diseño pasan, con los adversariales de T25 — en
   particular el **28** (dos `entryNumber` intercambiados con los tres hashes
   coincidentes) y el **49** (job con dos días de retraso, mismo `inputHash`).
3. Los **diez techos** de §12 están medidos, sin `.skip`, sobre volumen sembrado en
   el propio test.
4. El `auditor-fiabilidad`, en contexto limpio, **restaura el fixture
   `ejercicio-completo` desde un backup** y reconstruye a mano **las seis
   comprobaciones** y las ocho cifras de la matriz analítica (INGRESOS 6 250 000 ·
   MC1 5 670 000 · MC2 3 276 000 · MC3 3 084 110 · EBITDA 2 390 430 · EBIT 1 995 430
   · BAI 1 996 430 · RESULTADO 1 497 322) con **Δ = 0**, y comprueba que se detectan:
   un byte alterado en el ZIP, una numeración intercambiada, un `AuditLog` mermado,
   una tasa ausente, un `UsageRun` manipulado y un hueco en la serie de plataforma.
5. `docs/ESTADO.md` recoge **toda** la deuda que E11 deja abierta con épica de cierre
   —incluidas las 214 h de §0.3—, y quedan corregidas las dos erratas: **`G-15`
   duplicado** y **`G-20` sin fechar**.

---

## Firma

- [x] **Pablo** — **APROBADO el 2026-09-15**, **D1 … D8**, por permiso general
      delegado de 2026-09-04. **D9 APROBADA en chat el mismo día**, en la ronda
      de integración de las tres olas: el SaaS es de uso interno y no se cobra. **P-1 … P-8** resueltas y recogidas en §17 del diseño;
      **O-16** y **O-17** incorporadas en el cierre.
- [x] **`experto-contable`** — **OBSERVACIONES** (`E11-validacion-plataforma.md`):
      C-1…C-7 respondidas y **las quince observaciones incorporadas**. Su condición
      «precios en producción bloqueados hasta O-9, O-10, C-5 y B2B-only» queda
      cubierta por **D8** y **T18**; **B2B-only decidido en P-1**. Arranque del
      sprint **no bloqueado**: ninguna observación toca `lib/ledger`,
      `lib/analytics` ni `lib/closing`. **Pendiente: re-validación de la ronda 2.**
