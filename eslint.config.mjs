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

/**
 * E3-T3 (ADR-0009): con la RLS estricta, una consulta de negocio que salga del
 * cliente sin tenant NO da error — devuelve vacío en silencio, que es mucho peor.
 * `no-restricted-imports` ya impide importar `prisma` fuera de la lista blanca;
 * esto cierra el otro flanco, DENTRO de esa lista blanca: los cuatro modelos que
 * sí pueden importarlo sólo tienen permitido usarlo para invocar las funciones
 * `SECURITY DEFINER` (`$queryRaw`), nunca para tocar un delegado de negocio.
 */
const BUSINESS_DELEGATES = [
  "setting",
  "category",
  "project",
  "field",
  "file",
  "transaction",
  "appData",
  "progress",
  "membership",
  "invitation",
  "organization",
  "currency",
  "ledgerAccount",
  "organizationAccountMap",
  "taxRate",
  "auditLog",
];

const NO_BARE_PRISMA_DELEGATE = {
  selector: `MemberExpression[object.name="prisma"][property.name=/^(${BUSINESS_DELEGATES.join("|")})$/]`,
  message:
    "`prisma.<modelo>` no fija app.current_org/app.current_user: con RLS estricta (ADR-0009) devuelve VACÍO en silencio. " +
    "Usa tenantDb(orgId), tenantTransaction(orgId, …) o withTenantGucs(orgId|null, userId, …).",
};

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
  {
    // La lista blanca de `no-restricted-imports` incluida: aquí `prisma` sólo
    // vale para `$queryRaw` sobre las funciones `SECURITY DEFINER` de `app.`.
    files: ["models/**/*.ts", "app/**/*.ts", "app/**/*.tsx", "ai/**/*.ts", "lib/**/*.ts", "forms/**/*.ts"],
    ignores: ["lib/db.ts", "lib/db.test.ts", "lib/email-sync/ingest.test.ts"],
    rules: {
      "no-restricted-syntax": ["error", NO_BARE_PRISMA_DELEGATE],
    },
  },
];

export default eslintConfig;
