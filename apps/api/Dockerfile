FROM node:22-alpine AS build
WORKDIR /app
ENV DATABASE_URL=postgresql://flowboard:flowboard_local@localhost:5432/flowboard?schema=public
COPY package*.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --ignore-scripts
COPY apps/api ./apps/api
COPY prisma.config.ts ./
RUN npm run db:generate --workspace @flowboard/api && npm run build --workspace @flowboard/api

FROM build AS database-tools
CMD ["sh", "-c", "npm run db:migrate --workspace @flowboard/api && npm run db:seed --workspace @flowboard/api"]

FROM node:22-alpine AS production-dependencies
WORKDIR /app
ENV DATABASE_URL=postgresql://flowboard:flowboard_local@localhost:5432/flowboard?schema=public
COPY package*.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/package.json ./package.json
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
