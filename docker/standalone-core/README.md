# Standalone Core/CLI container

This image packages the already-built standalone Core/CLI runtime. It does not
install Electron or the web management UI, and it does not create a second
credential store.

Prepare the matching Linux runtime first:

```bash
pnpm run prepare:standalone
docker build --build-arg RUNTIME_ARCH=x64 -f docker/standalone-core/Dockerfile .
```

The image stores the profile under `/var/lib/antigravity-manager`. Mount that
directory as a volume when the container must retain accounts and diagnostics.
The entrypoint forwards `SIGTERM` to the CLI shutdown command and waits for the
Core process to drain. `health` checks the same local management endpoint used
by the CLI.
