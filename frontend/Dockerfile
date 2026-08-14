# Single frontend image -- the whole SPA (Login/Dashboard/QA Requests +
# Functional/Security/Specialised Testing/Governance, all code-split via
# React.lazy but shipped in one build). From the repo root:
#   docker build -f frontend/Dockerfile -t qa-portal-frontend frontend
# Pass --build-arg VITE_API_BASE_URL=... only if the backend is NOT reachable
# same-origin via this image's own nginx /api proxy (see nginx.conf) --
# e.g. deploying frontend and backend to different hosts outside
# docker-compose. Leave it unset for the default docker-compose setup.

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
