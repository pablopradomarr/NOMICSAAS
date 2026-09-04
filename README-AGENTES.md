# Sistema agéntico de arquitectura y desarrollo — MICRO ERP SAAS

Se ejecuta con **Claude Code** (`claude` en la raíz del repo). Todo vive en git: agentes, skills, comandos, docs, ADRs y log de runs.

## Mapa
```
CLAUDE.md                     reglas del proyecto (leído siempre)
.claude/agents/               9 agentes (orquestador, arquitecto, experto-contable, dev-backend, dev-frontend,
                              qa-tester, revisor-codigo, auditor-fiabilidad, documentador)
.claude/skills/               7 skills de dominio (fiabilidad, contabilidad-analitica, pgc-npgc, estados-financieros,
                              codebase-taxhacker, supabase-multitenant, ui-erp)
.claude/commands/             /epica  /sprint  /auditar  /cuadre
.claude/settings.json         permisos (allow/deny) + hook PreToolUse
.claude/hooks/guard.sh        bloquea ANTES de escribir: impurezas en lib/ledger y lib/analytics, edición de fixtures, ADRs aprobados, Float en importes
docs/spec/SPEC-FIABILIDAD.md  principios P1–P7, componentes C1–C7 (inmutable)
docs/AUDITORIA-FIABILIDAD.md  Fase 1 sobre TaxHacker: 22 gaps (6 ALTA)
docs/SPEC-FUNCIONAL.md        qué construimos · docs/ARQUITECTURA.md cómo · docs/MODELO-DATOS.md esquema
docs/ROADMAP.md               épicas E0–E12 · docs/adr/ decisiones (6 PROPUESTAS, pendientes de firma)
docs/design/                  diseños por épica (los genera /epica) · docs/manual/ manual de usuario
seeds/npgc.csv                cuadro de cuentas PGC 2007 (906 filas) · seeds/build_npgc.py
runs/registro.jsonl           log append-only de runs del equipo
tests/fixtures/               fixtures contables inmutables (los crea qa-tester en E3)
```

## Flujo de trabajo
```
/epica E1   → arquitecto (+ experto-contable si toca contabilidad) → docs/design/E1-*.md + ADR si Nivel 2 + tareas
   [firma humana de ADRs Nivel 2]
/sprint E1  → dev-backend / dev-frontend → qa-tester → revisor-codigo (contexto limpio)
              → auditor-fiabilidad (contexto limpio, solo si hay cifras) → documentador → runs/registro.jsonl
/auditar <fixture|rama>   auditoría adversarial puntual
/cuadre [fixture|db]      invariantes I1–I10 → validacion.json
```

## Reglas de gobernanza
- **Nivel 2** (ADR + firma de Pablo antes de codificar): motor contable, invariantes, esquema del diario, reglas de imputación, RLS, prompt del auditor, umbrales.
- **Nivel 1** (se implementa y se notifica): docs, tests, refactors con diff cero en cifras sobre fixtures.
- Ningún agente marca una tarea completada con tests rojos, sin revisión o con auditoría DISCREPANCIA.
- El auditor y el revisor nunca reciben la conversación del productor.

## Primeros pasos
1. Firmar (o comentar) `docs/adr/0001…0006` cambiando `Estado` a `APROBADO por Pablo el <fecha>`.
2. `claude` → `/epica E1` (organizaciones y roles; E0 está EN CURSO pero su parte bloqueante ya existe) → revisar `docs/design/E1-*.md` → `/sprint E1`. Completar el resto de E0 (CI, scripts de test, Docker/Supabase) dentro del primer sprint.
3. Configurar `DATABASE_URL` (Supabase) y `.env` según `README.md` de TaxHacker.

## Modelos recomendados por agente
opus: orquestador, arquitecto, experto-contable, auditor-fiabilidad · sonnet: dev-backend, dev-frontend, qa-tester, revisor-codigo, documentador (opus en tareas de `lib/ledger`).
