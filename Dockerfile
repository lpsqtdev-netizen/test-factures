FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV PORT=3000
ENV PETAL_STORE_PATH=/app/data/store.json
ENV PETAL_DATABASE_PATH=/app/data/store.sqlite

WORKDIR /app

COPY --chown=node:node package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --chown=node:node server.js index.html scripts ./ 
RUN mkdir -p /app/data && chown -R node:node /app

USER node
EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
