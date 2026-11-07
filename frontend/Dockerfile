# Build stage
FROM node:22-alpine AS builder

WORKDIR /src

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

# API base URL is baked at build time; override with --build-arg VITE_API_URL=https://api.example.com
ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build

# Serve stage
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /src/dist /usr/share/nginx/html

EXPOSE 80
