# 固定已核验的 Node 22 镜像摘要；升级时更新摘要并重新验证。
ARG NODE_IMAGE=node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    OPENCLAUDE_HOME=/etc/openclaude \
    OPENCLAUDE_HOST=0.0.0.0 \
    OPENCLAUDE_PORT=11436 \
    OPENCLAUDE_DISABLE_KEYCHAIN=1
WORKDIR /app
# 项目无第三方 npm 依赖和编译步骤，无需 npm install 或多阶段构建。
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY docker/config/config.json /etc/openclaude/config.json
RUN mkdir -p /home/node/.openclaude && chown node:node /home/node/.openclaude
USER node
EXPOSE 11436
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.OPENCLAUDE_PORT+'/openclaude/status',{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/router/index.js"]
