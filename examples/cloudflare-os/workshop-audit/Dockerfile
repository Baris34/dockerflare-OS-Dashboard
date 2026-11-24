FROM node:24-bookworm-slim AS model
COPY examples/cloudflare-os/workshop-audit/model.mjs /demo/model.mjs
CMD ["node", "/demo/model.mjs"]

FROM node:24-bookworm-slim AS ai-gateway
COPY lib/ /app/lib/
COPY examples/cloudflare-os/workshop-audit/ai-gateway.mjs examples/cloudflare-os/workshop-audit/verify.mjs /demo/
CMD ["node", "/demo/ai-gateway.mjs"]

FROM dockerflare/checks:local AS checks
COPY examples/cloudflare-os/workshop-audit/workshop.mjs /demo/workshop.mjs
CMD ["node", "/demo/workshop.mjs"]
