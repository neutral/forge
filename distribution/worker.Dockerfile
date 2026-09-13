# Build from the public source tree. The same builder produces standalone payloads.
FROM node:24.18.0-bookworm-slim AS application
WORKDIR /source
COPY . /source
RUN node distribution/build.mjs --source /source --output /assembled --application-only \
    && mv /assembled/forge-*-application /assembled/application

FROM node:24.18.0-bookworm-slim
ARG CODEX_VERSION=0.153.4
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git ripgrep python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@${CODEX_VERSION} \
    && npm cache clean --force
COPY --from=application /assembled/application /opt/forge
RUN ln -s /opt/forge/bin/forge /usr/local/bin/forge
ENV CODEX_HOME=/var/lib/forge/codex \
    FORGE_CONTAINER=forge-worker \
    FORGE_WORKSPACE=/workspace \
    FORGE_BIND=0.0.0.0 \
    FORGE_PORT=4310 \
    FORGE_SANDBOX=danger-full-access \
    FORGE_APPROVAL_POLICY=never
WORKDIR /workspace
EXPOSE 4310
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+process.env.FORGE_PORT+'/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/opt/forge/runtime/worker-entry.mjs"]
