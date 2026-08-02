# ── Build stage ───────────────────────────────────────────────
FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies first (cached layer)
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY src/ ./src/

# ── Runtime ───────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/src ./src
COPY package.json ./

EXPOSE 3000

# Runs migrations + seed + starts server
CMD ["node", "src/server.js"]
