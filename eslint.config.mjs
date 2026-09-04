import nextConfig from "eslint-config-next";

/**
 * Ficheros autorizados a importar el cliente Prisma SIN acotar a organización.
 * Son los que resuelven QUÉ organización (o son pre-tenant: auth y perfil) y por
 * tanto no pueden estar acotados a una. Cualquier otro `models/` o `app/` debe
 * usar `tenantDb(orgId)` — barrera 1 de aislamiento multi-tenant (ADR-0002).
 */
const TENANT_FREE_MESSAGE =
  "Usa tenantDb(orgId) / requireOrg(). El cliente sin tenant sólo se permite en lib/db.ts, lib/auth.ts, lib/email-sync/ingest.ts, models/{users,organizations,memberships,invitations}.ts y scripts.";

const TENANT_FREE_FILES = [
  "lib/db.ts",
  "lib/db.test.ts",
  "lib/auth.ts",
  "lib/email-sync/ingest.ts",
  "lib/email-sync/ingest.test.ts",
  "models/users.ts",
  "models/organizations.ts",
  "models/memberships.ts",
  "models/invitations.ts",
  "app/(app)/apps/email/scripts/**",
  "seeds/**",
  "scripts/**",
];

const eslintConfig = [
  ...nextConfig,
  {
    ignores: ["prisma/client/**"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "@typescript-eslint": nextConfig[1].plugins["@typescript-eslint"],
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
    },
  },
  {
    // E1-fix (#20): `lib/**` estaba fuera del alcance de la regla, de modo que
    // cualquier helper podía importar el cliente sin acotar sin que saltara nada.
    files: [
      "models/**/*.ts",
      "app/**/*.ts",
      "app/**/*.tsx",
      "ai/**/*.ts",
      "components/**/*.tsx",
      "lib/**/*.ts",
      "forms/**/*.ts",
    ],
    ignores: TENANT_FREE_FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/db",
              importNames: ["prisma"],
              message: TENANT_FREE_MESSAGE,
            },
          ],
          // `import * as db from "@/lib/db"` esquivaba la regla por nombre:
          // el patrón la cierra (#20).
          patterns: [
            {
              group: ["@/lib/db", "**/lib/db"],
              importNamePattern: "^prisma$",
              message: TENANT_FREE_MESSAGE,
            },
          ],
        },
      ],
    },
  },
];

export default eslintConfig;
