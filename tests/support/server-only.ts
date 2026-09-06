/**
 * Doble de `server-only` para vitest.
 *
 * El paquete real no exporta nada: es un centinela que Next resuelve a un
 * módulo que **lanza** si alguien lo importa desde el cliente. En los tests de
 * integración no hay bundler que lo resuelva, y sin este alias un fichero de
 * servidor legítimo —`ai/queue.ts`, que las server actions de E8 importan— no
 * se puede probar. Vacío a propósito: la garantía la da Next en el build, no
 * el test.
 */
export {}
