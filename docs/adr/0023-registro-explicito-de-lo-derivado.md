# ADR-0023 — Lo derivado se DECLARA tabla a tabla; el criterio estructural sólo acusa

**Estado:** **APROBADO por Pablo** (permiso general delegado de 2026-09-04)
**el 2026-09-21** · **Nivel:** 2 ·
**Fecha:** 2026-09-21 · **Épica:** E12 (ronda 2 de corrección) ·
**Revisión que lo motiva:** `docs/design/E12-revision-ronda1.md` · hallazgo **A** ·
**Alcance:** **sólo `purgeDerived`**. La regla E-4 («todo inventario se deriva,
nunca se escribe a mano») sigue vigente tal cual para el **backup**
(`backupInventory` desde `TENANT_MODELS`), para `--reset-org`, para
`derivedSealColumns()` y para cualquier inventario futuro. Este ADR **no** la
deroga: la excluye de un sitio, y dice por qué ese sitio es distinto.

---

## Contexto

La regla **E-4** nació de un error repetido cuatro veces (BUG-E7-1, BUG-E9-5,
BUG-E10-1, BUG-E11-2): una lista de tablas escrita a mano que alguien olvidó
actualizar cuando la épica siguiente añadió una tabla. La cura fue derivar los
inventarios del esquema, y para el backup y el `--reset-org` funciona: la
pregunta que esas listas responden es **«¿qué tablas hay?»**, y esa pregunta el
esquema la contesta entera y sin ambigüedad.

`purgeDerived` responde otra pregunta: **«¿qué es caché y qué es fuente?»**. Eso
el esquema no lo sabe. La ronda 1 midió el criterio estructural que se estaba
usando —nombre acabado en `_runs`/`_sweeps`, o columna `*_hash` de origen— contra
las tablas reales:

| | |
|---|---|
| Candidatas que el criterio acusaba | **9** |
| Excepciones que había que escribir a mano de todos modos | **4** |
| Acierto | **menos de la mitad** |

`extraction_runs` es la procedencia de un asiento (P1, I-E8-11) y no se puede
recomputar: el modelo ya no existe y el prompt cambió. `cron_runs` es la clave de
idempotencia `(job, periodKey)`: borrarla haría que un job ya devengado volviera
a ejecutarse. `onboarding_runs` registra un alta que ocurrió una vez.
`closing_runs` es derivada **sólo en parte**: un cierre `CERRADO` o `REABIERTO` es
un hecho contable, un `BORRADOR` es un intento.

Y el modo de fallo no es simétrico. Una tabla que el backup olvida se nota al
restaurar. **Una tabla que `purgeDerived` borra por parecer caché es un hecho
contable destruido**, y el test de «memoria borrada» lo celebraría: las cifras
volverían a salir idénticas, porque lo que se perdió no era una cifra.

## Decisión

**D1 · El registro es explícito y lleva motivo.** `DERIVED_MODELS` enumera, tabla
a tabla, lo que `purgeDerived` borra, con una frase que dice **por qué se puede
recomputar desde la fuente**. `where` acota las filas cuando la tabla es derivada
sólo en parte (`closing_runs`). Una tabla se purga **si y sólo si** está ahí.

**D2 · Lo que parece caché y es fuente también se declara**, en
`FUENTES_AUNQUE_LO_PAREZCAN`, con su motivo. No es una lista de exclusiones: es
la mitad simétrica del registro, y es la que impide que el detector acuse al
mismo inocente en cada ronda.

**D3 · El criterio estructural se conserva como DETECTOR, y no borra nada.**
`pareceCache()` sigue existiendo y `tablasSinDeclarar()` nombra las tablas de
tenant que el detector acusa y **nadie ha declarado** en ninguna de las dos
listas. La suite de aceptación falla nombrándolas. Lo que E-4 compraba —que una
tabla nueva no se quede fuera en silencio— se conserva entero; lo que cambia es
que la salida del detector es **una decisión obligatoria**, no un `DELETE`.

**D4 · El criterio 34 y `I-E12-1` se reescriben** para decir lo que el código
hace. Un criterio de aceptación que ya no es cierto y cuyo test ha desaparecido
es deuda invisible, que es exactamente lo que la enmienda **E-1** y el estándar
«sin deuda que se acumule» existen para impedir.

**D5 · El test no puede ser más débil que el que sustituye.** El test borrado
afirmaba «una tabla derivada nueva entra sola en la lista». El que lo sustituye
afirma tres cosas, y las tres se ejercen con una tabla ficticia:

 1. una tabla de caché **sin declarar** se detecta, se nombra y **no se purga**;
 2. una tabla de caché **declarada derivada** entra en la lista de purga **sin
    tocar una línea de código** más que su propia declaración —que es el
    automatismo que E-4 compraba, movido de «el esquema decide» a «declararla
    basta»—;
 3. una tabla **declarada fuente** no entra en la lista y deja de ser acusada.

## Consecuencias

- **Añadir una tabla derivada cuesta una entrada con motivo**, no cero. Es el
  precio, y es deliberado: la frase que hay que escribir es la que obliga a
  pensar si de verdad se recomputa.
- **Olvidarla sigue sin ser posible en silencio**: el detector la nombra y la
  suite se pone roja. La diferencia con E-4 es qué pasa después del aviso.
- **El registro es auditable de un vistazo**: nueve líneas con motivo dicen qué
  recuerda el sistema haber calculado, que es justo lo que P4 pide poder afirmar.
- **E-4 no se toca en ningún otro sitio.** Si alguien propone lo mismo para el
  backup, la respuesta es no: allí la pregunta sí la contesta el esquema, y allí
  el modo de fallo es perder una tabla de la copia, no destruir un hecho.

## Alternativas descartadas

- **Mantener el criterio estructural como decisor y ampliar las excepciones.** Es
  lo que había: cuatro excepciones sobre nueve candidatas. Una lista de
  excepciones del mismo tamaño que la lista que corrige no es una derivación, es
  un registro explícito escrito al revés y peor.
- **Marcar lo derivado en el esquema Prisma** (un `///` o un atributo). Mueve la
  declaración de sitio sin quitarla, la parte el modelo de datos, y deja el
  motivo fuera —que es lo único que hace el registro legible.
- **Dejar el criterio 34 como está y no escribir nada.** Es el hallazgo A: un
  criterio de aceptación deja de ser cierto, su test desaparece y ningún
  documento lo enmienda. Eso no es una alternativa, es la deuda.
