# Frontend image -- one React + Vite app (build context is this frontend/
# directory). From the repo root:
#   docker build -f frontend/Dockerfile -t qa-portal-frontend frontend

FROM node:20-alpine AS build
WORKDIR /workspace

COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /workspace/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
