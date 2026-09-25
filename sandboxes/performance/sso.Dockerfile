# Build once, deploy many - Next.js 15 with runtime environment variables
FROM node:22-alpine AS base

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --network-concurrency 4 --config.fetch-timeout=60000 --config.fetch-retries=1

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Disable Next.js telemetry during build
ENV NEXT_TELEMETRY_DISABLED=1
ENV STANDALONE=true

# Trusted browser origins. At runtime this drives CORS (middleware.ts); at build time
# it also drives the Server Actions allowlist in next.config.mjs. It has to be given
# here as well as at runtime, because `output: "standalone"` serialises next.config.mjs
# into the server at build time - a runtime value cannot reach it. A white-label build
# serving a non-pandahrms.com domain must pass its own origins, e.g.
#   --build-arg ACCESS_CONTROL_ALLOW_ORIGINS=https://hrms.mcsb.com.my
# Omitting it is safe: next.config.mjs still defaults to pandahrms.com and *.pandahrms.com.
ARG ACCESS_CONTROL_ALLOW_ORIGINS=""
ENV ACCESS_CONTROL_ALLOW_ORIGINS=$ACCESS_CONTROL_ALLOW_ORIGINS

# Build the application
# No other environment variables are baked into the build - they're provided at runtime
RUN pnpm build

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Create a non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy necessary files from builder
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Set correct permissions
RUN chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Start the application
# next-runtime-env will inject environment variables at runtime
CMD ["node", "server.js"]
