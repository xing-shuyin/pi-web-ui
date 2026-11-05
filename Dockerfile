# syntax=docker/dockerfile:1
# pi-web-ui — multi-stage build. Builds the server (tsc) + frontend (vite),
# then runs a slim runtime image. `docker compose up -d` = one-command deploy
# with auto-restart on boot (`restart: unless-stopped`).
FROM node:22-bookworm-slim AS build
WORKDIR /app
# node-pty ships prebuilds only for darwin/win32 — on Linux `npm ci` always
# falls back to node-gyp, so the toolchain is required wherever npm installs
# packages (build + deps stages below). The runtime image never installs
# packages, so it stays slim.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# 生产依赖单独一个阶段装：node-pty 在 Linux 必须源码编译（无 prebuilt），所以这里
# 也要工具链；编译好的二进制随 node_modules 整体拷进运行时镜像。
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# DSH engine (PI_WEB_ENGINE=dsh) needs the full @deepseek-ai/dsh runtime tree
# (nested ~196 packages) as a subprocess — global install is the canonical way.
# Skipped implicitly when the image never enables the dsh engine (just unused).
# dsh 是纯 JS 包（无 install 生命周期脚本），无需编译工具链。
RUN npm i -g @deepseek-ai/dsh@0.1.1-rc.2
# 提前建立数据目录并赋予 node 用户属主权限，避免挂载卷或运行时以 node 用户创建子目录时 EACCES
RUN mkdir -p /app/.pi-web && chown -R node:node /app
# 生产运行所需静态资源与包元数据拷入，保持 node:node 权限
COPY --chown=node:node package.json ./
COPY --chown=node:node bin ./bin
COPY --chown=node:node themes ./themes
COPY --chown=node:node plugin-sdk ./plugin-sdk
COPY --chown=node:node plugins ./plugins
COPY --chown=node:node extensions ./extensions
# 依赖在 deps 阶段装好/编译好后整体拷入：运行时镜像不带 python3/make/g++，也不再跑
# npm ci —— node-pty 的 Linux 二进制已在 deps 阶段编译完，运行时没有 node-gyp 回退，
# 也就不需要工具链（plugin 源码构建等用户操作发生在挂载进来的数据目录，与镜像无关）。
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/web/dist ./web/dist
ENV PI_WEB_PORT=8787
ENV PI_WEB_HOST=0.0.0.0
# 数据目录必须指向挂载卷：默认 homedir(~/.pi-web) 落在容器可写层，
# docker compose down 即丢失全部会话与设置。compose 已挂 pi-web-data:/app/.pi-web。
ENV PI_WEB_DATA_DIR=/app/.pi-web
EXPOSE 8787
# Session data (per-client chat history) lives here — mount a volume.
VOLUME ["/app/.pi-web"]
USER node
# --import：pi SDK 副本选择钩子（issue #260/#321）——机器上有更新的 pi 就跟随，
# 自带副本兜底；镜像内没有祖先副本，实际总是用自带那份。
# 注意相对路径前缀 `./`：Node ESM 解析规则规定无前缀的裸标识符被视作 npm 包名（会导致 ERR_MODULE_NOT_FOUND: Cannot find package 'dist'）。
CMD ["node", "--import", "./dist/server/resolve-global-sdk.js", "dist/server/index.js"]
