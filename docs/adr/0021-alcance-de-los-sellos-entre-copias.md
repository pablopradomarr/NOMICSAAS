# ADR-0021 — Qué sello sobrevive a una COPIA: alcance de los hashes entre bases

**Estado:** **APROBADO por Pablo** (permiso general delegado de 2026-09-04)
**el 2026-09-21** · **Nivel:** 2 ·
**Fecha:** 2026-09-21 · **Épica:** E12 ·
**Diseño:** `docs/design/E12-fiabilidad-dod.md` §4.2 y §6 ·
**Complementa:** ADR-0011 (forma canónica de los hashes), ADR-0012 (motivos de
sello), ADR-0019 D3 (el almacén de objetos y la copia) ·
**No enmienda ninguno.** Ni una tupla de ADR-0011 cambia.

> **Por qué existe este fichero y no un párrafo dentro de ADR-0011.** La nota
> nació el 2026-09-21 **dentro** de ADR-0011, y el revisor de la ronda 1 la
> señaló con razón: `CLAUDE.md` declara los ADR inmutables, y el precedente
> —«se puede editar un ADR si la nota es buena»— cuesta más caro que la comodidad
> de tenerla al lado. El contenido es el mismo, aprobado y fechado; lo que cambia
> es dónde vive. En ADR-0011 queda una línea que apunta aquí.

---

## Contexto

**ADR-0011** razona la comparabilidad **entre organizaciones y entre cargas del mismo
fixture**. E12 añadió un tercer escenario que no estaba contemplado: **la copia
restaurada** (`tests/acceptance/reconstruccion-backup.test.ts`, criterio 35).
Restaurar genera filas nuevas, así que **todo uuid cambia**. De ahí:

| Sello | ¿Sobrevive a una restauración? | Por qué |
|---|---|---|
| **`ledgerHash`** (v2) | **Sí**, byte a byte | Su tupla es contenido contable puro: ni un uuid. Es exactamente el efecto que este ADR buscaba |
| **`planHash`**, **`accountMapHash`**, **`configHash`** | **Sí** | Se componen sobre códigos de cuenta y valores de configuración, no sobre claves de fila |
| **`entryHash`** (v2) | **No**, y es correcto | Es un sello de FILA: su oficio es detectar cualquier mutación de ESE asiento en ESA base. Fuera de ella no significa nada |
| **`analyticsKey` de `InvariantRun`** | **No** | Su forma canónica (`canonicalAnalyticsForm`) lleva `entryId`, `projectId`, `costCenterId` y `businessLineId`, que son uuid |
| **`analyticsKey` de `computeContentSeals`** (el del manifest del backup) | **Sí** | Se compone sobre **claves naturales** —código de proyecto, de CECO y de línea de negocio— y es el que la comprobación 5 de la restauración verifica |

**La decisión, escrita.** El sello analítico **comparable entre copias es el de
claves naturales**, el del manifest. El de `InvariantRun` **no se alinea con él**:

- alinearlos exige reescribir `canonicalAnalyticsForm`, y eso **invalidaría todos
  los `analyticsKey` ya emitidos**, que es precisamente lo que este ADR prohíbe
  («v2 no se toca nunca más: cualquier cambio futuro de forma exige una versión
  nueva y convivencia de ambas, jamás una reescritura»);
- y no haría falta: el oficio del `analyticsKey` de `InvariantRun` es **la clave
  de caché de un barrido dentro de una base** —decir si la analítica se ha movido
  desde el barrido anterior—, no viajar entre bases. Para eso está el del
  manifest, que sí existe y sí se enfrenta.

Corolario operativo, que amplía el de arriba: **un sello que deba ser comparable
entre COPIAS no puede llevar uuid, y si su oficio es de caché local, puede y
debe llevarlos.** Los dos `analyticsKey` no son una duplicación por descuido:
son dos oficios distintos, y esta nota los nombra para que nadie los «arregle»
haciéndolos uno.

La consecuencia visible —la lista de sellos que una restauración compara y la que
no— está escrita para humanos en `README-FIABILIDAD.md` §3.
