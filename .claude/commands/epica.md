---
description: Planificar una épica del ROADMAP (diseño arquitectónico + validación contable + plan de tareas). Uso - /epica <id o nombre de épica>
---

Épica solicitada: $ARGUMENTS

Actúa como `orquestador`. Pasos:
1. Localiza la épica en `docs/ROADMAP.md`; lista dependencias y su estado. Si alguna dependencia está PENDIENTE (no diseñada ni en curso), para e informa; EN CURSO se admite si el ROADMAP lo indica.
2. Lanza el agente `arquitecto` con la épica, `CLAUDE.md`, `docs/SPEC-FUNCIONAL.md`, `docs/MODELO-DATOS.md` y las skills relevantes. Entregable: `docs/design/<id>-<slug>.md`.
3. Si la épica toca contabilidad/analítica/informes, lanza `experto-contable` en paralelo con el diseño para veredicto CONFORME/OBSERVACIONES/NO CONFORME. Itera con el arquitecto hasta CONFORME (máx. 2 rondas).
4. Si hay decisiones Nivel 2, asegúrate de que existe `docs/adr/NNNN-*.md` en estado PROPUESTO.
5. Crea las tareas atómicas con TaskCreate (una por tarea del plan, con dependencias).
6. Informe final ≤ 15 líneas: tabla de tareas, ADRs pendientes de firma, siguiente comando (`/sprint <id>`).
