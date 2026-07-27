# Security module image -- independently built/deployed from the shell and
# the other 3 modules. Build context MUST be frontend/ (the npm workspaces
# root), not this package's own folder -- it needs the sibling
# packages/shared source. From the repo root:
#   docker build -f frontend/packages/security/Dockerfile -t qa-portal-security frontend

FROM node:20-alpine AS build
WORKDIR /workspace

COPY package.json package-lock.json* ./
COPY packages ./packages

RUN npm install
RUN npm run build --workspace=@qa-portal/module-security

FROM nginx:1.27-alpine
COPY --from=build /workspace/packages/security/dist /usr/share/nginx/html
COPY packages/security/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
