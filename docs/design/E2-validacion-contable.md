# E2 — Validación contable del plan de cuentas e impuestos

> Rol: `experto-contable`. Fuentes: `seeds/npgc.csv` (906 filas), `seeds/build_npgc.py`, `docs/MODELO-DATOS.md`, skills `pgc-npgc` y `contabilidad-analitica`.
> Norma de referencia: **RD 1514/2007** (PGC) texto consolidado con **RD 1159/2010**, **RD 602/2016** y **RD 1/2021**; **RD 1515/2007** (PGC PYMES) consolidado con RD 602/2016 y RD 1/2021; Ley 37/1992 (IVA) y RD 1624/1992; Ley 35/2006 y RD 439/2007 (IRPF); RD 1619/2012 (Reglamento de facturación).
> **Todas las cifras son ilustrativas.** Ningún importe de este documento procede de datos reales.

---

## 0. Resumen de la auditoría automática

Recorrido completo de las 906 filas con script Python. Resultados estructurales:

| Comprobación | Resultado |
|---|---|
| Filas / códigos duplicados | 906 / 0 duplicados |
| Padre inexistente (prefijo) | 0 |
| `nivel` ≠ `len(codigo)`, o fuera de 1–4 | 0 |
| Cuentas oficiales de 3 dígitos ausentes en grupos 1–7 | **0** (cuadro completo: 10→19, 20→29, 30→39, 40→49, 50→59, 60→69, 70→79 verificados subgrupo a subgrupo) |
| Nivel ≥ 3 sin `estado_financiero` | 2 (`553`, `559`, contenedores mixtos: **correcto**) |
| Nivel ≥ 3 con `estado_financiero` y sin `epigrafe` | 0 |
| `tipo_analitico` no vacío en grupos 1–5 | 0 |
| Cuentas 6/7 de nivel ≥ 2 sin `tipo_analitico` | 0 |
| Incoherencias naturaleza ↔ estado (contra-cuentas legítimas incluidas) | 158 filas, de las que **4 son errores reales** (5530–5533) y el resto son contra-cuentas correctas (28x, 29x, 39x, 49x, 59x, 406, 437, 606/608/609, 706/708/709) |

**La cobertura del cuadro de cuentas es correcta.** Los defectos están en el *mapeo* (epígrafe/naturaleza de un puñado de cuentas transitorias) y, sobre todo, en la **coherencia entre `epigrafe` y `tipo_analitico`**, que hoy rompe la conciliación EBITDA/EBIT entre PyG contable y PyG analítica.

---

## 1. Auditoría del seed `npgc.csv` — errores de mapeo

Priorizado por impacto en Balance / PyG. Severidad: **A** = altera una masa patrimonial o un margen; **B** = altera un epígrafe dentro de la misma masa; **C** = discutible / configurable.

### 1.1 Errores con impacto en Balance

| Cuenta | Campo | Valor actual | Valor correcto | Fuente/justificación |
|---|---|---|---|---|
| `5530` Socios de sociedad disuelta | `estado_financiero` / `epigrafe` | `BALANCE_PASIVO` · PC/III.5 Otros pasivos financieros | `BALANCE_ACTIVO` · AC/III.3 Deudores varios | **A.** PGC def. 553: 5530 y 5532 recogen el **derecho de crédito** frente a los socios (saldo deudor); 5531/5533 la obligación. `MAPEO` y `NATURALEZA_OVERRIDE` de `build_npgc.py` están **cruzados** entre sí: 5530/5532 salen DEUDORA→Pasivo y 5531/5533 ACREEDORA→Activo. |
| `5532` Socios de sociedad escindida | ídem | ídem | ídem | ídem |
| `5531` Socios, cuenta de fusión | `estado_financiero` / `epigrafe` | `BALANCE_ACTIVO` · AC/III.3 Deudores varios | `BALANCE_PASIVO` · PC/III.5 Otros pasivos financieros | **A.** Naturaleza ACREEDORA ya declarada en el seed; el mapeo la contradice. Con saldo, infla Activo y Pasivo simultáneamente en el mismo importe. |
| `5533` Socios, cuenta de escisión | ídem | ídem | ídem | ídem |
| `190` Acciones o participaciones emitidas | `estado_financiero` / `epigrafe` | `BALANCE_PASIVO` · PC/III.5 | `BALANCE_PN` · A-1) FP / I. Capital / 1. Capital escriturado (signo negativo) | **A.** Las cuentas 190/192/194 forman el bloque transitorio de ampliación de capital; su **neto** figura en Fondos propios como *capital emitido pendiente de inscripción* (ICAC, cta. 194 y NECA 6ª). Llevarlas a Deudas a c/p traslada una ampliación de capital al pasivo exigible. |
| `192` Suscriptores de acciones | ídem | ídem | `BALANCE_PN` · A-1) FP / I. Capital / 2. (Capital no exigido) | ídem |
| `194` Capital emitido pendiente de inscripción | ídem | ídem | `BALANCE_PN` · A-1) FP / I. Capital / 1. Capital escriturado | ídem |
| `551` Cuenta corriente con socios y administradores | `estado_financiero` | `BALANCE_ACTIVO` fijo | **bidireccional**: Activo si saldo deudor, Pasivo (PC/III.5) si acreedor | **A.** Cuenta de saldo indistinto. Con saldo acreedor (lo habitual en PYME: socio que financia) el balance presenta un activo ficticio. Requiere reclasificación por signo en el informe, no un `statement` fijo. |
| `552` / `5523` / `5524` / `5525` Cuenta corriente con vinculadas | `estado_financiero` | `BALANCE_ACTIVO` fijo | bidireccional (Activo IV/V ↔ Pasivo IV/III.5) | **A.** Misma razón. |
| `554` Cuenta corriente con UTE / comunidades | `estado_financiero` | `BALANCE_ACTIVO` fijo | bidireccional | **A.** Misma razón. |
| `555` Partidas pendientes de aplicación | `naturaleza` + `estado_financiero` | `DEUDORA` + `BALANCE_PASIVO` (contradictorio) | bidireccional, contenedor mixto (`estado_financiero` = "") | **A.** Es la cuenta puente natural del importador bancario (E5). Hoy declara naturaleza deudora y se presenta en pasivo: incoherencia interna del propio seed. |
| `1034` / `1044` Socios por desembolsos/aportaciones, capital pendiente de inscripción | `estado_financiero` | `BALANCE_PASIVO` · PC/III.5 | `BALANCE_PN` · A-1) FP / I. Capital / 2. (Capital no exigido) | **B.** Coherente con el tratamiento propuesto de 190/192/194: minoran el capital emitido, no son deuda. |
| `153` / `154` (+ 1533–1536, 1543–1546) | `estado_financiero` | `BALANCE_PASIVO` (naturaleza DEUDORA) | Correcto **como contra-pasivo** (minoran 150) — añadir marca `isContra` | **C.** No es error, pero sin marca de contra-cuenta un renderizador ingenuo las suma en vez de restarlas. Ver regla R-13 (§5). |
| `199` Acciones emitidas consideradas pasivos financieros pendientes de inscripción | `epigrafe` | PC/VII Deuda con características especiales a c/p | Correcto | — (verificado) |

### 1.2 Errores con impacto en PyG (epígrafe)

| Cuenta | Campo | Valor actual | Valor correcto | Fuente/justificación |
|---|---|---|---|---|
| `664` Gastos por dividendos de acciones consideradas pasivos financieros | `epigrafe` | `15. Gastos financieros` (sin letra) | `15. Gastos financieros / b) Por deudas con terceros` | **B.** El modelo normal desglosa 15 en a) grupo y asociadas, b) terceros, c) actualización de provisiones. Sin letra, la cuenta no agrega en ninguna subpartida y descuadra el desglose (el total 15 sí cuadra). |
| `665` Intereses por descuento de efectos y operaciones de factoring | `epigrafe` | `15. Gastos financieros` | `15. Gastos financieros / b) Por deudas con terceros` (salvo 6650/6651/6654/6655 → a)) | **B.** Ídem; el seed ya mapea correctamente los 4 dígitos, falta el nivel 3. |
| `662` Intereses de deudas | `epigrafe` | `15. Gastos financieros` | Aceptable (no postable: tiene hijos 6620–6624) | **C.** Válido si se garantiza `isPostable=false` en cuentas con hijos (regla R-5). |
| Ninguna cuenta mapea al epígrafe `19. Otros ingresos y gastos de carácter financiero` | cobertura | — | reservar el epígrafe para subcuentas de 669/769 creadas por la organización (incorporación al activo de gastos financieros, ingresos por convenios de acreedores) | **C.** El modelo normal (RD 1/2021) incluye la línea 19; el seed nunca la usa. No es error, es un hueco a documentar en el editor de plan. |
| `634` / `639` (ajustes en imposición indirecta) | `epigrafe` | `7. Otros gastos de explotación / b) Tributos` | Correcto | — (verificado; el ajuste por prorrata es gasto/ingreso de explotación, no minoración de IVA) |
| `693`/`793`, `6930`/`7930` | `epigrafe` | `4. Aprovisionamientos` y `2. Variación de existencias PT y en curso` | Correcto | — (verificado: el deterioro de productos terminados/en curso va a la línea 2, el de mercaderías y materias primas a la 4.d) |

### 1.3 `tipo_analitico` discutible — **el hallazgo de mayor impacto**

El problema no es una cuenta suelta: es que `TIPO_ANALITICO` se define por prefijo de grupo mientras `epigrafe` se define por la posición real en el modelo de PyG. Resultado: cuentas que la PyG contable sitúa **dentro del resultado de explotación** reciben tipos analíticos que la tabla de márgenes descuenta **por debajo de EBITDA/EBIT**. El invariante I4 (Σ analítica = PyG contable) sigue cumpliéndose *en el total*, pero **EBITDA y EBIT analíticos no son conciliables con los contables**, que es justo lo que un CFO va a mirar.

| Cuenta(s) | Campo | Valor actual | Valor correcto | Fuente/justificación |
|---|---|---|---|---|
| `670` `671` `672` `770` `771` `772` | `tipo_analitico` | `EXTRAORDINARIO` (nivel BAI) | `AMORTIZACION_DETERIORO` (nivel EBIT) o nuevo tipo `RESULTADO_ENAJENACION` a nivel EBIT | **A.** Epígrafe 11 del modelo normal está **dentro** de A) Resultado de explotación. Hoy el EBIT analítico difiere del contable por el resultado de bajas de inmovilizado. |
| `678` `778` Gastos / ingresos excepcionales | `tipo_analitico` | `EXTRAORDINARIO` (nivel BAI) | `INDIRECTO_CECO` con CECO `EXTRAORDINARIO` (nivel EBITDA) | **A.** Epígrafe 13 "Otros resultados" está dentro del resultado de explotación desde RD 602/2016. El CECO `EXTRAORDINARIO` ya existe en `CostCenterKind` justamente para esto. |
| `693` `793` Deterioro / reversión de existencias | `tipo_analitico` | `AMORTIZACION_DETERIORO` (EBIT) | `COSTE_DIRECTO_MC1` | **A.** Epígrafe 4 Aprovisionamientos (y 2 para 6930/7930): forma parte del margen bruto, no de la amortización. |
| `694` `695` `794` Deterioro/provisión operaciones comerciales | `tipo_analitico` | `AMORTIZACION_DETERIORO` (EBIT) | `INDIRECTO_CECO` (CECO `G_A` o `MARKETING_VENTAS`) | **A.** Epígrafe 7.c) dentro de Otros gastos de explotación → EBITDA. |
| `795` Exceso de provisiones | `tipo_analitico` | `AMORTIZACION_DETERIORO` (EBIT) | `INDIRECTO_CECO` (reversión al CECO que dotó) | **A.** Epígrafe 10, dentro de explotación. |
| `696`–`699` `796`–`799` Deterioro/reversión de instrumentos financieros | `tipo_analitico` | `AMORTIZACION_DETERIORO` (EBIT) | `FINANCIERO` | **A.** Epígrafe 18, dentro de B) Resultado financiero. Hoy un deterioro de una participación rebaja el EBIT. |
| `650` Pérdidas de créditos comerciales incobrables | `tipo_analitico` | `NO_ANALITICO` | `INDIRECTO_CECO` (CECO `G_A`) | **B.** Es gasto de explotación (7.c). Como `NO_ANALITICO` desaparece de todas las columnas analíticas y solo se ve en la columna residual. |
| `651` `659` Otros gastos de gestión corriente | `tipo_analitico` | `NO_ANALITICO` | `INDIRECTO_CECO` (`G_A`) | **B.** Ídem (7.d). |
| `673` `675` `766` `773` `775` | `tipo_analitico` | `EXTRAORDINARIO` | `FINANCIERO` | **C.** Ambos tipos se descuentan al nivel BAI: sin impacto numérico, sí de presentación (mezcla resultado financiero con excepcional). |
| `623` Servicios de profesionales independientes | `tipo_analitico` | `INDIRECTO_CECO` | Para empresa de proyectos: `COSTE_DIRECTO_MC2` por defecto (override por línea) | **C.** En una consultora, el freelance facturado por 623 es coste directo de proyecto. Configurable por organización; documentar el default recomendado por sector. |
| `624` `628` `629` | `tipo_analitico` | `INDIRECTO_CECO` | Correcto como default; el override por línea (ya previsto) cubre viajes/materiales de proyecto | **C.** |
| `73x` Trabajos realizados por la empresa para su activo | `tipo_analitico` | `NO_ANALITICO` | `INGRESO_DIRECTO` opcional cuando la organización capitaliza desarrollo por proyecto | **C.** Parametrizable: afecta a MC1 del proyecto capitalizador. |
| `74x` Subvenciones a la explotación | `tipo_analitico` | `NO_ANALITICO` | `INGRESO_DIRECTO` cuando la subvención es de proyecto (I+D, formación) | **C.** Parametrizable. Muy relevante para PYMEs con proyectos subvencionados. |
| `71x` Variación de existencias de productos | `tipo_analitico` | `COSTE_DIRECTO_MC1` (naturaleza acreedora) | Correcto aritméticamente (coste negativo) | — Documentar el signo en la UI para que no se lea como "coste negativo" erróneo. |

**Regla de coherencia que debe añadirse a `build_npgc.py` y a los tests**: para toda cuenta 6/7, el `marginLevel` implícito por su `tipo_analitico` debe pertenecer al bloque de PyG de su `epigrafe` (explotación → INGRESOS…EBIT; financiero → BAI; impuesto → RESULTADO). Un test parametrizado sobre las 906 filas evita que esta clase de error vuelva.

---

## 2. `importNPGC(variant)` — reglas PYMES vs GENERAL

El PGC PYMES **no es** el cuadro general recortado por tamaño: excluye operaciones que la norma PYMES no admite (coberturas contables, valor razonable con cambios en PN, combinaciones de negocios, instrumentos compuestos, activos mantenidos para la venta, retribuciones a l/p de prestación definida y pagos basados en instrumentos de patrimonio) y usa **modelos abreviados de balance y PyG con numeración propia**. Además, desde RD 602/2016 las cuentas anuales PYMES son **balance, PyG y memoria**: no hay ECPN ni EFE → los grupos 8 y 9 sobran.

### 2.1 Filtrado (`variant = "PYMES"` ⇒ no se crea la cuenta)

| # | Regla (prefijos) | Filas afectadas | Motivo |
|---|---|---|---|
| P-01 | `8*`, `9*` | 62 | PYMES no formula ECPN (RD 602/2016). Sin grupos 8/9 no hay estado de ingresos y gastos reconocidos. |
| P-02 | `133`, `134`, `1340`, `1341`, `135`, `136` | 6 | No existe la categoría "valor razonable con cambios en PN", ni contabilidad de coberturas, ni diferencias de conversión, ni AN mantenidos para la venta en PGC PYMES. |
| P-03 | `137`, `1370`, `1371` | 3 | Ingresos fiscales a distribuir en varios ejercicios: no previstos en PYMES. |
| P-04 | `1110` | 1 | Instrumentos financieros compuestos, excluidos de PYMES. |
| P-05 | `178` | 1 | Obligaciones y bonos convertibles (compuestos). |
| P-06 | `140`, `147` | 2 | Provisión por retribuciones a l/p al personal y por pagos basados en instrumentos de patrimonio: operaciones no admitidas. |
| P-07 | `176`, `1765`, `1768`, `255`, `2550`, `2553`, `5593`, `5598` | 8 | Derivados designados como instrumentos de **cobertura** (los de cartera de negociación, `5590`/`5595`, **sí** se conservan). |
| P-08 | `204` | 1 | Fondo de comercio: surge de combinaciones de negocios, fuera del alcance de PGC PYMES. |
| P-09 | `774` | 1 | Diferencia negativa en combinaciones de negocio (idem). |
| P-10 | `580`–`589`, `599*` | 16 | Activos no corrientes y grupos enajenables mantenidos para la venta: no aplicable en PYMES. |
| P-11 | `643`, `644*`, `645*`, `6450`, `6457`, `7950`, `7957` | 10 | Retribuciones a l/p de prestación definida y retribuciones mediante instrumentos de patrimonio. (`642` y `649` se conservan.) |
| P-12 | `6632`, `7632` | 2 | Imputación al resultado por activos a valor razonable con cambios en PN (categoría inexistente en PYMES). |
| P-13 | Toda cuenta cuyo `padre` haya sido filtrado | derivadas | Integridad referencial del árbol: el filtro se aplica en cascada por prefijo y después se revalida `padre ∈ códigos creados`. |

> **No filtrar** (errores frecuentes): `108`/`109` (autocartera), `112`–`119`, `130`–`132`, `474`/`479` (impuesto diferido, sí existe en PYMES), `22x` (inversiones inmobiliarias), `24x` (partes vinculadas), `663`/`763` (cartera de negociación), `4740`/`4745`.

### 2.2 Renumeración de epígrafes de PyG (modelo PYMES / abreviado)

`importNPGC` reescribe el prefijo numérico del `epigrafe`; el texto se mantiene salvo donde se indica.

| Epígrafe GENERAL (seed actual) | Epígrafe PYMES | Nota |
|---|---|---|
| 1–11 | 1–11 (idénticos) | Sin cambio |
| `12. Diferencia negativa de combinaciones de negocio` | — | Cuenta 774 filtrada (P-09); el epígrafe desaparece |
| `13. Otros resultados` | `12. Otros resultados` | 678/778 |
| `14. Ingresos financieros` | `13. Ingresos financieros` | 760–762, 767, 769 |
| `15. Gastos financieros` | `14. Gastos financieros` | 660–665, 669 |
| `16. Variación de valor razonable en instrumentos financieros` | `15. Variación de valor razonable en instrumentos financieros` | Solo subpartida a) Cartera de negociación (la b) desaparece con P-12) |
| `17. Diferencias de cambio` | `16. Diferencias de cambio` | 668/768 |
| `18. Deterioro y resultado por enajenaciones de instrumentos financieros` | `17. Deterioro y resultado por enajenaciones de instrumentos financieros` | 666/667/673/675/696–699, 766/773/775/796–799 |
| `19. Otros ingresos y gastos de carácter financiero` | `18. Otros ingresos y gastos de carácter financiero` | Sin cuentas en el seed |
| `20. Impuestos sobre beneficios` | `19. Impuestos sobre beneficios` | 630/633/638 |

### 2.3 Renumeración de epígrafes de Balance (modelo PYMES / abreviado)

| Bloque | GENERAL (seed actual) | PYMES | Nota |
|---|---|---|---|
| Activo no corriente | I–VI (Intangible, Material, Inv. inmobiliarias, Inv. grupo l/p, Inv. financieras l/p, Activos impuesto diferido) | I–VI idénticos | Sin cambio |
| Activo corriente | `I. Activos no corrientes mantenidos para la venta` | **eliminado** | P-10 |
| Activo corriente | `II. Existencias` | `I. Existencias` | −1 |
| Activo corriente | `III. Deudores comerciales y otras cuentas a cobrar` | `II. Deudores comerciales y otras cuentas a cobrar` | −1 |
| Activo corriente | `IV. Inversiones en empresas del grupo y asociadas a corto plazo` | `III. …` | −1 |
| Activo corriente | `V. Inversiones financieras a corto plazo` | `IV. …` | −1 |
| Activo corriente | `VI. Periodificaciones a corto plazo` | `V. Periodificaciones a corto plazo` | −1 |
| Activo corriente | `VII. Efectivo y otros activos líquidos equivalentes` | `VI. Efectivo y otros activos líquidos equivalentes` | −1 |
| Patrimonio neto | `A-2) Ajustes por cambios de valor` | **eliminado** | Sin cuentas tras P-02 |
| Patrimonio neto | `A-3) Subvenciones, donaciones y legados recibidos` | `A-2) Subvenciones, donaciones y legados recibidos` | Renombrado |
| Pasivo no corriente | I–VII | I–V + `VI. Acreedores comerciales no corrientes` / sin `Deuda con características especiales`… | Conservar VII solo si la org usa 15x; si P-nada lo filtra, mantener el epígrafe |
| Pasivo corriente | `I. Pasivos vinculados con activos no corrientes mantenidos para la venta` | **eliminado** | P-10 |
| Pasivo corriente | `II. Provisiones a corto plazo` … `VII.` | −1 en toda la numeración romana | Consecuencia de la eliminación anterior |

### 2.4 Contrato de `importNPGC`

```ts
importNPGC(orgId, variant: "GENERAL" | "PYMES", opts?: {
  useSubaccounts?: boolean   // crea 4xxx/5xxx operativas (§3.3); default true
  createSoftwareAccounts?: boolean // 4720/4770/4730/4760 (no oficiales); default false
}) : { created: number; skipped: number; mapKeys: number }
```

| Requisito | Regla |
|---|---|
| Idempotencia | `upsert` por `(organizationId, code)`; nunca desactiva ni renombra lo ya existente |
| Orden | Inserción por `code` ascendente para que el padre exista antes que el hijo |
| `isPostable` | `true` ⟺ la cuenta no tiene ningún hijo **entre las creadas** (se recalcula tras el filtrado PYMES: al filtrar `1340`/`1341` la cuenta `134` desaparece también por P-02, pero al filtrar `6632` la cuenta `663` pasa a ser hoja y postable) |
| `isSystem` | `true` para toda cuenta referenciada por `OrganizationAccountMap` |
| Revalidación | Tras el filtro: 0 padres huérfanos, 0 claves de `OrganizationAccountMap` apuntando a cuenta inexistente o no postable |
| Variante en `Organization` | `pgcVariant` queda fijada; **cambiarla con asientos posteados debe estar prohibido** (regla R-14) |

---

## 3. `OrganizationAccountMap` — validación y claves que faltan

### 3.1 Validación de la lista actual (`AccountKey`, 16 claves)

| Clave | Default | Veredicto |
|---|---|---|
| `CLIENTES` 430 · `PROVEEDORES` 400 · `ACREEDORES` 410 | ✔ existen en el seed | OK (ver §3.3 sobre el nivel) |
| `BANCO_DEFAULT` 572 · `CAJA` 570 | ✔ | OK con reserva de nivel |
| `IVA_SOPORTADO` 472 · `IVA_REPERCUTIDO` 477 | ✔ | OK |
| `IRPF_RETENIDO_CLIENTES` 473 · `IRPF_A_PAGAR` 4751 | ✔ | OK, pero 4751 es única para tres conceptos → §3.4 |
| `HP_DEUDORA_IVA` 4700 · `HP_ACREEDORA_IVA` 4750 | ✔ | OK |
| `SS_ACREEDORA` 476 · `REMUNERACIONES_PENDIENTES` 465 | ✔ | OK |
| `RESULTADO_EJERCICIO` 129 | ✔ | OK |
| `VENTAS_DEFAULT` 705 | ✔ | OK para empresa de servicios |
| `COMPRAS_DEFAULT` 600 | ✔ | **Observación**: para una empresa de proyectos/servicios el default natural es `607` (trabajos realizados por otras empresas). Proponer default por sector o renombrar la clave a `APROVISIONAMIENTO_DEFAULT`. |

Faltan claves para **todos** los asientos tipo de E3 (facturación) y E8 (impuestos/cierre) más allá del caso simple.

### 3.2 Claves propuestas (ampliación de `enum AccountKey`)

| Clave nueva | Default | Asiento / épica que la necesita |
|---|---|---|
| `SUBCONTRATACION_DEFAULT` | 607 | E3 factura recibida de subcontrata (MC1) |
| `IVA_SOPORTADO_ISP` | 472 (subcta.) | E3 inversión del sujeto pasivo / adquisición intracomunitaria: exige **doble apunte** 472 debe / 477 haber |
| `IVA_REPERCUTIDO_ISP` | 477 (subcta.) | ídem |
| `AJUSTE_IVA_NEGATIVO` | 634 | E8 regularización de prorrata y de bienes de inversión |
| `AJUSTE_IVA_POSITIVO` | 639 | ídem |
| `ANTICIPOS_PROVEEDORES` | 407 | E3 anticipo a proveedor (activo, no gasto) |
| `ANTICIPOS_CLIENTES` | 438 | E3 anticipo de cliente (pasivo, con IVA devengado) |
| `PERIODIFICACION_GASTO` | 480 | E8 devengo de gastos anticipados |
| `PERIODIFICACION_INGRESO` | 485 | E8 devengo de ingresos anticipados |
| `DESCUENTO_PP_VENTAS` | 706 | E3 descuento por pronto pago concedido |
| `DESCUENTO_PP_COMPRAS` | 606 | E3 descuento por pronto pago obtenido |
| `DEVOLUCION_VENTAS` | 708 | E3 abono/rectificativa por devolución |
| `DEVOLUCION_COMPRAS` | 608 | E3 ídem lado compras |
| `RAPPEL_VENTAS` | 709 | E3 rappel anual |
| `RAPPEL_COMPRAS` | 609 | E3 ídem |
| `DIFERENCIA_CAMBIO_NEGATIVA` | 668 | E3/E5 liquidación en divisa y valoración a cierre |
| `DIFERENCIA_CAMBIO_POSITIVA` | 768 | ídem |
| `REDONDEO_GASTO` | 669 | E3/E5 diferencia de redondeo ≤ tolerancia (§4.4) |
| `REDONDEO_INGRESO` | 769 | ídem |
| `IRPF_ALQUILERES_A_PAGAR` | 4751 (subcta. recomendada 47511) | E3 factura de alquiler con retención 19 % (modelo 115) |
| `IRPF_TRABAJO_A_PAGAR` | 4751 (subcta. 47512) | E4 nómina (modelo 111) |
| `IRPF_PROFESIONALES_A_PAGAR` | 4751 (subcta. 47510) | E3 factura de profesional con retención (modelo 111) |
| `RETENCIONES_CAPITAL_SOPORTADAS` | 473 | E5 intereses bancarios con retención 19 % |
| `SS_DEUDORA` | 471 | E4 nómina con prestaciones en pago delegado |
| `ANTICIPOS_REMUNERACIONES` | 460 | E4 anticipo a empleado |
| `SUELDOS_DEFAULT` | 640 | E4 nómina |
| `SS_EMPRESA_DEFAULT` | 642 | E4 nómina |
| `IMPUESTO_BENEFICIOS_GASTO` | 630 | E8 cierre: liquidación IS |
| `HP_ACREEDORA_IS` | 4752 | E8 cuota a pagar |
| `HP_DEUDORA_IS` | 4709 | E8 devolución solicitada |
| `ACTIVO_IMPUESTO_DIFERIDO` | 4740 | E8 diferencias temporarias |
| `PASIVO_IMPUESTO_DIFERIDO` | 479 | E8 ídem |
| `CLIENTES_DUDOSO_COBRO` | 436 | E3/E6 reclasificación de impagados |
| `DETERIORO_CLIENTES` | 490 | E6 dotación de insolvencias |
| `DOTACION_DETERIORO_CREDITOS` | 694 | E6 ídem (gasto) |
| `REVERSION_DETERIORO_CREDITOS` | 794 | E6 reversión |
| `PERDIDA_CREDITOS_INCOBRABLES` | 650 | E6 fallido definitivo |
| `CUENTA_PUENTE_TESORERIA` | 555 | E5 importación bancaria: línea sin contrapartida identificada |
| `REMANENTE` | 120 | E8 distribución del resultado |
| `RESULTADOS_NEGATIVOS_ANTERIORES` | 121 | E8 ídem |
| `COMISIONES_BANCARIAS` | 626 | E5 conciliación automática de comisiones |

### 3.3 IVA soportado **no deducible**

No procede una clave nueva con cuenta propia. Conforme a la **Resolución del ICAC sobre determinación del coste** y a la NRV 2ª/10ª, el IVA soportado no deducible **incrementa el precio de adquisición** del bien o servicio. Regla para el motor:

| Caso | Tratamiento |
|---|---|
| Prorrata 0 % o cuota íntegramente no deducible | La cuota se suma a la línea de gasto/inmovilizado (misma cuenta 6xx/2xx, mismo destino analítico). No se toca 472. |
| Prorrata parcial (regla de prorrata general) | Se contabiliza el 472 por la parte deducible y el resto engorda la línea de gasto. Parámetro por organización: `prorrataPermille` (versionado por ejercicio, `validFrom`/`validTo`). |
| Regularización anual de prorrata definitiva | Asiento contra `AJUSTE_IVA_NEGATIVO` 634 / `AJUSTE_IVA_POSITIVO` 639 (nunca contra 472). |
| Regularización de bienes de inversión (5/10 años) | Ídem 634/639. Parametrizable: `regularizacionBienesInversion: bool`. |

### 3.4 Nivel de las cuentas del mapa: `572` vs `5720`, `430` vs `4300`

| Opción | Pros | Contras | Recomendación |
|---|---|---|---|
| Mapear a nivel 3 (`572`, `430`, `400`, `410`) | Plan mínimo, seed sin subcuentas inventadas | Una sola cuenta bancaria; el mayor de 430 mezcla todos los clientes; el desglose por tercero depende de `counterpartyId` | Válido **solo** con `Counterparty` obligatorio en toda línea de 43x/40x/41x |
| Mapear a nivel 4 creado por `importNPGC` (`5720`, `4300`, `4000`, `4100`) | Un banco = una subcuenta (obligatorio con >1 cuenta corriente); mayor legible; export a otros programas | Añade cuentas no oficiales al plan (aceptado: el PGC permite libre desarrollo en subcuentas) | **Recomendada**, con `opts.useSubaccounts = true` por defecto |

Regla resultante: `572`, `430`, `400`, `410` se crean con `isPostable = false` cuando `useSubaccounts = true`; el mapa apunta siempre a la hoja. **Invariante nuevo (I-plan-1): toda `OrganizationAccountMap.accountCode` debe resolver a una cuenta existente, activa, `isPostable = true` y de la misma organización.** Se verifica en el arranque de `post.ts` y en la pestaña Auditoría.

Análogamente, `IRPF_A_PAGAR` apuntando a `4751` para tres modelos distintos (111 profesionales, 111 trabajo, 115 alquileres) impide cuadrar cada modelo contra su cuenta. Recomendación: `useSubaccounts = true` crea `47510`/`47511`/`47512` (nivel 5 — obliga a subir el límite de `Account.code` a 12 caracteres, ya previsto en el modelo) y las tres claves nuevas apuntan a ellas; con `false`, las tres apuntan a `4751` y el cuadre por modelo se hace por `taxRateId`.

---

## 4. `TaxRate` — tipos vigentes en España 2026

### 4.1 IVA (Ley 37/1992, arts. 90 y 91)

| `code` | `kind` | `ratePermille` | Cuenta repercusión (venta) | Cuenta soporte (compra) | Contrapartida / nota |
|---|---|---|---|---|---|
| `IVA_21` | `IVA` | 210 | 477 | 472 | Tipo general |
| `IVA_10` | `IVA` | 100 | 477 | 472 | Reducido (hostelería, transporte de viajeros, vivienda, agua, ciertos alimentos) |
| `IVA_4` | `IVA` | 40 | 477 | 472 | Superreducido (pan, leche, huevos, frutas/verduras, libros, medicamentos, VPO) |
| `IVA_0_INTRA` | `EXENTO` | 0 | — | — | Entrega intracomunitaria exenta (art. 25). Requiere ROI + VIES; sin cuota. |
| `IVA_0_EXPORT` | `EXENTO` | 0 | — | — | Exportación (art. 21) |
| `IVA_EXENTO_20` | `EXENTO` | 0 | — | — | Exención art. 20 (sanidad, enseñanza, seguros, financieras). **Genera prorrata.** |
| `IVA_NO_SUJETO` | `EXENTO` | 0 | — | — | No sujeción (art. 7): suplidos, transmisión de unidad económica. No entra en la base de la 303. |
| `IVA_ISP` | `IVA` | 210 | 477 | 472 | Inversión del sujeto pasivo (art. 84.Uno.2º): **doble apunte** simultáneo, efecto neto 0 |
| `IVA_ADQ_INTRA` | `IVA` | 210 / 100 / 40 | 477 | 472 | Adquisición intracomunitaria de bienes/servicios: ídem doble apunte |

> Los tipos temporales de 2022–2024 (alimentos al 0 %/5 %, electricidad y gas al 5 %/10 %) **expiraron el 31-12-2024**; el seed de `TaxRate` no debe incluirlos con `validTo` abierto. Cualquier tipo temporal futuro se modela con `validFrom`/`validTo`, sin tocar código: es el motivo por el que `TaxRate` está versionada.

### 4.2 Recargo de equivalencia (art. 161 LIVA) — régimen del comerciante minorista

| `code` | `kind` | `ratePermille` | Cuenta (vendedor) | Cuenta (minorista comprador) | Nota |
|---|---|---|---|---|---|
| `REQ_5_2` | `RECARGO` | 52 | 477 (subcta. recomendada) | mayor coste de la mercadería (600/6xx) | Acompaña a IVA 21 % |
| `REQ_1_4` | `RECARGO` | 14 | 477 | 600/6xx | Acompaña a IVA 10 % |
| `REQ_0_5` | `RECARGO` | 5 | 477 | 600/6xx | Acompaña a IVA 4 % |
| `REQ_1_75` | `RECARGO` | 17,5 → **usar `ratePermille` en diezmilésimas o campo dedicado** | 477 | 600/6xx | Labores del tabaco. **Alerta de modelo**: 1,75 % no es entero en tanto por mil. |

> **Hallazgo de modelo de datos**: `TaxRate.ratePermille Int` no representa 1,75 % (17,5 ‰). Debe pasar a `rateBps Int` (puntos básicos, 1,75 % = 175 bps) o `rateMicro Int` (17 500). Afecta también a futuros tipos autonómicos de IGIC con decimales.

### 4.3 IRPF — retenciones (Ley 35/2006, arts. 99–101; RD 439/2007, arts. 80, 95, 100–101)

| `code` | `kind` | `ratePermille` | Cuenta (nosotros retenemos = pagador) | Cuenta (nos retienen = perceptor) | Modelo / nota |
|---|---|---|---|---|---|
| `IRPF_PROF_15` | `IRPF` | 150 | 4751 (subcta. 47510) | 473 | Actividades profesionales, tipo general |
| `IRPF_PROF_7` | `IRPF` | 70 | 4751 (47510) | 473 | Inicio de actividad: año de inicio y **los dos siguientes** (art. 95.1 RIRPF), previa comunicación por escrito al pagador |
| `IRPF_ALQ_19` | `IRPF` | 190 | 4751 (47511) | 473 | Arrendamiento de inmuebles urbanos (modelo 115/180) |
| `IRPF_CURSOS_15` | `IRPF` | 150 | 4751 (47512) | 473 | Cursos, conferencias, seminarios y elaboración de obras literarias/artísticas/científicas con cesión de derechos (art. 80.1.4º RIRPF) |
| `IRPF_PI_15` | `IRPF` | 150 | 4751 (47510) | 473 | Propiedad intelectual, régimen general |
| `IRPF_PI_7` | `IRPF` | 70 | 4751 | 473 | Propiedad intelectual: autor persona física con rendimientos íntegros del ejercicio anterior < 15.000 € y > 75 % de sus rendimientos totales, previa comunicación |
| `IRPF_AGRO_2` | `IRPF` | 20 | 4751 | 473 | Actividades agrícolas y ganaderas en general |
| `IRPF_AGRO_1` | `IRPF` | 10 | 4751 | 473 | Engorde de porcino y avicultura |
| `IRPF_FORESTAL_2` | `IRPF` | 20 | 4751 | 473 | Actividades forestales |
| `IRPF_MODULOS_1` | `IRPF` | 10 | 4751 | 473 | Actividades empresariales en estimación objetiva del art. 95.6 RIRPF |
| `IRPF_CAPITAL_19` | `IRPF` | 190 | 4751 | 473 | Rendimientos del capital mobiliario (intereses, dividendos), ganancias de IIC |
| `IRPF_ADMIN_35` | `IRPF` | 350 | 4751 (47512) | — | Administradores y consejeros |
| `IRPF_ADMIN_19` | `IRPF` | 190 | 4751 (47512) | — | Administradores de entidades con INCN < 100.000 € |
| `IRPF_TRABAJO_VAR` | `IRPF` | variable | 4751 (47512) | — | Rendimientos del trabajo: **tipo calculado por empleado** (algoritmo del art. 82 RIRPF). El ERP no lo calcula: lo toma del proveedor de nóminas. Marcar `computed = true`. |

### 4.4 Impuestos territoriales — parametrizables, no cableados

| Impuesto | Ámbito | Tipos de referencia | Tratamiento en el ERP |
|---|---|---|---|
| IGIC | Canarias | general, reducido, cero, incrementado (varios) | `TaxKind.IVA` con `code` propio (`IGIC_*`), cuentas 472/477. Los tipos los fija la Ley de Presupuestos de Canarias y **cambian con frecuencia**: se cargan por organización con `validFrom`/`validTo`, nunca en el seed global. |
| IPSI | Ceuta y Melilla | gravamen por producto/servicio, ordenanzas fiscales locales | Ídem, `code` `IPSI_*`. |
| Recargos y tipos autonómicos futuros | — | — | Toda alta de tipo pasa por el editor de `TaxRate`; el motor jamás hardcodea porcentajes. |

### 4.5 Redondeo: por línea vs por total

Base normativa: **RD 1619/2012, art. 6.1.f)** — la factura debe expresar "el tipo impositivo" y "la cuota tributaria que, en su caso, se repercuta"; el art. 6.5 permite consignar la cuota **por separado por cada tipo impositivo**. La norma no impone el algoritmo de redondeo; lo que sí exige la AEAT (validaciones SII y modelo 303) es la **coherencia interna**: base × tipo ≈ cuota, con la tolerancia de céntimos derivada del redondeo.

| Regla | Definición | Justificación |
|---|---|---|
| **R-IVA-1 (canónica)** | La cuota se calcula **por grupo de tipo impositivo**: `cuota_tipo = redondear(Σ bases_linea_del_tipo × tipo)`. Un único redondeo por tipo. | Coincide con la estructura de la factura (art. 6.5 RD 1619/2012) y con la declaración 303, que agrega por tipo. Minimiza la divergencia acumulada. |
| **R-IVA-2** | Redondeo *half-up* a céntimo (0,005 → 0,01), sobre importes en céntimos enteros, sin `Float` en ningún paso. | Convención de mercado y de la AEAT; evita el sesgo del *banker's rounding* en carteras grandes. |

> **Nota de implementación (E2, `lib/taxes/bps.ts`)** — añadida en la revisión de ronda 1, no altera la regla. `applyBps(base, bps)` redondea *half-up sobre la MAGNITUD* («half away from zero»), no hacia +∞: `applyBps(10, 500) = 1` y `applyBps(-10, 500) = -1`. La simetría es deliberada y es lo que exige una rectificativa: si el redondeo fuera hacia +∞, la cuota de la factura y la de su abono no se anularían y quedaría un céntimo huérfano en el 477 que ninguna liquidación cuadraría. `lib/money.ts::applyPermille` (half-even, tanto por mil) queda para conversiones no fiscales; no se usa para cuotas.
| **R-IVA-3** | El redondeo **por línea** es admisible (facturas de retail, TPV) pero entonces `cuota_tipo = Σ cuotas_linea_redondeadas`, no el recálculo sobre la base total. Nunca se mezclan ambos métodos en un mismo documento. | Si se redondea por línea y luego se recalcula sobre el total, base y cuota dejan de ser coherentes y el SII lo rechaza. |
| **R-IVA-4** | El método (`PER_LINEA` \| `PER_TIPO`) es un campo de la organización *y* del documento; se sella en el asiento para que el recálculo sea reproducible. | Principio P2 de SPEC-FIABILIDAD: el mismo input debe dar el mismo output para siempre. |
| **R-IVA-5** | Validación al postear: `Σ bases_linea = base_documento` (tolerancia **0**) y `|Σ cuotas − Σ redondear(base_tipo × tipo)| ≤ 1 céntimo × nº de tipos`. Fuera de tolerancia ⇒ el asiento **no se persiste**. | Comprobación 5 de `post.ts` (skill `pgc-npgc`). |
| **R-IVA-6** | La retención de IRPF se calcula **sobre la base imponible total del documento** (no por línea) y se redondea una sola vez. | Art. 100 RIRPF: la retención se practica sobre la contraprestación íntegra. |
| **R-IVA-7** | Diferencia residual de ≤ 1 céntimo entre total de factura y suma de apuntes (p. ej. factura de proveedor con redondeo distinto al nuestro): asiento contra `REDONDEO_GASTO` 669 / `REDONDEO_INGRESO` 769, con `description` normalizada y marca en Auditoría. Umbral configurable (`redondeoToleranciaCents`, default 1); por encima, **bloquea**. | Evita descuadres de partida doble sin permitir que se cuele un error real. |
| **R-IVA-8** | Descuentos: los descuentos en factura minoran la base imponible (art. 78.Tres.2º LIVA) y **no** pasan por 706/709; 706/709 son para descuentos y rappels **posteriores** a la factura, documentados en rectificativa. | Error frecuente en ERPs; conviene bloquearlo en el editor de facturas. |

---

## 5. Reglas de validación del editor de plan de cuentas

| Regla | Severidad | Justificación |
|---|---|---|
| **R-01** `code` solo dígitos, longitud 1–12 | bloquea | Invariante del árbol por prefijo; un carácter no numérico rompe la derivación de padre y todos los agregados por prefijo |
| **R-02** `code` de longitud ≥ 3 para cuentas postables (`isPostable = true`) | bloquea | El PGC define el nivel de "cuenta" en 3 dígitos; grupos y subgrupos son agregadores contables, no destinos de apunte |
| **R-03** El padre por prefijo (`code[:-1]`) debe existir y estar activo | bloquea | Sin padre no hay agregación posible; produce huérfanos invisibles en balance |
| **R-04** Cuenta con al menos un hijo ⇒ `isPostable = false` (forzado, no editable) | bloquea | Evita el doble cómputo: el saldo del padre es la suma de los hijos |
| **R-05** No se puede crear un hijo de una cuenta que ya tiene líneas de asiento | bloquea | Convertiría un saldo existente en un padre no postable y dejaría movimientos en una cuenta no hoja |
| **R-06** `isSystem = true` ⇒ no desactivable, no borrable, `code` no editable | bloquea | Está referenciada por `OrganizationAccountMap`; el motor la necesita para todo asiento tipo |
| **R-07** Toda `OrganizationAccountMap.accountCode` debe resolver a cuenta existente, activa, postable y de la organización | bloquea | Invariante I-plan-1 (§3.3); un mapa roto produce asientos imposibles en tiempo de ejecución |
| **R-08** Borrado solo si la cuenta tiene 0 líneas **y** 0 hijos **y** `isSystem = false` | bloquea | Nada con historia se borra (principio 6 de SPEC-FIABILIDAD) |
| **R-09** Desactivar (`isActive = false`) es siempre posible salvo R-06; una cuenta inactiva no admite líneas nuevas pero sigue apareciendo en informes históricos | bloquea (alta de línea) | Trazabilidad: los informes de ejercicios cerrados no pueden cambiar |
| **R-10a** Cambiar `statement` de una cuenta oficial de nivel ≤ 3: **prohibido** para todos los roles (ver C-4); el destino correcto se consigue creando una subcuenta | bloquea | Mueve masa patrimonial entre Activo/Pasivo/PN y rompe I2 e I3; ninguna necesidad legítima lo exige |
| **R-10b** Cambiar `epigrafe` de una cuenta oficial de nivel ≤ 3: solo `ADMIN`, con `reason` obligatorio y `AuditLog`; **prohibido si hay líneas en un ejercicio `CLOSED`** | bloquea | Admite juicio profesional dentro de la misma masa, pero reexpresaría cuentas anuales ya formuladas |
| **R-11** Prohibido asignar `statement ∈ {BALANCE_*}` a una cuenta de grupo 6 o 7, y `PYG` a una de grupos 1–5 | bloquea | Rompe simultáneamente I2 (Activo = Pasivo + PN) e I3 (PyG = líneas 6/7): un gasto en balance descuadra ambos |
| **R-12** Prohibido asignar `ECPN` a cuentas de grupos 1–7, y `PYG`/`BALANCE_*` a grupos 8/9 | bloquea | Los grupos 8/9 solo alimentan el estado de ingresos y gastos reconocidos |
| **R-13** Cuenta con `naturaleza` contraria a su `statement` (ACREEDORA en Activo, DEUDORA en Pasivo) debe declarar `isContra = true` | aviso | Es legítimo (28x, 29x, 39x, 49x, 59x, 406, 437) pero el renderizador necesita saber que **resta**; sin la marca, el balance suma en vez de restar. **Campo nuevo propuesto en `Account`.** |
| **R-14** `Organization.pgcVariant` no se puede cambiar si existe algún `JournalEntry` posteado | bloquea | Cambiaría el modelo de cuentas anuales y la numeración de epígrafes de periodos ya informados |
| **R-15** `epigraph` debe pertenecer al catálogo cerrado de epígrafes de la variante activa | bloquea | Texto libre produce epígrafes huérfanos que no agregan en ningún informe |
| **R-16** Para cuentas 6/7: el `marginLevel` implícito en `analyticType` debe ser coherente con el bloque de PyG de su `epigraph` (explotación / financiero / impuesto) | aviso | Es la causa raíz de §1.3; como aviso permite excepciones justificadas por organización, y la Auditoría lista las divergencias |
| **R-17** Cambiar `analyticType` de una cuenta con líneas en un periodo con `AllocationRun` vigente exige recalcular la liquidación (aviso + acción sugerida) | aviso | Las imputaciones existentes quedarían basadas en una clasificación obsoleta |
| **R-18** `cashflowCategory` solo se admite en cuentas 57x y en las marcadas como contrapartida de tesorería | aviso | Fuera de 57x el campo no lo usa ningún informe: dato muerto que confunde |
| **R-19** Renombrar (`name`) siempre permitido, incluso en cuentas de sistema; queda en `AuditLog` | permitido | Requisito funcional explícito |
| **R-20** Crear cuentas de convención de software (4720/4730/4760/4770/4771/4790) solo como **subcuentas** de 472/473/476/477/479 | aviso | No son cuentas oficiales del PGC; como subcuentas son libres desarrollo (parte quinta del PGC) y no rompen el árbol |
| **R-21** Un cambio de `code` (recodificación) está prohibido si hay líneas; si no las hay, arrastra a los hijos en cascada dentro de una transacción | bloquea | `JournalLine.accountCode` es una FK compuesta denormalizada: un cambio parcial dejaría líneas huérfanas |
| **R-22** Importar/editar el plan requiere rol ≥ `EDITOR`; `statement`, `isSystem` y variante requieren `ADMIN` | bloquea | Segregación de funciones (principio 5) |

---

## 6. Veredicto sobre el diseño de datos

### **OBSERVACIONES** — el diseño es correcto en su arquitectura; hay 3 defectos de datos y 5 carencias de esquema que deben cerrarse dentro de E2.

**Lo que está bien y no debe tocarse**

| Elemento | Valoración |
|---|---|
| `Account` con `(organizationId, code)` único, `parentCode` derivado, `isPostable`/`isActive`/`isSystem` separados | Correcto. Separa las tres razones distintas por las que una cuenta no admite un apunte |
| Copia del seed a la organización (plan propio, editable) en lugar de catálogo global compartido | Correcto y necesario para multi-tenant y para el requisito de renombrar/reclasificar |
| `analyticType` en `Account` **y** override en `JournalLine` | Correcto: default por cuenta, excepción por hecho económico |
| `OrganizationAccountMap` con `enum AccountKey` en vez de códigos cableados en el motor | Correcto y es la decisión de diseño más valiosa del bloque |
| `TaxRate` versionada por `(code, validFrom)` con cuenta y contrapartida | Correcto: absorbe cambios normativos sin desplegar código |
| Cobertura del seed: 906 filas, 0 cuentas oficiales de 3 dígitos ausentes en grupos 1–7 | Correcto. La base es sólida |
| Contenedores mixtos con `estado_financiero` vacío (1, 4, 5, 46–49, 55, 553, 559, 56, 58) | Correcto |

**Defectos de datos a corregir en `build_npgc.py` (bloquean el cierre de E2)**

| # | Defecto | Severidad |
|---|---|---|
| D-1 | `MAPEO` de 5530–5533 cruzado respecto a `NATURALEZA_OVERRIDE`: 5531/5533 en Activo siendo acreedoras y 5530/5532 en Pasivo siendo deudoras | A — infla Activo y Pasivo |
| D-2 | 190/192/194 (y 1034/1044) clasificados como deuda a corto plazo en lugar de Patrimonio neto | A — traslada una ampliación de capital al pasivo exigible |
| D-3 | Incoherencia sistemática `epigrafe` ↔ `tipo_analitico` en 670–672, 678, 693–695, 696–699, 770–772, 778, 793–799 | A — EBITDA y EBIT analíticos no conciliables con los contables |

**Carencias de esquema a resolver en `docs/MODELO-DATOS.md`**

| # | Carencia | Propuesta |
|---|---|---|
| E-1 | `TaxRate.ratePermille Int` no representa 1,75 % (recargo de tabaco) ni tipos con decimales | `rateBps Int` (puntos básicos) o `rateMicro Int` |
| E-2 | `Account` no distingue contra-cuentas (28x, 29x, 39x, 49x, 59x, 406, 437) | Campo `isContra Boolean @default(false)` + regla R-13 |
| E-3 | `Account.statement` es fijo; 551/552/554/555 y 553 son **bidireccionales** por naturaleza | Campo `bidirectional Boolean` + reclasificación por signo en el generador de balance, con las dos rutas (`statementIfDebit`, `statementIfCredit`) |
| E-4 | `AccountKey` (16 claves) no cubre los asientos tipo de E3/E8 | +41 claves propuestas en §3.2 |
| E-5 | No hay parámetro de prorrata ni de método de redondeo por organización | `Organization.prorrataPermille?`, `Organization.taxRoundingMode` (`PER_TIPO` \| `PER_LINEA`), `Organization.redondeoToleranciaCents` |
| E-6 | `importNPGC` no tiene contrato de variante ni de subcuentas | Firma y reglas de §2.4; la variante `PYMES` hoy no está especificada en ninguna parte |

**Nada de lo anterior invalida el modelo.** Las correcciones D-1..D-3 son cambios en el generador del seed (Nivel 1, con test de regresión sobre las 906 filas); E-1..E-6 son cambios de esquema Prisma que, al tocar el motor contable y los informes, **requieren ADR y aprobación humana (Nivel 2)** antes de merge.

---

## 7. Respuestas al arquitecto (C-1 … C-7)

### C-1 — Subconjunto PYMES y epígrafe abreviado

**Decisión: dos columnas, y el subconjunto ya está resuelto en el seed.** `seeds/build_npgc.py` incorpora las reglas P-01…P-13 (§2.1) y genera cuatro columnas nuevas: `pymes` (0/1), `epigrafe_pymes`, `bidireccional` e `is_contra`. Sí difiere el epígrafe: PGC PYMES usa numeración propia (§2.2 y §2.3) — la PyG desplaza las líneas 13→12 … 20→19 y el balance elimina "Activos no corrientes mantenidos para la venta" y renumera todo el activo/pasivo corriente. Un solo campo de epígrafe obligaría a reimportar el plan si la organización cambiara de variante; con dos columnas `importNPGC` elige y **T2 queda desbloqueada** (la regla provisional del arquitecto sobrevaloraba la exclusión: los subgrupos 15/16/17 de partes vinculadas **sí** existen en PYMES).

### C-2 — IVA: una fila o dos; recargo de equivalencia

**Decisión: UNA fila por tipo, con las dos cuentas (`accountCode` = repercutido 477, `counterAccountCode` = soportado 472) y un campo nuevo `appliesTo: SALE | PURCHASE | BOTH`.** El tipo impositivo es el mismo hecho jurídico (21 % es 21 % se compre o se venda): duplicarlo en `IVA21_REP`/`IVA21_SOP` obliga a mantener dos filas sincronizadas ante cada cambio normativo y rompe el cuadre de la 303, que agrega por tipo, no por dirección. La dirección la determina el asiento tipo, no el impuesto. **Excepción**: la inversión del sujeto pasivo necesita ambas cuentas simultáneamente en el mismo asiento — motivo adicional para tener las dos en una sola fila.
**Recargo de equivalencia: fila propia**, no campo. Es un tributo distinto con su propia base de cálculo, su propia casilla en la 303 y su propio devengo; un campo `recargoPermille` dentro del tipo de IVA impediría versionarlo por separado. Se enlaza con `linkedTaxRateId` al tipo de IVA que lo acompaña (5,2 %↔21 %, 1,4 %↔10 %, 0,5 %↔4 %, 1,75 %↔labores del tabaco). **Cuenta: 477 con subcuenta recomendada `4770x`** para el vendedor (es IVA repercutido a efectos de la 303, no un tributo aparte en el mayor); para el minorista comprador **no hay cuenta**: el recargo soportado incrementa el precio de adquisición (600/6xx), como el IVA no deducible.
**Aviso de esquema: `ratePermille Int` no representa el 1,75 %.** Debe pasar a `rateBps Int` (175) antes de sembrar `TaxRate`.

### C-3 — IRPF: mismo código para emitidas y recibidas; alquileres

**Decisión: mismo `code` de retención, cuentas distintas resueltas por dirección, y sí, cuenta propia para alquileres.** `IRPF15` es un único tipo con `accountCode = 4751` (retención que practicamos e ingresamos en el Tesoro) y `counterAccountCode = 473` (retención que nos practican, crédito frente a Hacienda); la dirección la fija el asiento tipo, igual que en C-2. Duplicar el código haría imposible cuadrar el modelo 190 contra un solo tipo.
El 19 % de alquileres **no necesita una cuenta oficial nueva** — el PGC solo tiene 4751 — pero **sí necesita separación**, porque se declara en el modelo 115/180 y no en el 111. Con `useSubaccounts = true`, `importNPGC` crea `47510` (profesionales), `47511` (alquileres) y `47512` (trabajo y administradores), y las claves `IRPF_PROFESIONALES_A_PAGAR` / `IRPF_ALQUILERES_A_PAGAR` / `IRPF_TRABAJO_A_PAGAR` apuntan a ellas. Con `false`, las tres apuntan a 4751 y el cuadre por modelo se hace agrupando por `taxRateId`.

### C-4 — ¿ADMIN puede cambiar `statement`/`epigrafe` de una cuenta oficial de nivel ≤ 3?

**Decisión: bloqueado para `statement`; permitido para `epigrafe` con ADMIN + motivo + `AuditLog`.** Cambiar el `statement` mueve masa patrimonial entre Activo/Pasivo/PN y rompe simultáneamente I2 y I3: ninguna razón legítima lo requiere, porque el destino correcto siempre se consigue creando una subcuenta con la clasificación adecuada (que es libre desarrollo permitido por la parte quinta del PGC). El `epigrafe`, en cambio, admite juicio profesional dentro de la misma masa (p. ej. llevar 629 a "Otros gastos de gestión corriente" en vez de "Servicios exteriores"), no altera ningún invariante y por tanto se permite con trazabilidad. Regla R-10 de §5 actualizada en consecuencia. **Además: prohibido en ambos casos si la cuenta tiene líneas en un ejercicio `CLOSED`** — reexpresaría cuentas anuales ya formuladas.

### C-5 — `tipo_analitico`: 75 → NO_ANALITICO, 71 → MC1, 64 → MC2

**Decisión: 71 correcto (sin cambio); 75 correcto como default pero debe ser configurable; 64 correcto y NO debe repartirse por CECO.** `71x` es un coste negativo del margen bruto: `COSTE_DIRECTO_MC1` con naturaleza acreedora es aritméticamente exacto; solo hay que rotularlo en la UI para que no se lea como "coste negativo" erróneo. `75x` (ingresos accesorios: arrendamientos, comisiones, servicios al personal) no procede de proyectos y ensuciaría el MC1 — pero una organización que subarriende espacio como línea de negocio necesita moverlo a `INGRESO_DIRECTO`: default `NO_ANALITICO`, editable por organización, igual que `73x` y `74x` (§1.3).
`64x` se queda en `COSTE_DIRECTO_MC2` y **el reparto no lo decide la cuenta, lo decide la línea**: `JournalLine` ya lleva `projectId` XOR `costCenterId` más override de `analyticType`. Meter la lógica de reparto en el tipo de cuenta obligaría a duplicar 640/642 en "640-directo" y "640-indirecto", que es exactamente el antipatrón que la dimensión analítica evita. La nómina de una persona que trabaja en tres proyectos y en G&A se resuelve con cuatro líneas del mismo asiento, no con cuatro cuentas.

### C-6 — ¿Crear por defecto 4720/4770?

**Decisión: NO por defecto (`createSoftwareAccounts = false`).** No son cuentas oficiales del PGC y una PYME con un solo tipo de IVA no las necesita; crearlas de oficio ensucia el plan con cuentas vacías que el usuario no entiende. Se crean bajo demanda, y **automáticamente** en dos supuestos que sí las exigen: (a) la organización da de alta más de un tipo de IVA con `TaxRate` simultáneamente vigente y quiere el mayor desglosado, o (b) activa la inversión del sujeto pasivo / adquisiciones intracomunitarias, donde el doble apunte 472/477 sobre la misma cuenta hace ilegible el mayor. En ambos casos se crean como subcuentas de 472/477 (libre desarrollo), nunca como cuentas de nivel 3.

### C-7 — ¿Histórico de tipos (IVA 18 %, 16 %) en el seed?

**Decisión: NO en el seed; mecanismo de vigencia y carga bajo demanda.** El ERP nace para ejercicios abiertos: sembrar tipos derogados hace más de una década pobla el selector de impuestos con opciones que solo pueden generar errores de usuario. `TaxRate` ya está versionada por `(code, validFrom)`, así que una organización que migre contabilidad antigua carga `IVA18` con `validFrom = 2010-07-01`, `validTo = 2012-08-31` desde el editor, sin desplegar código. **Sí debe sembrarse la vigencia explícita de los tipos actuales** (`validFrom = 2025-01-01` para IVA 4 %/10 %/21 % tras el fin de las rebajas temporales de 2022-2024) para que un asiento con fecha de 2024 no coja por error el tipo de 2026.

### Estado del seed tras las correcciones

`seeds/build_npgc.py` corregido y `seeds/npgc.csv` regenerado (D-1, D-2, D-3 y 555 cerrados; columnas `bidireccional`, `is_contra`, `pymes`, `epigrafe_pymes` añadidas). Validaciones del script en verde: 0 duplicados, 0 padres huérfanos, 0 padres filtrados con hijo superviviente en PYMES, 0 epígrafes PYMES sin traducir, y el nuevo `validate_analytic_coherence()` que verifica que el tipo analítico de toda cuenta 6/7 pertenece al bloque de PyG de su epígrafe.

| Métrica | Valor |
|---|---|
| Filas totales | 906 (sin cambio) |
| Cuentas en PGC PYMES (`pymes = 1`) | 794 |
| Excluidas de PYMES | 112 (62 de grupos 8/9 + 50 de los grupos 1–7) |
| Bidireccionales | 7 (551, 552, 5523, 5524, 5525, 554, 555) |
| Contra-cuentas (`is_contra = 1`) | 165 |
| `tipo_analitico` | INGRESO_DIRECTO 25 · COSTE_DIRECTO_MC1 36 · COSTE_DIRECTO_MC2 12 · INDIRECTO_CECO 41 · AMORTIZACION_DETERIORO 21 · FINANCIERO 149 · NO_ANALITICO 23 · **EXTRAORDINARIO 0** |

> `EXTRAORDINARIO` queda **sin uso en el seed a propósito**: el PGC 2007 suprimió el resultado extraordinario y ninguna cuenta oficial le corresponde. Se conserva en el enum `AnalyticType` para overrides por organización y para el CECO `EXTRAORDINARIO`.
