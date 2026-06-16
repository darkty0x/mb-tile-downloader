FROM node:22-slim

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY dashboard/package.json dashboard/package-lock.json ./dashboard/
RUN npm --prefix dashboard ci --omit=dev

COPY dashboard ./dashboard
COPY src ./src
RUN mkdir -p configs

RUN npm --prefix dashboard run build

EXPOSE 8080

CMD ["npm", "--prefix", "dashboard", "run", "start"]
