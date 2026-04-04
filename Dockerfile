FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages ./packages
COPY bin ./bin
COPY tsconfig.base.json tsconfig.eslint.json vitest.workspace.ts eslint.config.js ./
COPY packages/frontend/index.html ./packages/frontend/index.html
COPY packages/frontend/public ./packages/frontend/public

RUN npm ci
# Build packages in dependency order. npm ci has already created workspace
# symlinks (node_modules/@lintic/core → packages/core, etc.), so each tsc step
# makes dist/ visible to dependents immediately through the symlink.
RUN npx tsc -p packages/core/tsconfig.json
RUN echo "=== symlinks ===" && ls -la node_modules/@lintic/ \
  && echo "=== core/package.json ===" && cat packages/core/package.json \
  && echo "=== core dist ===" && ls packages/core/dist/ | head -5 \
  && echo "=== core/dist via symlink ===" && ls node_modules/@lintic/core/dist/ | head -5 \
  && echo "=== adapters/tsconfig.build.json ===" && cat packages/adapters/tsconfig.build.json
RUN npx tsc -p packages/adapters/tsconfig.build.json
RUN npx tsc -p packages/backend/tsconfig.build.json
RUN npx tsc -p packages/frontend/tsconfig.build.json --noEmit \
  && npx vite build packages/frontend --config packages/frontend/vite.config.ts
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3300

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/core/package.json ./packages/core/package.json
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/adapters/package.json ./packages/adapters/package.json
COPY --from=builder /app/packages/adapters/dist ./packages/adapters/dist
COPY --from=builder /app/packages/backend/package.json ./packages/backend/package.json
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder /app/packages/frontend/dist ./packages/frontend/dist

EXPOSE 3300

CMD ["node", "packages/backend/dist/index.js"]
