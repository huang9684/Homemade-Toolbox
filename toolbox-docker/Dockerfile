# ── Stage 1: 编译依赖 ────────────────────────────────────────
FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json ./
RUN npm install --production

# ── Stage 2: 运行镜像（不含编译工具，更小）────────────────────
FROM node:20-alpine
WORKDIR /app

# 仅复制运行所需文件
COPY --from=builder /app/node_modules ./node_modules
COPY server.js package.json ./
COPY public ./public

RUN mkdir -p uploads data

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/health || exit 1

EXPOSE 3000

# 限制 Node.js 堆内存（1G服务器友好）
ENV NODE_OPTIONS="--max-old-space-size=128"

CMD ["node", "server.js"]
