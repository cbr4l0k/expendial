FROM oven/bun:1.3.14-alpine
WORKDIR /app
COPY server.ts ./
COPY public ./public
RUN mkdir -p data && chown bun:bun data
USER bun
ENV PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:$PORT/health || exit 1
CMD ["bun", "server.ts"]
