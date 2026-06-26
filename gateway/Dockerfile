FROM node:22-alpine AS frontend-build

WORKDIR /frontend

COPY ["dashboard/package.json", "dashboard/package-lock.json", "./"]
RUN npm ci

COPY ["dashboard/", "./"]
RUN npm run build

FROM nginx:1.27-alpine

COPY gateway/default.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build /frontend/dist /usr/share/nginx/html

EXPOSE 80
