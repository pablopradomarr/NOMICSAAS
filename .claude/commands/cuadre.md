---
description: Ejecutar los invariantes contables I1–I10 sobre los fixtures (o una BD si DATABASE_URL está definida) y reportar validacion.json. Uso - /cuadre [fixture|db]
---

Modo: $ARGUMENTS (por defecto: fixtures)

1. Ejecuta `npm run test -- lib/ledger/invariants` y, si el modo es `db`, `npx tsx scripts/run-invariants.ts --org <id>`.
2. Muestra la tabla `| Check | Estado | Evidencia |` a partir de `validacion.json`.
3. Cualquier FAIL → explica qué asiento/registro lo provoca (query de `registros_origen`) y propone corrección por contra-asiento; nunca propongas editar o borrar un asiento existente.
