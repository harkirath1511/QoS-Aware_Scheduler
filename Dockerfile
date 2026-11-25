FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY tsconfig.json next.config.ts ./
COPY app ./app
COPY src ./src
RUN npm run build

FROM dependencies AS lab
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next ./.next
COPY next.config.ts tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY db ./db
RUN mkdir -p /app/.data/artifacts && chown -R node:node /app/.data /app/.next
USER node
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start"]

FROM lab AS hosted
COPY aws/certs/ ./certs/

FROM dependencies AS worker
ENV NODE_ENV=production
COPY tsconfig.json ./
COPY src/domain.ts src/vibration.ts ./src/
COPY scripts/worker.ts scripts/compute.ts ./scripts/
COPY aws/prepare-worker.sh aws/worker-watchdog.sh aws/ec2-worker.service aws/qos-watchdog.service aws/qos-watchdog.timer ./aws/
USER node
CMD ["node", "--import", "tsx", "scripts/worker.ts"]
