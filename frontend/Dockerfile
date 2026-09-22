FROM docker.io/library/node:24.20.0-alpine3.23 AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

# Keep the post-build security audit in an explicit image layer. The frontend
# build context uses an allowlist-style .dockerignore, so scripts/ must be
# intentionally included rather than relying on a broad COPY side effect.
COPY scripts ./scripts
COPY tsconfig.json tsconfig.node.json vite.config.ts proxyHeaders.ts index.html ./
COPY src ./src
COPY public ./public
RUN npm run build


FROM docker.io/library/nginx:1.28.3-alpine3.23

COPY --from=build /app/dist /usr/share/nginx/html

COPY nginx.conf /etc/nginx/conf.d/default.conf

RUN touch /var/run/nginx.pid \
    && chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx /var/log/nginx /var/run/nginx.pid

EXPOSE 8443
USER nginx
