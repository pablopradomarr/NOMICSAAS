---
name: ui-erp
description: Guía de interfaz del ERP - estructura de navegación, tablas financieras, formato de importes, badges de confianza, sello de validación, drill-down y estilo visual (base shadcn de TaxHacker con identidad CFOnomic sobria). Úsala al crear o modificar cualquier pantalla.
---

# UI del ERP

## Navegación (sidebar, `components/sidebar`)
Documentos (Bandeja · Operaciones · Facturas emitidas) · Contabilidad (Libro diario · Mayor · Sumas y saldos) · Informes (Balance · PyG · PyG analítica · Cashflow · Presupuesto vs real) · Analítica (Proyectos · Centros de coste · Líneas de negocio · Liquidaciones) · Auditoría · Configuración (Plan de cuentas · Ejercicios · Impuestos · Usuarios · LLM · Backups). Switcher de organización arriba.

## Tablas financieras (`components/reports/report-table.tsx`)
- Jerárquica y colapsable: epígrafe → cuenta → asiento → documento. Click en cifra = drill-down (ejecuta `registros_origen` de la provenance).
- Importes alineados a la derecha, fuente tabular (`font-variant-numeric: tabular-nums`), formato `es-ES`: `1.234.567,89 €`; negativos con signo `−` y color texto secundario, nunca rojo semáforo (marca CFOnomic). Ceros como `—`.
- Columnas de comparación: periodo, periodo anterior, Δ, Δ%, presupuesto. Porcentajes de margen con 1 decimal.
- Fila de cuadre fija al pie (p. ej. `Activo − Pasivo − PN = 0,00 €`) con estado ✓/⚠.
- Cabecera de informe: periodo, moneda base, sello `VALIDADO AUTOMÁTICAMENTE` (chip negro/lima) o `REQUIERE REVISIÓN` (chip ⚠ #F5A623 + motivo), `run_id` y `ledgerHash` abreviado en JetBrains Mono, botón "Exportar" (CSV/XLSX/PDF).

## Badges de confianza (`components/ui/confidence-badge.tsx`)
`calculado` (gris) · `✓ comprobado automáticamente` (negro) · `✓ validado contra fuente` (negro con punto lima) · `interpretación IA` (hielo #EDF2F7, cursiva) · `no verificado` (borde discontinuo). Toda cifra que no venga del diario lleva uno de los dos últimos.

**Camino documental (E8).** En `/unsorted/[fileId]` el badge es **por campo**, no por pantalla, y son **cuatro** niveles sellados en `ExtractionRun.fieldOrigins` (`data-field-confidence` en el DOM): `calculado` · **`verificado`** · `interpretacion_ia` · `no_verificado`. `verificado` es el que faltaba y no es decorativo: marca lo que puso una persona o el maestro (contraparte, fecha de recepción, ticket cualificado). Cada campo lleva además su **chip de origen** (`llm` / `usuario` / `catalogo` / `calculado`) y el check que lo justifica. Confirmar con algún campo `no_verificado` abre el diálogo de motivo — y el **servidor lo exige igualmente**: un control de auditoría que sólo vive en el navegador no es un control.

## Formularios
- Asiento: tabla editable Debe/Haber con autocompletado de cuenta (código + nombre), destino analítico obligatorio en 6/7, totales en vivo marcados como "vista previa" y validación servidor al guardar. Diferencia Σdebe−Σhaber visible siempre.
- Propuesta OCR (`/unsorted/[fileId]`, E8): panel izquierdo el **documento** con su `sha256` a la vista y el contador «páginas analizadas de N» —el último eslabón de la cadena `journal_lines → extraction_runs → files → bytes`—; si la ficha existe y los bytes no, el visor pinta **«documento no disponible»** (la ruta devuelve 410, no un 404 mudo) en vez de un hueco. A la derecha: propuesta con los cuatro badges, **las cuatro fechas** explicadas (expedición · operación · recepción · devengo) con el periodo de IVA que sale de `max(recepción, expedición)`, el panel de las **25 comprobaciones** RC-01…RC-25 con su marca de bloqueo de lote, y el **asiento propuesto** con sus líneas, sus bloques de pasivo, el cuadre a `0,00 €` visible y la anotación del libro registro. "Confirmar" deshabilitado si `reconcile()` da FAIL, con el motivo; editar no toca el run: crea una revisión.
- Bandeja (`/unsorted`): tabla densa con el estado del último run, contadores agregados, filtros por estado enlazables y paginación con el rango a la vista («Documentos 1–100 de 412»); nunca trunca en silencio. Confirmación por lote en `/unsorted/batch`, con los **no elegibles y su porqué**.
- Plan de cuentas: árbol con búsqueda, edición inline de nombre, alta de subcuenta bajo un padre, desactivar; columna estado financiero / epígrafe / tipo analítico editable por admin.

## Estilo
- Base: shadcn/Tailwind de TaxHacker, tema claro por defecto. Paleta CFOnomic: fondo `#FFFFFF`, texto `#1A202C`, secundario `#737373`, superficies `#F7F7F7` / `#EDF2F7`, bloques oscuros `#0A0A0A`, acento lima `#EAFF69` (solo highlights: punto del logo, chip validado, foco), aviso `#F5A623`. No introducir rojo/verde semáforo ni azul corporativo.
- Tipografía: Open Sans (UI), JetBrains Mono (códigos de cuenta, hashes, run_id), League Spartan (títulos de sección). Cargar vía `next/font/google`.
- Densidad alta: filas de 32px en tablas, sin cards decorativas, sin ilustraciones.
- Roles: `VIEWER` no ve botones de mutación; todo botón destructivo exige motivo (dialog) y queda en `AuditLog`.
- Español: "Debe / Haber", "Pérdidas y ganancias", "Balance de situación", "Libro diario", "Centro de coste", "Línea de negocio", "Ejercicio", "Asiento nº".
