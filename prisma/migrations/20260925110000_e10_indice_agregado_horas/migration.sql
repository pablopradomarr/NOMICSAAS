-- E10 · ronda 1 — índice de cobertura del agregado de horas del ejercicio
--
-- Techo 7 de §9: «agregado de horas del EJERCICIO COMPLETO (120 000 partes)
-- < 600 ms, agregado SQL por (receptor, mes); jamás materializando los partes».
-- Medido con el volumen real, `minutesByTargetMonthSql` tardaba ~750 ms.
--
-- El motivo no es el agregado: son los predicados CONDICIONALES de la consulta
-- —`(<bool> = false OR t.status = 'APROBADO')`, ídem con `productive`—, que
-- hacen inservibles los índices PARCIALES `time_entries_approved_project` y
-- `time_entries_approved_ceco`, porque el planificador no puede demostrar que
-- la fila cumpla el `WHERE` del índice. Y no se pueden quitar: son los que
-- hacen que `/time` de un mes entre en su techo de 400 ms.
--
-- La salida es un índice de COBERTURA sobre la ventana de fechas, con todas las
-- columnas que el agregado lee en el `INCLUDE`: el escaneo pasa a ser
-- *index-only* y no toca la tabla. Aditivo, sin SUPERUSER y sin tocar datos.

CREATE INDEX IF NOT EXISTS "time_entries_org_date_cover"
  ON "time_entries" ("organization_id", "date")
  INCLUDE ("project_id", "cost_center_id", "minutes", "status", "productive");
