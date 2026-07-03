# Arch Linux Packaging

This directory contains the PKGBUILD necessary to install Antigravity Manager on Arch Linux using the pre-compiled `.deb` binaries.

This is a `-bin` package (`antigravity-manager-bin`), which means it does not require you to compile Node.js, `better-sqlite3`, or any native dependencies from source. It downloads the pre-packaged `.deb` release created by GitHub Actions and repackages it for Arch Linux. This is the fastest, safest, and most common way to distribute Electron apps on the AUR.

## Building with `makepkg` (Local Build)

If you want to build and install the package locally using `makepkg`:

1. Copy the `PKGBUILD` to an empty directory.
2. Run `makepkg -si`. This will download the `.deb` release, extract it, and install it on your system using `pacman`.

## Publishing to the AUR

To deploy to the AUR (so users can install it using `yay -S antigravity-manager-bin`), you should:
1. Initialize an AUR git repository for `antigravity-manager-bin`.
2. Add the `PKGBUILD` file to it.
3. Generate `.SRCINFO` by running: `makepkg --printsrcinfo > .SRCINFO`
4. Commit and push both files to the AUR repository.

Note: Remember to update `pkgver` and regenerate `.SRCINFO` for each new version you release.
