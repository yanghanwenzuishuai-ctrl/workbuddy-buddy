FROM node:22.22.0-bookworm-slim AS build

WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/control-plane/package.json apps/control-plane/package.json
RUN npm ci --ignore-scripts

COPY contracts contracts
COPY apps/control-plane apps/control-plane
RUN npm run build --workspace @workbuddy-buddy/control-plane

FROM node:22.22.0-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/control-plane/package.json apps/control-plane/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY contracts contracts
COPY frontend/pets frontend/pets
COPY apps/control-plane/migrations apps/control-plane/migrations
COPY apps/control-plane/public apps/control-plane/public
COPY --from=build /workspace/apps/control-plane/dist apps/control-plane/dist

USER node
EXPOSE 3000
CMD ["node", "apps/control-plane/dist/main.js"]
