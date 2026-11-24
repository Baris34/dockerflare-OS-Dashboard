FROM node:24-bookworm-slim AS runtime
WORKDIR /app
RUN mkdir -p /data/logs && chown -R node:node /data
ENV OS_DASHBOARD_DATA_DIR=/data
COPY --chown=node:node package.json ./
COPY --chown=node:node lib ./lib
USER node

FROM runtime AS ai-gateway
COPY --chown=node:node ai-gateway-server.mjs ./
ENV OS_DASHBOARD_INFERENCE_BIND=0.0.0.0 OS_DASHBOARD_INFERENCE_PORT=4322
EXPOSE 4322
CMD ["node","ai-gateway-server.mjs"]

FROM runtime AS panel
USER root
RUN install -d -o node -g node -m 0700 /os-dashboard-audit
USER node
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --chown=node:node public ./public
COPY --chown=node:node server.mjs ./
ENV OS_DASHBOARD_BIND=0.0.0.0 PORT=4320 OS_DASHBOARD_PANEL_ONLY=1 OS_DASHBOARD_PUBLIC_AI_GATEWAY_URL=http://127.0.0.1:4322/v1
ENV OS_DASHBOARD_WORKSHOP_DB=/os-dashboard-audit/workshop.sqlite
EXPOSE 4320
CMD ["node","server.mjs"]
