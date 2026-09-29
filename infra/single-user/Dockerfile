# The image `migrate` and `cli` both build (infra/single-user/compose.yaml).
# Build context is the repository root (../.. from this file's directory),
# because the CLI's workspace dependencies live outside apps/cli itself.
#
# Multi-stage on purpose: the build stage carries the whole monorepo's build
# tooling (typescript, eslint, the workspace source trees); the runtime stage
# carries only the compiled output and production dependencies, so none of
# that tooling — or a devDependency's transitive weight — ships in the image
# that actually runs.

########################################################################
# Build: compile every workspace apps/cli depends on, with devDependencies
# present (tsc, and whatever a workspace needs at build time).
########################################################################
FROM node:22 AS build
WORKDIR /app

# Manifests and project-reference configs first, so `npm ci` is cached
# across a source-only change.
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY apps/cli/package.json apps/cli/tsconfig.json apps/cli/
COPY packages/domain/package.json packages/domain/tsconfig.json packages/domain/
COPY packages/graph/package.json packages/graph/tsconfig.json packages/graph/
COPY packages/roles/package.json packages/roles/tsconfig.json packages/roles/
COPY packages/tools/package.json packages/tools/tsconfig.json packages/tools/
COPY packages/persistence/package.json packages/persistence/tsconfig.json packages/persistence/
COPY packages/evals/package.json packages/evals/tsconfig.json packages/evals/
COPY packages/observability/package.json packages/observability/tsconfig.json packages/observability/
RUN npm ci

COPY apps ./apps
COPY packages ./packages
RUN npm run build

########################################################################
# Runtime: only the compiled dist/ output, production dependencies, and the
# entrypoint. No devDependency, no source tree, no test, no rulebook.
########################################################################
FROM node:22-slim AS runtime
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/cli/package.json apps/cli/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/graph/package.json packages/graph/package.json
COPY packages/roles/package.json packages/roles/package.json
COPY packages/tools/package.json packages/tools/package.json
COPY packages/persistence/package.json packages/persistence/package.json
COPY packages/evals/package.json packages/evals/package.json
COPY packages/observability/package.json packages/observability/package.json
RUN npm ci --omit=dev

COPY --from=build /app/apps/cli/dist apps/cli/dist
COPY --from=build /app/packages/domain/dist packages/domain/dist
COPY --from=build /app/packages/graph/dist packages/graph/dist
COPY --from=build /app/packages/roles/dist packages/roles/dist
COPY --from=build /app/packages/tools/dist packages/tools/dist
COPY --from=build /app/packages/persistence/dist packages/persistence/dist
COPY --from=build /app/packages/evals/dist packages/evals/dist
COPY --from=build /app/packages/observability/dist packages/observability/dist

COPY infra/single-user/cli-entrypoint.sh /usr/local/bin/cli-entrypoint.sh
RUN chmod +x /usr/local/bin/cli-entrypoint.sh

USER node
ENTRYPOINT ["/usr/local/bin/cli-entrypoint.sh"]
