-- E12 · T15 — **el comentario de `organizations`, con las DOS cosas que dice**.
--
-- La migración `20260930091000` reescribió `COMMENT ON TABLE organizations` para
-- dejar constancia de que `storage_used` y `storage_limit` se habían retirado…
-- y al hacerlo **borró la marca `prorrata_bps:convertido`** que
-- `20260907120000` escribió ahí a propósito: es la señal de que la prorrata está
-- en puntos básicos y no por mil (O-7 de E3), y lo que impide que un backfill
-- posterior la vuelva a multiplicar por diez. Lo destapó
-- `tests/integration/e3-backfill-prorrata.test.ts`, que comprueba la marca.
--
-- Un comentario de tabla es un sitio estrecho para dos mensajes, pero **la marca
-- manda**: es un dato operativo del que depende una migración, no una nota. Se
-- restaura íntegra y la explicación de E12 va detrás.
--
-- Se corrige con una migración NUEVA y no editando la anterior: una migración
-- aplicada no se toca (CLAUDE.md). Ejecutable por rol NO superusuario.

COMMENT ON TABLE "organizations" IS
  'Organizaciones (tenant raíz). prorrata_bps:convertido — la prorrata está en PUNTOS BÁSICOS (90 % = 9000), O-7 de E3. '
  'E12 · T15: el almacenamiento usado y su techo ya NO viven aquí (storage_used / storage_limit retiradas). El usado se '
  'DERIVA de stored_objects (models/usage.ts, filtrando por kind, O-12c) y el techo lo pone maxStorageBytes del plan: '
  'una segunda copia viva del mismo dato es lo que P2 prohíbe.';
