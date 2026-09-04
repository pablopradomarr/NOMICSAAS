---
description: Auditoría adversarial de cifras en contexto limpio sobre un fixture, informe, migración o rama. Uso - /auditar <ruta a fixture/resultado o rama>
---

Objeto a auditar: $ARGUMENTS

Lanza el agente `auditor-fiabilidad` pasándole ÚNICAMENTE: (1) ruta del snapshot/fixture de entrada, (2) ruta del resultado o el diff (`git diff main...<rama>`), (3) `provenance.json` / `validacion.json` si existen. NO le pases este hilo ni razonamientos previos.

Al recibir el veredicto:
- CONFORME → registra en `runs/registro.jsonl` (`tipo: "auditoria"`, veredicto, cifras reconstruidas) y devuelve el veredicto tal cual.
- DISCREPANCIA / NO_VERIFICABLE → crea una tarea `REQUIERE_INTERVENCION` con los hallazgos y no marques nada como validado.
