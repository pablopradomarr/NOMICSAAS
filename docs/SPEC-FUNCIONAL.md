# SPEC-FUNCIONAL v1.0 — MICRO ERP SAAS

Producto: SaaS de contabilidad, caja y control de gestión para **empresas de proyectos/servicios** (PYMEs españolas, 1–100 M€), construido sobre el fork de TaxHacker. Cliente tipo: la empresa y su CFO fraccional (CFOnomic) trabajando sobre la misma organización con roles distintos.

## 1. Requisitos (origen: Pablo, 2026-09-04) → módulos

| # | Requisito literal | Módulo | Épica |
|---|---|---|---|
| R1 | Todas las funcionalidades de TaxHacker (OCR/LLM de documentos, multi-moneda, campos custom, prompts custom, import/export, email-sync, facturas, backups, self-hosted) | Documentos / Operaciones | E0, E1, E8 |
| R2 | Cuentas contables con el NPGC cargado, configurables: crear y renombrar | Plan de cuentas | E2 |
| R3 | Proyectos directos con ingresos y gastos directos y MC1, MC2, MC3 | Analítica | E4 |
| R4 | CECOs: Marketing&Ventas, Operaciones indirectos, G&A, Desarrollo de productos, Financieros, Otros extraordinarios | Analítica | E4 |
| R5 | Líneas de negocio que agrupan proyectos | Analítica | E4 |
| R6 | Liquidar CECOs a proyectos y líneas de negocio por regla de imputación propia | Liquidaciones | E5 |
| R7 | PyG analítica, cashflow, balance, libro diario, todo cuadrado | Informes | E3, E6 |
| R8 | Pestaña de auditoría | Auditoría | E7 |
| R9 | Usuarios con rol visualizador o editor | Organizaciones y roles | E1 |
| R10 | Multi-empresa (varias organizaciones por usuario) | Organizaciones | E1 |
| R11 | BD Supabase Postgres | Infra | E1 |

## 2. Flujo principal (documento → asiento → informe)

```
Documento (subida / email / factura emitida / CSV / manual)
   → File (sha256) → ExtractionRun (LLM: propuesta JSON, modelo, prompt-hash)     [interpretación IA]
   → reconcile() determinista: Σitems = base, base + impuestos = total, cuentas válidas, destino analítico
   → Propuesta de asiento (Debe/Haber, proyecto/CECO) en pantalla → usuario EDITOR confirma
   → post(): Σdebe = Σhaber, ejercicio abierto, numeración → JournalEntry + JournalLine    [calculado]
   → Informes derivados del diario + invariantes I1–I10                                    [✓ comprobado automáticamente]
   → Auditoría (checks + conciliación bancaria + agente auditor)                           [✓ validado contra fuente]
```
Modo "sin contabilidad": una organización puede usar el ERP como TaxHacker (solo operaciones) con `ledgerEnabled=false`; al activarlo se generan asientos retroactivos propuestos por lote.

## 3. Módulos y funcionalidades

### 3.1 Documentos y operaciones (heredado + mejorado)
- Bandeja "Sin procesar": subida múltiple, email IMAP, análisis IA con cola y progreso; split de items en documentos.
- Operación (`Transaction`): datos extraídos + campos custom + categoría + proyecto; adjuntos; búsqueda full-text; filtros; bulk; export CSV/ZIP.
- Facturas emitidas: generador PDF con series de numeración por organización; al emitir genera asiento (430/705/477, IRPF).
- Multi-moneda: tasa histórica por fecha persistida (`ExchangeRate`, fuente y timestamp); conversión en servidor a moneda base de la organización.
- Prompts de extracción editables por organización, versionados (histórico).
- Toda propuesta IA marcada `interpretación IA` hasta confirmación humana; extracciones parciales (documentos > N páginas) marcadas.

### 3.2 Plan de cuentas (R2)
- Alta de organización carga NPGC (variante GENERAL o PYMES) desde `seeds/npgc.csv`.
- Árbol editable: crear subcuentas (4–12 dígitos), renombrar cualquier cuenta, desactivar, cambiar epígrafe/tipo analítico (admin). Borrar solo sin movimientos.
- Cuentas de sistema mapeadas (IVA soportado/repercutido, IRPF, clientes, proveedores, bancos, resultado) — configurables, no hardcodeadas.
- Impuestos (`TaxRate`): IVA 21/10/4/0, exento, IRPF 15/7/19, recargo; con cuenta asociada y vigencia.
- Importación de plan propio por CSV (mapeando a estado financiero/epígrafe).

### 3.3 Contabilidad financiera (R7)
- Ejercicios fiscales (apertura/cierre, periodos bloqueables por mes).
- Libro diario: asientos numerados sin huecos, líneas Debe/Haber en céntimos, concepto, documento origen, proyecto/CECO, usuario, timestamp. Anulación por contra-asiento; nada se borra.
- Asientos manuales, plantillas (asientos tipo), asientos recurrentes (amortización, periodificación), regularización de IVA, cierre y apertura.
- Libro mayor, balance de sumas y saldos.
- Conciliación bancaria: importación de extractos (CSV/Norma 43) y punteo contra 57x; diferencias a Auditoría.

### 3.4 Analítica (R3, R4, R5, R6)
- Líneas de negocio → Proyectos (directos) → líneas de asiento. CECOs con tipos por defecto (M&V, Operaciones indirectas, G&A, Desarrollo de producto, Financieros, Otros/extraordinarios) editables.
- Tipo analítico por cuenta (default del seed) y override por línea. Niveles de margen configurables (MC1/MC2/MC3/EBITDA/EBIT/BAI/Resultado).
- Reglas de imputación versionadas con drivers (% fijo, ingresos, coste directo, horas, headcount, partes iguales, manual); liquidación por periodo, reversible, en cascada sin ciclos; invariante Σ imputado = saldo CECO.
- Presupuestos por proyecto/CECO/mes; registro de horas opcional (driver y coste de personal).
- Cierre de proyecto y rentabilidad acumulada vida-proyecto.

### 3.5 Informes (R7)
Balance de situación · PyG contable (modelo normal/PYMES) · PyG analítica (proyecto × nivel de margen, agregada por LN, CECOs no imputados) · Cashflow directo (por 57x) e indirecto · Presupuesto vs real · Dashboard (KPIs derivados del diario). Todos: periodo y comparativo, drill-down hasta documento, fila de cuadre, sello de validación, export CSV/XLSX/PDF, provenance descargable.

### 3.6 Auditoría (R8)
Pestaña con invariantes I1–I10, checks de calidad de datos (propuestas IA sin confirmar, documentos sin asiento, líneas 6/7 sin destino, aging 430/400, diferencias de conciliación), `AuditLog` de cambios de configuración y de asientos, runs de informes con su sello, y botón "Forzar revisión manual" que marca el periodo como `REQUIERE REVISIÓN`.

### 3.7 Organizaciones, usuarios y roles (R9, R10)
Organización (empresa) con moneda base, zona horaria, variante PGC, plan. Usuario puede pertenecer a varias; switcher. Roles `ADMIN / EDITOR / VIEWER` (matriz en skill `supabase-multitenant`). Invitación por email; log de accesos.

### 3.8 Plataforma
Supabase Postgres con RLS; Docker self-hosted opcional; backups por organización; Stripe (cloud); API interna vía server actions; export completo de datos.

## 4. Fuera de alcance v1
Nóminas (se contabilizan, no se calculan) · Modelos AEAT (303/390/111/200) más allá de exportar datos · Activos fijos con amortización automática avanzada (v1: asiento recurrente) · Multi-empresa consolidada · Stock/almacén · Facturación electrónica Verifactu (v1.1: hash encadenado ya previsto en `InvoiceSeries`).

## 5. Criterios de aceptación globales
1. Fixture `ejercicio-completo` produce balance, PyG, PyG analítica y cashflow con I1–I10 PASS y sello VALIDADO AUTOMÁTICAMENTE.
2. Error inyectado (importe alterado por SQL) → detectado por Auditoría en < 1 min.
3. Tenant leak test = 0 filas cruzadas.
4. Una factura PDF subida → asiento confirmado en ≤ 3 clics, con provenance completa (documento, ExtractionRun, usuario).
5. VIEWER no puede mutar nada (UI y servidor).
