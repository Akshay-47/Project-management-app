FROM node:22-alpine AS base
WORKDIR /app
ENV DATABASE_URL=postgresql://flowboard:flowboard_local@localhost:5432/flowboard?schema=public
COPY package*.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci
COPY apps/api ./apps/api
COPY prisma.config.ts ./
RUN npm run db:generate --workspace @flowboard/api && npm run build --workspace @flowboard/api
EXPOSE 3000
USER node
CMD ["sh", "-c", "npm run db:migrate --workspace @flowboard/api && npm run db:seed --workspace @flowboard/api && npm run start --workspace @flowboard/api"]
