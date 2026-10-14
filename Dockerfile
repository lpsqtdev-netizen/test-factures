FROM node:20-alpine

ENV NODE_ENV=production
ENV PORT=3000
ENV PETAL_STORE_PATH=/app/data/store.json

WORKDIR /app

COPY --chown=node:node package.json server.js index.html ./
RUN mkdir -p /app/data && chown -R node:node /app

USER node
EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
