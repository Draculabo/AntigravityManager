# Build from a repository that already contains dist/.runtime/linux-${RUNTIME_ARCH}/standalone.
# The runtime is produced by pnpm run prepare:standalone and carries the pinned Node ABI.
FROM debian:bookworm-slim

ARG RUNTIME_ARCH=x64

RUN apt-get update \
  && apt-get install --no-install-recommends --yes ca-certificates libglib2.0-0 libnss3 libsecret-1-0 \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --system agm \
  && useradd --system --gid agm --create-home --home-dir /var/lib/antigravity-manager agm

COPY dist/.runtime/linux-${RUNTIME_ARCH}/standalone /opt/antigravity-manager
COPY docker/standalone-core/entrypoint.sh /usr/local/bin/antigravity-manager

RUN chmod 0755 /usr/local/bin/antigravity-manager \
  && mkdir -p /var/lib/antigravity-manager \
  && chown -R agm:agm /opt/antigravity-manager /var/lib/antigravity-manager

ENV HOME=/var/lib/antigravity-manager \
    XDG_CONFIG_HOME=/var/lib/antigravity-manager/.config \
    XDG_DATA_HOME=/var/lib/antigravity-manager/.local/share \
    XDG_STATE_HOME=/var/lib/antigravity-manager/.local/state

VOLUME ["/var/lib/antigravity-manager"]
STOPSIGNAL SIGTERM
USER agm
ENTRYPOINT ["/usr/local/bin/antigravity-manager"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["/usr/local/bin/antigravity-manager", "health"]
