# Sigil: static editor served by nginx on 8080. Build context = repo root.
# Coolify: Dockerfile build pack, port 8080.
FROM --platform=${BUILDPLATFORM} node:24@sha256:8530f76a96d88820d288761f022e318970dda93d01536919fbc16076b7983e63 AS build

WORKDIR /opt/node_app

COPY . .

# do not ignore optional dependencies:
# Error: Cannot find module @rollup/rollup-linux-x64-gnu
RUN --mount=type=cache,target=/root/.cache/yarn \
    npm_config_target_arch=${TARGETARCH} yarn --frozen-lockfile --network-timeout 600000

ARG NODE_ENV=production

RUN npm_config_target_arch=${TARGETARCH} yarn build:app:docker \
    && node deploy/csp.mjs excalidraw-app/build/index.html > security-headers.conf

FROM nginxinc/nginx-unprivileged:1.29-alpine

USER root
RUN apk upgrade --no-cache && rm -rf /usr/share/nginx/html/*
USER 101

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /opt/node_app/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /opt/node_app/excalidraw-app/build /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
