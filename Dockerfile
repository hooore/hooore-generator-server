FROM node:22.9.0-bookworm AS base

FROM base AS builder

WORKDIR /app

COPY package*json yarn.lock* package-lock.json* pnpm-lock.yaml* tsconfig.json ./
RUN corepack enable pnpm && pnpm i

COPY . .
RUN npm run build

FROM base AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 hono

COPY --from=builder --chown=hono:nodejs /app/node_modules /app/node_modules
COPY --from=builder --chown=hono:nodejs /app/dist /app/dist
COPY --from=builder --chown=hono:nodejs /app/package.json /app/package.json
COPY --chown=hono:nodejs Dockerfile.generator /app/Dockerfile.generator

USER hono

ARG PORT=3000
EXPOSE ${PORT}

ENV NODE_TLS_REJECT_UNAUTHORIZED=0
CMD ["node", "/app/dist/index.mjs"]