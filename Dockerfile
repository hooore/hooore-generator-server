FROM node:22.9.0-bookworm AS base

FROM base AS builder

WORKDIR /app

COPY package*json yarn.lock* package-lock.json* pnpm-lock.yaml* tsconfig.json ./

# https://github.com/pnpm/pnpm/issues/9029
# https://github.com/nodejs/corepack/issues/612
RUN npm install -g corepack@latest

RUN corepack enable
RUN corepack prepare pnpm --activate
RUN pnpm install --frozen-lockfile

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

CMD ["node", "/app/dist/index.mjs"]