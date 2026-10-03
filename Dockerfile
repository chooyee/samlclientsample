# Test SP for CloakTail (Acme Bank demo).
#   docker build -t samlclient-testsp .
#   docker run -p 4000:4000 -e SESSION_SECRET=... -v testsp-data:/app/data -v testsp-certs:/app/certs samlclient-testsp
# See "Run with Docker" in README.md.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=4000
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

# Settings, local profiles, legacy users and key pairs are written at runtime: keep them on volumes.
RUN mkdir -p data certs && chown -R node:node data certs
VOLUME ["/app/data", "/app/certs"]

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/saml/metadata').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "src/server.js"]
