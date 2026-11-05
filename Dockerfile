# syntax=docker/dockerfile:1
# pi-web-ui — Hermetic multi-stage build.
#
# 架构原则：
# 1. 编译与打包（build）：构建前端与后端，通过 `npm pack` 生成严格对齐 package.json files
#    规范的标准 tarball，作为全局唯一交付介质（SSOT），彻底消除手工白名单拷贝与目录遗漏；
# 2. 依赖安装与二进制编译（installer）：在带编译器阶段全局安装打包产物及 dsh 运行时，
#    由 node-gyp 原生编译 node-pty 等 Linux 二进制；
# 3. 极简安全运行时（runtime）：仅拷贝编译安装就绪的 /usr/local，无编译工具链残留，
#    通过标准 CLI 入口 `pi-web-ui --no-browser` 启动，彻底消除相对路径和裸标识符解析缺陷。

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
# 数据目录必须指向挂载卷：默认 homedir(~/.pi-web) 落在容器可写层，
# docker compose down 即丢失全部会话与设置。compose 已挂 pi-web-data:/app/.pi-web。
ENV PI_WEB_DATA_DIR=/app/.pi-web
RUN mkdir -p /app/.pi-web && chown -R node:node /app
EXPOSE 8787
# Session data (per-client chat history) lives here — mount a volume.
VOLUME ["/app/.pi-web"]
USER node
# 直接使用标准全局 CLI 命令启动，规避 Node ESM 相对路径解析缺陷
ENTRYPOINT ["pi-web-ui"]
CMD ["--no-browser"]
