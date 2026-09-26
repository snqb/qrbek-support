FROM denoland/deno:2.9.4@sha256:c777b4b225501a61074837e90a826a58f99124837824023cd60334b1e2374498
WORKDIR /app
COPY server.ts page-store.ts payment.js app.js page-expiry.js ./
COPY index.html pay.html create.html compare.html redirect.js styles.css support.html privacy.html ./
COPY assets ./assets
COPY vendor ./vendor
COPY interface-design ./interface-design
COPY opendesign ./opendesign
RUN deno cache server.ts
ENV PORT=8080 QRBEK_DB_PATH=/data/pages.sqlite3
USER deno
CMD ["run", "--cached-only", "--allow-net=0.0.0.0:8080", "--allow-read=/app,/data", "--allow-write=/data", "--allow-env=PORT,QRBEK_DB_PATH,PUBLIC_ORIGIN,QRBEK_MAX_RECORDS,QRBEK_CREATE_RATE_LIMIT,QRBEK_CREATE_RATE_WINDOW_MS", "server.ts"]
