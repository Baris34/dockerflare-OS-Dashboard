FROM node:24-bookworm-slim AS fixture
COPY examples/cloudflare-os/ai-gateway/fixture.mjs /demo/fixture.mjs

FROM fixture AS model
CMD ["node", "/demo/fixture.mjs", "model"]

FROM fixture AS guard
CMD ["node", "/demo/fixture.mjs", "guard"]

FROM node:24-bookworm-slim AS ai-gateway
COPY lib/ai-gateway.mjs lib/inference-listener.mjs lib/policy.mjs lib/store.mjs /app/lib/
COPY examples/cloudflare-os/ai-gateway/ai-gateway.mjs examples/cloudflare-os/ai-gateway/capture.mjs /demo/
COPY examples/cloudflare-os/ai-gateway/import-events.mjs /app/examples/cloudflare-os/ai-gateway/import-events.mjs
CMD ["node", "/demo/ai-gateway.mjs"]

FROM dockerflare/checks:local AS checks
COPY examples/cloudflare-os/ai-gateway/workshop.mjs /demo/workshop.mjs
CMD ["node", "/demo/workshop.mjs"]
