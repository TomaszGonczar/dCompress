# Sandbox image for autonomous dcompress work.
#
# The whole point: the agent works on a repository whose *product* rewrites agent config
# files. It must never be able to reach the host's ~/.claude, ~/.codex, ~/.omp or ~/.gemini.
# Inside this image those paths are ordinary, disposable directories.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV TZ=UTC

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl jq ca-certificates openssh-client \
      python3 python3-venv make g++ \
    && rm -rf /var/lib/apt/lists/*

# A single world-writable home. The container is normally started with
# `--user <host-uid>` so that files written into the bind-mounted workspace are owned by the
# host user rather than root; that UID has no passwd entry inside the image, so HOME must be
# writable by any UID.
#
# .omp and .codex are pre-created here deliberately: Docker creates a missing mount parent as
# root, which would leave these directories unwritable for the host UID and break both agents
# with a confusing permission error.
RUN mkdir -p /home/agent/work /home/agent/.npm /home/agent/.cache \
             /home/agent/.omp/agent /home/agent/.omp/natives /home/agent/.codex \
 && chmod -R 0777 /home/agent

# OMP ships as a standalone Linux binary from GitHub releases (not npm — the `oh-my-pi`
# npm package is a different, older project). Pinned for reproducibility; bump deliberately.
ARG OMP_VERSION=18.1.19
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) asset="omp-linux-x64" ;; \
      arm64) asset="omp-linux-arm64" ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/omp \
      "https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}/${asset}"; \
    chmod 0555 /usr/local/bin/omp; \
    /usr/local/bin/omp --version

ENV HOME=/home/agent
ENV DCOMPRESS_HOME=/home/agent/work/.sandbox/dcompress
ENV npm_config_cache=/home/agent/.npm
ENV TZ=UTC
ENV LANG=C.UTF-8

WORKDIR /home/agent/work
CMD ["/bin/bash"]
