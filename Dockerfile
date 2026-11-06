# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN mkdir -p /tmp/pkg && npm pack --pack-destination /tmp/pkg

FROM node:22-bookworm-slim AS installer
WORKDIR /install
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN npm i -g @deepseek-ai/dsh@0.1.1-rc.2
COPY --from=build /tmp/pkg/pi-web-ui-*.tgz /tmp/app.tgz
RUN npm install -g /tmp/app.tgz && rm -f /tmp/app.tgz

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=installer /usr/local /usr/local
ENV PI_WEB_PORT=8787
ENV PI_WEB_HOST=0.0.0.0
ENV PI_WEB_DATA_DIR=/app/.pi-web
RUN mkdir -p /app/.pi-web && chown -R node:node /app
EXPOSE 8787
VOLUME ["/app/.pi-web"]
USER node
ENTRYPOINT ["pi-web-ui"]
CMD ["--no-browser"]
