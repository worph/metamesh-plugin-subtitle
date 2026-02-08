# MetaMesh Plugin: subtitle
# Processes subtitle files and links

FROM node:20-slim AS builder

# Install git for GitHub dependencies
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g corepack@latest && corepack enable

WORKDIR /app

# Copy package files first for layer caching
COPY package.json pnpm-lock.yaml ./
RUN corepack install
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Build the git dependency (filename-tools)
RUN cd node_modules/@metazla/filename-tools && pnpm install && pnpm run build

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm run build

# Production image
FROM node:20-slim

# Install git for GitHub dependencies
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g corepack@latest && corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack install
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

# Build the git dependency in production too
RUN cd node_modules/@metazla/filename-tools && pnpm install && pnpm run build

COPY --from=builder /app/dist ./dist

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "dist/index.js"]
