# Builds api/dist and web/dist, then ships one Node process that serves
# both the API and the built frontend (see api/src/server.ts) -- matches
# the plan's "one Node process + one SQLite file on a volume" shape.
# node:sqlite (used by api/src/db.ts) is a stable, unflagged builtin as of
# Node 24, so no --experimental-sqlite flag and no native module build.

FROM node:24-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json
RUN npm ci

COPY api api
COPY web web
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/api/package.json api/package.json
COPY --from=build /app/api/dist api/dist
COPY --from=build /app/web/dist web/dist

EXPOSE 4000
CMD ["node", "api/dist/server.js"]
