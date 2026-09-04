---
description: Ejecutar las tareas de una épica ya planificada (implementación → QA → revisión → auditoría → registro). Uso - /sprint <id de épica>
---

Épica: $ARGUMENTS

Actúa como `orquestador`. Requisito: existe `docs/design/<id>-*.md` y no hay ADR Nivel 2 en estado PROPUESTO para esta épica (si lo hay, para y pide firma).

Por cada tarea pendiente, en orden de dependencias (paralelizando las independientes):
1. `dev-backend` o `dev-frontend` (según tarea) con: diseño, tarea concreta, ficheros afectados. Exige salida real de `npm run lint && npm run test`.
2. `qa-tester` sobre el resultado: suite completa + invariantes + tenant leak. FAIL → vuelve al dev con el reporte (máx. 2 iteraciones; después, `REQUIERE_INTERVENCION`).
3. `revisor-codigo` en contexto limpio con `git diff main...HEAD`. `CAMBIOS REQUERIDOS` → vuelve al dev. `BLOQUEADO` → para.
4. Si la tarea toca `lib/ledger`, `lib/analytics`, informes, OCR o migraciones de datos: `auditor-fiabilidad` en contexto limpio con fixtures de `tests/fixtures/` y el resultado. DISCREPANCIA → `REQUIERE_INTERVENCION`.
5. Marca la tarea completada (TaskUpdate) solo con todo en verde. Commit atómico en español.

Al terminar: `documentador` actualiza docs y ROADMAP; añade línea a `runs/registro.jsonl`; informe ≤ 15 líneas con tabla de tareas/estado, tests, veredictos y pendientes de firma.
