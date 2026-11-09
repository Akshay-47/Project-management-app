#!/bin/sh
# Run on Railway: migrate, seed (idempotent), then start API
set -e
echo "Running migrations..."
npx prisma migrate deploy
echo "Running seed (idempotent)..."
npx tsx prisma/seed.ts
echo "Starting API..."
exec node apps/api/dist/server.js
