# syntax=docker/dockerfile:1

# carry — production container.
#
# Two stages:
#   1. build   — full glibc Node image; compiles TypeScript -> dist/.
#   2. runtime — slim glibc Node image; installs ONLY prod deps fresh and runs dist/.
#
# Why bookworm (glibc) and NOT alpine (musl): the `@libsql/client` dependency ships
# a native binding. The prebuilt binary targets glibc; on musl/alpine it fails to load
# at runtime. Keep both stages on Debian bookworm so the libsql binary matches the OS.
#
# Why we do NOT copy node_modules out of the build stage: native deps are compiled
# for the stage they were installed in. We reinstall prod deps in the runtime stage
# so the correct-platform libsql binary is present. dist/ (pure JS) is safe to copy.

# ---------- Stage 1: build ----------
FROM node:22-bookworm AS build
WORKDIR /app

# Install ALL deps (incl. dev: typescript) against a cached lockfile layer.
COPY package.json package-lock.json ./
RUN npm ci

# Compile TypeScript -> dist/ (tsconfig sets rootDir src, outDir dist).
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- Stage 2: runtime ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Reinstall production deps ONLY, fresh, so libsql's native binary is built/fetched
# for THIS image (not carried over from the build stage's node_modules).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Bring over the compiled JS only.
COPY --from=build /app/dist ./dist

# Run as the built-in unprivileged `node` user, not root.
USER node

# Render provides PORT at runtime; the app reads process.env.PORT (default 8080).
# EXPOSE documents the local default; Render maps its own port regardless.
EXPOSE 8080

# Liveness: hit the app's own /healthz with Node's global fetch (no curl in slim).
# Honors PORT if Render/compose overrides it; falls back to 8080 locally.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
