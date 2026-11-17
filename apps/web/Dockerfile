FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

COPY apps/web apps/web
COPY packages/shared packages/shared
COPY tsconfig.base.json ./
ARG VITE_API_BASE_URL=/api
ARG VITE_SENTRY_DSN=
ARG VITE_VAPID_PUBLIC_KEY
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_SENTRY_DSN=${VITE_SENTRY_DSN} \
    VITE_VAPID_PUBLIC_KEY=${VITE_VAPID_PUBLIC_KEY}
RUN npm run build --workspace=@firstwrite/shared \
    && npm run build --workspace=@firstwrite/web

FROM node:22-alpine AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/dist ./dist
COPY --from=build --chown=node:node /app/apps/web/server.mjs ./server.mjs
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
