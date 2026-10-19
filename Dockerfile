# syntax=docker/dockerfile:1
FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts --no-fund
COPY frontend/ ./
RUN npm run build

FROM rust:1.99.0-slim-bookworm@sha256:2c3a22f0a5533ea2dd5a16627bc841228151faa2d4de2644ac9987e4a2f1f2fa AS backend
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /src
ENV CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY .cargo/ .cargo/
COPY crates/ crates/
COPY migrations/ migrations/
RUN cargo build --locked --release --bin navarchnet

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
LABEL org.opencontainers.image.source="https://github.com/QuentinBtd/NavarchNet" org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app
COPY --from=backend /src/target/release/navarchnet /usr/local/bin/navarchnet
COPY --from=frontend /src/frontend/dist /app/dist
COPY LICENSE README.md /app/
COPY docs/ /app/docs/
COPY third-party/ /app/third-party/
USER 65532:65532
ENV NAVARCHNET_BIND=0.0.0.0:8080 NAVARCHNET_STATIC_DIR=/app/dist
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD ["navarchnet", "--healthcheck"]
ENTRYPOINT ["navarchnet"]
