# Workspace shell image. Build context MUST be frontend/ (the npm
# workspaces root), not this package's own folder -- it needs the sibling
# `packages/shared` source and the root package.json's "workspaces" field.
# From the repo root:
#   docker build -f frontend/packages/shell/Dockerfile -t qa-portal-shell frontend
#
# Each module's remoteEntry.js URL is baked in at build time (see
# vite.config.ts) -- pass the real deployed URLs as build args when building
# for anything other than localhost:
#   docker build -f frontend/packages/shell/Dockerfile frontend \
#     --build-arg VITE_FUNCTIONAL_REMOTE_URL=https://functional.example.com/assets/remoteEntry.js \
#     --build-arg VITE_SECURITY_REMOTE_URL=https://security.example.com/assets/remoteEntry.js \
#     --build-arg VITE_SPECIALISED_TESTING_REMOTE_URL=https://specialised-testing.example.com/assets/remoteEntry.js \
#     --build-arg VITE_GOVERNANCE_REMOTE_URL=https://governance.example.com/assets/remoteEntry.js \
#     --build-arg VITE_BACKEND_URL=https://api.example.com \
#     -t qa-portal-shell

FROM node:20-alpine AS build
WORKDIR /workspace

COPY package.json package-lock.json* ./
COPY packages ./packages

RUN npm install

ARG VITE_FUNCTIONAL_REMOTE_URL
ARG VITE_SECURITY_REMOTE_URL
ARG VITE_SPECIALISED_TESTING_REMOTE_URL
ARG VITE_GOVERNANCE_REMOTE_URL
ARG VITE_BACKEND_URL
ENV VITE_FUNCTIONAL_REMOTE_URL=${VITE_FUNCTIONAL_REMOTE_URL} \
    VITE_SECURITY_REMOTE_URL=${VITE_SECURITY_REMOTE_URL} \
    VITE_SPECIALISED_TESTING_REMOTE_URL=${VITE_SPECIALISED_TESTING_REMOTE_URL} \
    VITE_GOVERNANCE_REMOTE_URL=${VITE_GOVERNANCE_REMOTE_URL} \
    VITE_BACKEND_URL=${VITE_BACKEND_URL}

RUN npm run build --workspace=@qa-portal/shell

FROM nginx:1.27-alpine
COPY --from=build /workspace/packages/shell/dist /usr/share/nginx/html
COPY packages/shell/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
