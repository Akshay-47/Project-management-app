#!/bin/sh
# Run on Railway: migrate, seed (idempotent), then start API
set -e
echo "Running migrations..."
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
echo "Running seed (idempotent)..."
npx tsx apps/api/prisma/seed.ts
echo "Starting API..."
exec node apps/api/dist/server.js
