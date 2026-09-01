FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

WORKDIR /app
COPY services/api.mjs services/payments.mjs services/inventory.mjs ./
COPY scenario-definitions.mjs ./scenario-definitions.mjs

USER node
EXPOSE 3000
