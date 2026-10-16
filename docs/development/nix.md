# Nix Integration

This guide covers the pinned release package and development-shell integration. For source development, use the [quick start](../development.md#quick-start).

## Nix integration

The repository's [flake](../../flake.nix) repackages a pinned Linux release for
`x86_64-linux` and `aarch64-linux`. It does not build the application from source or
automatically follow the latest GitHub Release. Review the pinned version and source hashes
when updating it.

The [README installation steps](../../README.md#nix--nixos) cover direct execution and the NixOS
overlay. The default package enables unfree packages for its own nixpkgs instance. Overlay
consumers must permit the project's noncommercial license on their own configured instance.

For Home Manager, place the package in `home.packages` and configure the overlay and unfree
policy on its owning nixpkgs instance. A development shell using that same configured instance
can include the package as follows:

```nix
devShells.default = pkgs.mkShell {
  packages = [ pkgs.antigravity-manager ];
};
```

These examples configure package selection; they do not establish native credential-store,
account-switching or updater acceptance on a Nix installation.
