FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/patch-re2.cjs ./scripts/patch-re2.cjs
RUN npm ci --no-audit --no-fund
COPY tsconfig*.json vite.config.ts index.html components.json ./
COPY server ./server
COPY shared ./shared
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 ENABLE_GOOGLE_WRITES=false
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/patch-re2.cjs ./scripts/patch-re2.cjs
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist-server/server/index.js"]
