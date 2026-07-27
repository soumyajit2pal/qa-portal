# Specialised Testing module image -- independently built/deployed from the shell and
# the other 3 modules. Build context MUST be frontend/ (the npm workspaces
# root), not this package's own folder -- it needs the sibling
# packages/shared source. From the repo root:
#   docker build -f frontend/packages/specialised-testing/Dockerfile -t qa-portal-specialised-testing frontend

FROM node:20-alpine AS build
WORKDIR /workspace

COPY package.json package-lock.json* ./
COPY packages ./packages

RUN npm install
RUN npm run build --workspace=@qa-portal/module-specialised-testing

FROM nginx:1.27-alpine
COPY --from=build /workspace/packages/specialised-testing/dist /usr/share/nginx/html
COPY packages/specialised-testing/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
