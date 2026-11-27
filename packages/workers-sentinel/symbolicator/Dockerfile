# Symbolicator for Sentinel (src/symbolicator.ts). Pinned release from
# getsentry's registry (Docker Hub stopped receiving tags in 2025).
# FSL-1.1-MIT: allowed for self-hosting.
FROM ghcr.io/getsentry/symbolicator:26.11.0
COPY config.yml /sentinel/symbolicator.yml
EXPOSE 3021
CMD ["run", "-c", "/sentinel/symbolicator.yml"]
