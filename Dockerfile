# syntax=docker/dockerfile:1
FROM node:26-slim AS base

ENV PORT=7331
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV DEBIAN_FRONTEND=noninteractive

# ── Dependencies (cached unless package.json or prisma schema changes) ──
FROM base AS deps
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends openssl
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies, including devDependencies (the `prisma` CLI needed
# by `prisma generate` in the build stage below is a devDependency; the
# runtime stage never sees this override since it starts fresh `FROM base`).
ENV NODE_ENV=development
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# ── Build ──
FROM base AS builder
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends openssl
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./
COPY . .

# CI pre-generates prisma/client natively (see workflows) and sets
# SKIP_PRISMA_GENERATE=true so get-dmmf never runs under QEMU emulation.
# Local single-platform builds run prisma generate here (natively, safe).
ARG SKIP_PRISMA_GENERATE=false
RUN if [ "${SKIP_PRISMA_GENERATE}" != "true" ]; then npx prisma generate; fi

# E3 (#4): el git-sha del build viaja en el bundle (next.config.ts lo lee de
# GIT_SHA y, si falta, de `git rev-parse HEAD`, que aquí no existe porque no se
# copia el .git). Sin él, el sello de validación no puede afirmar que el motor
# no ha cambiado y marca REQUIERE REVISIÓN, que es lo correcto pero inútil en
# producción: pásalo con `docker build --build-arg GIT_SHA=$(git rev-parse HEAD)`.
ARG GIT_SHA=desconocido
ENV GIT_SHA=${GIT_SHA}

RUN npm run build

# ── Runtime ──
FROM base AS runner
ARG GIT_SHA=desconocido
ENV GIT_SHA=${GIT_SHA}
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    cron \
    ghostscript \
    graphicsmagick \
    libwebp-dev \
    openssl \
    postgresql-client
WORKDIR /app
RUN mkdir -p /app/data /app/upload

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/app ./app
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/models ./models
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/next.config.ts ./

COPY docker-entrypoint.sh docker-cron-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/docker-cron-entrypoint.sh

EXPOSE 7331
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "start"]
