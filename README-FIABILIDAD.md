# Fiabilidad de MICRO ERP SAAS — qué garantiza y cómo comprobarlo

> Escrito en el cierre de **E7** (T22), adelantando el entregable de E12. E12 lo
> completará con los tests de aceptación C1–C7 de extremo a extremo. La spec que
> prevalece sobre todo lo demás es `docs/spec/SPEC-FIABILIDAD.md`; la traducción
> operativa —y la **definición única** de los invariantes— vive en
> `.claude/skills/fiabilidad/SKILL.md`.

Un ERP contable no vale por lo que calcula, sino por lo que puede **demostrar**.
Este documento dice, sin adornos, qué afirma el sistema, con qué fuerza lo
afirma, y cómo comprobarlo uno mismo.

---

## 1. Las cinco promesas

1. **El código calcula; el modelo sólo lee y redacta.** Ninguna cifra contable
   sale de un LLM. Un documento produce una *propuesta* (`ExtractionRun`), la
   propuesta pasa por una validación determinista (`reconcile()`, RC-01…RC-25) y
   sólo entonces el motor construye el asiento. Si la propuesta no reconcilia, no
   hay asiento: no hay «aproximadamente».
2. **Partida doble en la base, no en la aplicación.** Σdebe = Σhaber con
   tolerancia 0, comprobado por un *constraint trigger* diferido al COMMIT. Un
   asiento descuadrado **no se puede persistir** aunque alguien escriba por SQL.
3. **Los informes son vistas del diario.** Balance, PyG, PyG analítica, cashflow
   y las cuatro cifras del sello se derivan del libro diario en el momento de
   emitirse. No hay cifras «de informe» almacenadas que puedan divergir del
   diario que las sostiene.
4. **Nada se borra.** Un asiento se anula con contra-asiento; un extracto
   importado, un `ExtractionRun`, un `InvariantRun` y un `AuditLog` son
   *append-only* **en la base** (`REVOKE UPDATE, DELETE` + políticas
   `RESTRICTIVE`), no por convención.
5. **Toda cifra dice cuánto se ha comprobado.** Ninguna pantalla enseña un número
   sin su nivel de confianza. Y el nivel se **deriva en lectura**: nunca se
   almacena, porque un dato que llega mañana tiene que poder retirar un sello
   concedido ayer.

---

## 2. Los invariantes, por familia

Un invariante es una igualdad que el sistema comprueba sobre **datos reales**, no
sobre un fixture. Todos comparten un contrato: **nunca un PASS que no se haya
comprobado**. Lo que no se puede evaluar con los datos disponibles sale `INFO`
diciendo qué falta — jamás en verde.

| Familia | Invariantes | Qué garantizan |
|---|---|---|
| **Partida doble y estados** | `I1`–`I3`, `I6`, `I-E7-17` | Σdebe = Σhaber por asiento **y mes a mes** (art. 28.1 CCom); `Activo = Pasivo + PN`; la PyG del periodo tiene una sola definición y coincide con el saldo de 129 si el ejercicio está regularizado; el cashflow cuadra con Δ57x |
| **Analítica y liquidación** | `I4`, `I5`, `I-E7-9`, `I-E7-10` | La matriz analítica suma exactamente la PyG contable, por nivel de margen; el reparto de CECOs es Hamilton con tolerancia 0 y desempate determinista; una `allocation_lines` alterada bajo un informe vigente **se delata** |
| **Camino documental** | `I-E8-1`…`I-E8-20` | El asiento se apoya en un run que lo sostiene; los bytes del documento son los que vio la extracción **y los de hoy**; el libro registro de IVA cuadra con el diario por los **tres puentes al 303**; la divisa se convierte con residuo cero; las series de facturación no tienen huecos |
| **Conciliación bancaria** | `I-E7-1`…`I-E7-6b`, `I-E7-11`…`I-E7-13` | `E − B = Ue − Ub` con los pendientes enumerados y tipados; el grupo N-a-M cuadra en la **moneda de la cuenta**; la cadena de extractos cubre el periodo sin huecos; los ignorados están acotados y son visibles |
| **Cierre de ejercicio** | `I-E7-14`…`I-E7-16` | La apertura de N cuadra cuenta a cuenta con el cierre de N−1 (art. 25 CCom); no hay saldos contrarios a su naturaleza sin explicación; las cuentas puente (`555`, `551`, `4749`) están a cero al cierre |
| **Integridad del propio control** | `I-E7-7`, `I-E7-8`, `I7`–`I10` | El barrido no se puede editar sin que se note (`checksHash` recomputado); todo fichero del almacén tiene veredicto; no hay duplicados, ni fechas fuera de ejercicio abierto, ni una sola fila que cruce de organización |

La lista completa, con su tolerancia y su redacción exacta, está en
`.claude/skills/fiabilidad/SKILL.md`. **Se define ahí una sola vez**: el código
la implementa, no la reinventa.

---

## 3. Los sellos: qué significa cada palabra

### El sello del periodo

| Sello | Cuándo |
|---|---|
| `VALIDADO AUTOMÁTICAMENTE` | Todos los invariantes en PASS, sin revisión forzada, sin avisos por encima del umbral y **sin ningún motivo de sello** |
| `REQUIERE REVISIÓN` | Cualquier FAIL, el primer barrido tras cambiar el motor, avisos por encima del umbral, revisión forzada por un ADMIN, o cualquiera de los motivos de abajo |

Un motivo de sello es un **código cerrado**, no una frase: se filtra, se cuenta y
se compara entre periodos. E8 aporta seis (documento alterado, tasa forzada,
retención no practicada…) y E7 cuatro: `CONCILIACION_PENDIENTE`,
`PARTIDA_EN_TRANSITO_ANTIGUA`, `DIFERENCIA_DE_CAMBIO_SIN_RECONOCER` y
`ALMACEN_NO_BARRIDO`.

> **Todos mueven el sello.** Un aviso que no lo mueve es decorativo: firmar
> «validado automáticamente» un periodo con la conciliación abierta es
> exactamente lo que el sello existe para impedir. Lo que estos cuatro **no**
> hacen es cambiar una cifra: por eso su naturaleza es `AVISO`/`ENTORNO` y no
> `INVARIANTE`.

### El nivel de confianza de una cifra

| Nivel | Qué afirma |
|---|---|
| `calculado` | Se deriva del diario. Nadie ha comprobado nada más |
| `✓ comprobado automáticamente` | Los invariantes que la sostienen están en PASS |
| `✓ validado contra fuente` | Además, **cuadra contra una fuente externa**: el extracto del banco |

`✓ validado contra fuente` se concede **por composición**, y esto tiene
consecuencias que no se negocian:

- El epígrafe *Tesorería* agrega todas las 57x, **caja incluida**, y la caja no
  tiene extracto ni puede tenerlo: una organización con caja **no verá nunca**
  ese badge en la tesorería total del balance. Lo verá en el detalle por cuenta
  bancaria. Un arqueo firmado no es fuente equivalente.
- **Enumerar un pendiente no lo explica.** Un pendiente está explicado si lo
  recoge una conciliación posterior ya hecha, o si está **tipado** por una
  persona y aún no ha superado el plazo declarado de la cuenta. Cualquier otro
  retira el badge.
- Una cuenta **en divisa** con diferencia de cambio sin reconocer tampoco lo
  lleva: está validada en su divisa, pero el balance enseña su contravalor en
  euros, y ése no lo está.

### Provenance por celda

Cada cifra de informe viaja con su origen: métrica, `run_id`, `ledgerHash`,
módulo y git-sha que la calculó, y **la consulta que la reproduce**. El
drill-down de la interfaz es ejecutar esa consulta. De una celda al documento que
la origina hay tres clics.

---

## 4. Qué NO garantiza el sistema

Decirlo importa tanto como lo anterior:

- **No sustituye a un auditor ni a un asesor fiscal.** Comprueba coherencia
  interna y cuadre contra fuente; no opina sobre la calificación de un hecho
  económico.
- **No adivina lo que no está.** Sin extracto no hay conciliación; sin tasa
  publicada no hay conversión (no se aproxima: se aborta); sin anclaje de una
  cuenta bancaria el cuadre sale `INFO`, no PASS.
- **No puntea solo.** Las sugerencias de conciliación son deterministas, se
  recomputan en cada carga y **una persona las acepta**. No hay `AUTO`.
- **No reconoce la diferencia de cambio**: E7 la **mide** y avisa (I-E7-12,
  NRV 11ª.2.2); el asiento de `768`/`668` que la recoge es de **E9**.
- **No decide la deducibilidad del IVA** ni contabiliza automáticamente regímenes
  especiales (RECC/REDEME): los bloquea y lo dice.

---

## 5. Cómo auditarlo uno mismo

**Desde la interfaz** (`/audit`):

1. **Ejecutar barrido**. Sale el sello con sus motivos, los cinco hashes
   (`ledgerHash`, `analyticsKey`, `planHash`, `accountMapHash`, `configHash`) y
   las cuatro cifras firmadas: activo, PN + pasivo, resultado y tesorería.
2. **Abrir una familia → un check → sus registros de origen.** Tres clics hasta
   el asiento, y uno más hasta el documento.
3. **Prueba de detección.** Altera un céntimo *en una copia en memoria* y enseña
   qué invariantes lo cazan. **No escribe en el diario**: el `ledgerHash` antes y
   después es idéntico, y la ejecución queda en el `AuditLog`.
4. **Comparar dos barridos.** El diff dice qué cambió y **por qué**: `DATOS`,
   `MOTOR` o `CONFIGURACION`, según qué hash se movió. Dos ejecuciones que se
   contradigan tienen siempre explicación; nunca un misterio.

**Desde la línea de órdenes**, sin pasar por la aplicación:

```bash
DATABASE_URL_MAINTENANCE=… npx tsx scripts/run-invariants.ts --org <id>   # → validacion.json
npm run test              # motor puro: invariantes y fixtures congelados
npm run test:integration  # contra Postgres de verdad, con RLS activa
npm run test:integration:rls
```

**Reconstruyendo por fuera.** Es lo que hace el agente `auditor-fiabilidad` en
contexto limpio y es la prueba más fuerte que hay: recalcular las cifras con SQL
crudo y aritmética independiente, **sin usar el motor**, y comparar. Los fixtures
(`tests/fixtures/ejercicio-completo.json`) traen sus cifras esperadas y el
`ledgerHash` congelado; si el motor cambiara una coma, el hash lo diría.

---

## 6. Segregación de funciones

Quien implementa ≠ quien revisa ≠ quien audita. El `auditor-fiabilidad` se lanza
**en contexto limpio**, reconstruye por camino independiente y emite CONFORME o
DISCREPANCIA. No es ceremonia: en E7 encontró siete hallazgos —tres de severidad
ALTA— que las pruebas propias del código no vieron, entre ellos dos tests que
*pasaban* con datos que el sistema no puede producir. Un test que se escribe a la
medida del código que prueba no prueba nada, y ésa es la razón de ser de la
tercera firma.

Todo run —implementación, revisión, auditoría— queda en `runs/registro.jsonl` con
su git-sha, sus tests, su deuda y su sello.
