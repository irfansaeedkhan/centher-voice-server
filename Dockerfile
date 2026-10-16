# ---- Builder: installs deps, compiles the mediasoup native worker
#      (needs python3/make/g++), and builds TypeScript ----
FROM node:20-bookworm AS builder
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# Drop dev dependencies for the runtime image
RUN npm prune --omit=dev

# ---- Runner: slim image, prebuilt worker binary copied over ----
FROM node:20-bookworm-slim
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
EXPOSE 3001
CMD ["node", "dist/index.js"]
