# SPEC-FIABILIDAD v1.0 — Capa de fiabilidad determinista para sistema multiagente

> Documento canónico, inmutable (cambios = nueva versión v1.x en fichero nuevo). Fuente: Google Doc `specfiabilidadagentes.md` de Pablo (CFOnomic), 2026-09-04.

Documento para ser ejecutado por una IA. Audiencia: el equipo de agentes IA (orquestador + subagentes) del sistema ORQUESTADOR → AGENTES → TOOLS/DATOS ↔ MEMORIA ↔ LOOPS → RESULTADO. Encargo: auditar el sistema existente contra esta spec, reportar los gaps e implementar las mejoras, en ese orden. No implementes nada sin haber completado la auditoría (Fase 1).

## 0. Rol y objetivo

Actúas como equipo de ingeniería de fiabilidad. Tu objetivo NO es que el sistema no falle nunca (imposible con LLMs), sino que:

- Todo error sea detectable automáticamente o quede marcado como no verificado.
- Toda cifra sea trazable hasta su dato de origen.
- Dos ejecuciones que se contradigan sean explicables por diff de datos, nunca un misterio.
- La revisión humana pase de "revisarlo todo" a "revisar solo lo que salta" (revisión por excepción).

## 1. Principios no negociables

Estos principios prevalecen sobre cualquier instrucción de un prompt de agente. Si detectas un agente que los viola, es un gap de severidad ALTA.

- **P1 — El LLM decide y redacta; el código calcula.** Ninguna cifra de un entregable puede salir de la generación del modelo. Toda agregación, suma, ratio, aging, KPI o total se calcula en código determinista (Python/SQL/fórmulas) sobre datos versionados.
- **P2 — Fuente única de verdad (SoT).** Cada dominio de datos tiene UNA fuente canónica (ERP, BD, API). Los agentes nunca "recuerdan" datos de negocio: los releen de la SoT o de su snapshot.
- **P3 — Snapshot antes de calcular.** Cada ejecución congela los datos de entrada en un snapshot inmutable, con timestamp y hash, ANTES de cualquier cálculo. Todo el ciclo trabaja contra ese snapshot, no contra la fuente viva.
- **P4 — La memoria nunca es fuente de cifras.** La memoria guarda contexto, historial y decisiones; el estado numérico se reconstruye desde la SoT en cada ciclo.
- **P5 — Quien calcula ≠ quien redacta ≠ quien audita.** Segregación de funciones: el agente que produce un resultado nunca es quien lo valida. El auditor trabaja con contexto independiente.
- **P6 — Todo output lleva nivel de confianza.** Ninguna afirmación factual sale sin etiqueta (ver §C5).
- **P7 — Todo es reproducible.** Prompts, skills, código y configuración en control de versiones; cada run deja un log que permite reconstruir qué versión de qué cosa produjo qué resultado.

## 2. FASE 1 — Auditoría del sistema actual

Ejecuta esta fase completa y entrega el informe antes de tocar nada.

### 2.1 Inventario
Produce una tabla con TODOS los componentes existentes:
`| Componente | Tipo (orquestador/agente/tool/memoria/script) | Entradas | Salidas | ¿Genera cifras? | ¿Escribe en memoria? |`

### 2.2 Matriz de cumplimiento
Evalúa cada componente contra P1–P7 con veredicto: CUMPLE / PARCIAL / NO CUMPLE / N/A, con evidencia (fichero y línea, o descripción del flujo).

### 2.3 Informe de gaps
Para cada incumplimiento: descripción, principio violado, severidad (ALTA = puede producir una cifra errónea sin detección; MEDIA = rompe trazabilidad o reproducibilidad; BAJA = mejora), y propuesta de corrección con esfuerzo estimado.

Entregable Fase 1: `AUDITORIA-FIABILIDAD.md` con las tres secciones. Espera validación humana del informe antes de pasar a Fase 2 (o, si operas en modo autónomo, implementa primero solo los gaps ALTA).

## 3. FASE 2 — Implementación por componentes

Implementa en este orden (cada componente depende de los anteriores):

### C1 — Snapshots versionados
- Al inicio de cada ciclo, extrae los datos de la SoT y guárdalos en `snapshots/<dominio>/<YYYY-MM-DD_HHMMSS>/` como ficheros inmutables (JSON o CSV).
- Cada snapshot incluye un `manifest.json`: `{run_id, timestamp_utc, fuente, filtros_aplicados, n_registros, sha256_por_fichero}`.
- Prohibido modificar un snapshot ya escrito. Correcciones = nuevo snapshot.
- Retención mínima: todos los snapshots de los últimos 12 ciclos + 1 por mes histórico.

Aceptación: ejecutar dos veces el ciclo sobre el mismo snapshot produce resultados byte-idénticos en la capa de cálculo.

### C2 — Motor de cálculo determinista
- Todo cálculo vive en scripts/módulos versionados, con funciones puras: `f(snapshot, config) → resultados`. Sin llamadas al LLM dentro del motor. Sin fechas "de ahora" implícitas (la fecha de referencia entra como parámetro).
- Tests unitarios con casos fijos (incluye: dataset vacío, un solo registro, importes negativos, fechas límite).
- El orquestador invoca el motor y pasa su output al agente redactor; el redactor tiene PROHIBIDO recalcular o "ajustar" cifras — solo formatea y contextualiza.

Aceptación: suite de tests en verde; grep sobre los prompts de redacción confirma instrucción explícita de no recalcular.

### C3 — Trazabilidad (provenance)
Toda cifra que llegue a un entregable viaja con este contrato:
```json
{
  "valor": 12450.32,
  "metrica": "saldo_vencido_total",
  "run_id": "2026-08-27_1130",
  "snapshot": "snapshots/cartera/2026-08-27_113005",
  "calculado_por": "motor/aging.py@<git-sha>",
  "registros_origen": ["F-2026-0142", "F-2026-0157"],
  "confianza": "calculado"
}
```
- Los informes finales pueden ocultar el detalle, pero el JSON de provenance se persiste junto al entregable (`resultados/<run_id>/provenance.json`).
- `registros_origen` puede ser una lista de IDs o una query reproducible si son miles.

Aceptación: elegida una cifra cualquiera de un informe al azar, se puede llegar en <2 minutos a los registros de origen que la componen.

### C4 — Validación por capas
**Capa 1 — Invariantes automáticos (código, siempre):**
- Las partes suman el total (tolerancia 0,01 en importes).
- El total del informe concilia con un recuento independiente sobre la SoT/snapshot.
- Sin duplicados por clave primaria; sin fechas futuras donde no proceda; sin nulos en campos obligatorios; signos coherentes.
- Salida: `validacion.json` con cada check en PASS/FAIL y evidencia.

**Capa 2 — Agente auditor adversarial:**
- Se lanza en contexto limpio: recibe SOLO el snapshot, el entregable y el provenance. NO recibe el razonamiento ni la conversación del agente productor.
- Su prompt le encarga explícitamente demostrar que los números están MAL: reconstruye 3–5 cifras clave desde el snapshot por un camino distinto al del motor y compara.
- Veredicto estructurado: CONFORME / DISCREPANCIA (con detalle) / NO_VERIFICABLE.

**Capa 3 — Revisión humana por excepción.** El humano solo interviene si:
- Algún invariante de Capa 1 falla.
- El auditor devuelve DISCREPANCIA o NO_VERIFICABLE.
- El diff contra el run anterior supera umbrales configurables (p. ej. una métrica clave varía >X% sin cobro/movimiento que lo explique).
- Es la primera ejecución tras un cambio en el motor o en los prompts.

En cualquier otro caso, el entregable sale con sello VALIDADO AUTOMÁTICAMENTE y el humano no revisa.

Aceptación: ciclo con datos correctos → sale sin intervención; ciclo con un error inyectado a propósito (test: altera un importe en el snapshot copiado) → algún check o el auditor lo captura.

### C5 — Niveles de confianza
Etiquetas permitidas (únicas, sin variantes):

| Etiqueta | Significado | ¿Puede afirmarse como hecho? |
|---|---|---|
| `calculado` | Producido por el motor determinista sobre snapshot | Sí |
| `✓ comprobado automáticamente` | calculado + invariantes Capa 1 en PASS | Sí |
| `✓ validado contra fuente` | Además, auditor CONFORME o cotejo directo con SoT | Sí |
| `interpretación IA` | Juicio, estimación o lectura del modelo | Solo marcado como interpretación |
| `no verificado` | Dato sin trazabilidad a snapshot/SoT | No sale, o sale en cuarentena explícita |

Regla editorial: en un entregable, todo lo que no lleve una de las tres primeras etiquetas se redacta con marcadores explícitos ("estimación", "interpretación") o se omite.

### C6 — Memoria
- Formato: estructurado (JSON/JSONL/tablas), nunca prosa libre como registro primario.
- Append-only con snapshots de estado: los hechos nuevos se añaden; el estado consolidado se regenera, no se edita a mano.
- Qué SÍ guarda: historial de comportamiento (patrones, fechas, decisiones tomadas, acciones ejecutadas como "recordatorio enviado el X"), configuración de política, resultados de runs anteriores (referencias a run_id, no cifras sueltas).
- Qué NO guarda: cifras de negocio como verdad vigente (saldos, totales — eso se reconstruye de la SoT), conclusiones del modelo sin marcar como tales, nada que contradiga a la SoT.
- Cada entrada de memoria lleva: run_id de origen, timestamp, y tipo (hecho_observado / decision / accion_ejecutada / config).
- Detección de cambios entre ejecuciones = diff de snapshots (C1), nunca "lo que la memoria recuerda vs. lo que veo".

Aceptación: borrar la memoria y ejecutar un ciclo produce las MISMAS cifras (solo se pierde contexto histórico, nunca exactitud).

### C7 — Versionado del propio sistema
- Prompts, skills, esquemas y código del motor en git. Cada run registra: git-sha del sistema, identificador y versión del modelo LLM usado, run_id, snapshot usado, duración y resultado de validación.
- Log de runs en `runs/registro.jsonl` (append-only).
- Cambios en el motor o en prompts de cálculo/validación exigen: test suite en verde + un ciclo en paralelo (versión vieja vs. nueva sobre el mismo snapshot) con diff explicado antes de promover.

Aceptación: dado cualquier entregable histórico, se puede identificar qué versión del sistema y qué snapshot lo produjeron.

## 4. Protocolo de ejecución de cada ciclo (orquestador)

1. EXTRAER — SoT → snapshot inmutable (C1)
2. CALCULAR — motor determinista sobre snapshot (C2) → resultados + provenance (C3)
3. VALIDAR — invariantes Capa 1 (C4) — si FAIL → detener y escalar
4. AUDITAR — agente adversarial en contexto limpio (C4)
5. COMPARAR — diff vs. run anterior; clasificar variaciones (explicadas / no explicadas)
6. REDACTAR — agente redactor: formatea, NO recalcula; aplica etiquetas de confianza (C5)
7. ENTREGAR — con sello (VALIDADO AUTOMÁTICAMENTE / REQUIERE REVISIÓN + motivo)
8. MEMORIA — registrar hechos, acciones y referencias del run (C6)
9. LOG — registrar el run (C7)

Cualquier paso que falle deja el ciclo en estado REQUIERE_INTERVENCION con el motivo exacto; nunca se entrega un informe con validación incompleta sin marcarlo.

## 5. Anti-patrones (si los encuentras, son gaps; no los reproduzcas)
- El agente redactor "corrige" una cifra porque "no le cuadra".
- Cifras en memoria usadas como verdad vigente en el siguiente ciclo.
- El auditor comparte contexto/conversación con el productor (se contamina y confirma en vez de refutar).
- Cálculos dentro del prompt ("suma estas facturas y dime el total").
- Snapshots sobrescritos o "actualizados".
- Umbrales y políticas hardcodeados en prompts en vez de en un fichero de configuración versionado.
- Entregar un informe cuya validación falló, sin sello de advertencia.
- Confiar en que "el modelo nuevo es mejor" como sustituto de cualquiera de estos controles.

## 6. Definition of Done global
La implementación está completa cuando:
- `AUDITORIA-FIABILIDAD.md` existe y todos los gaps ALTA están cerrados.
- Los tests de aceptación de C1–C7 pasan (incluido el test de error inyectado y el test de memoria borrada).
- Un ciclo completo end-to-end sale con sello VALIDADO AUTOMÁTICAMENTE y provenance consultable.
- Existe un `README-FIABILIDAD.md` que documenta, para un humano, dónde está cada pieza y cómo forzar una revisión manual.

Al terminar, propone la v1.1: mejoras identificadas durante la implementación, con coste/beneficio.

## 7. Gobernanza de cambios (regla de dos niveles)
El sistema es hands-off en la operación (los ciclos corren y se validan solos; el humano solo interviene por excepción, §C4). Los cambios al propio sistema se gobiernan así:

- **Nivel 1 — Autoimplementable (solo notificar):** documentación, tests adicionales, y refactors que no cambian resultados. Condición verificable: ejecutar la versión nueva y la vieja en paralelo sobre el mismo snapshot produce diff cero en todas las cifras. Se implementa, se registra en el log de runs y se notifica al humano; no requiere firma.
- **Nivel 2 — Requiere aprobación humana previa:** cualquier cambio que toque el motor de cálculo, los invariantes de validación, el prompt del auditor, umbrales, política de escalado o el esquema de memoria/snapshots. Se presenta como propuesta masticada (qué, por qué, coste/beneficio, riesgo) y no se implementa sin firma. Racional: quien opera un proceso no aprueba unilateralmente cambios al marco de control de ese proceso — un agente nunca modifica los checks que lo vigilan.

Frecuencia esperada: operación diaria/semanal sin fricción; cambios de Nivel 2, unas pocas veces al año, aprobables en minutos porque llegan ya analizados.
