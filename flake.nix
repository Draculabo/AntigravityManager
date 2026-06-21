{
  description = "Antigravity Manager";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = {
    self,
    nixpkgs,
  }: let
    supportedSystems = ["x86_64-linux" "aarch64-linux"];
    forAllSystems = nixpkgs.lib.genAttrs supportedSystems;

    version = "0.18.1";

    sources = {
      "x86_64-linux" = {
        url = "https://github.com/Draculabo/AntigravityManager/releases/download/v${version}/Antigravity.Manager_${version}_amd64.deb";
        sha256 = "22cc1049cb5e6969c672842da61ff9760e361bd2787fbe7a20964f5f86fef4dd";
      };
      "aarch64-linux" = {
        url = "https://github.com/Draculabo/AntigravityManager/releases/download/v${version}/Antigravity.Manager_${version}_arm64.deb";
        sha256 = "02d615bfd6bf99dd620a9a9eb2edb2e79b65e24f7676c94e60f0a8aea00bcc21";
      };
    };

    mkPackage = pkgs: let
      system = pkgs.stdenv.hostPlatform.system;
      source = sources.${system} or (throw "Unsupported system: ${system}");
    in
      pkgs.stdenv.mkDerivation {
        pname = "antigravity-manager";
        inherit version;

        src = pkgs.fetchurl {
          inherit (source) url sha256;
        };

        nativeBuildInputs = with pkgs; [
          autoPatchelfHook
          makeWrapper
          zstd
        ];

        buildInputs = with pkgs; [
          alsa-lib
          at-spi2-atk
          atk
          cups
          dbus
          expat
          glib
          gtk3
          libsecret
          libdrm
          libxkbcommon
          mesa
          nspr
          nss
          pango
          systemd
          libx11
          libxcomposite
          libxdamage
          libxext
          libxfixes
          libxrandr
          libxcb
        ];

        unpackPhase = ''
          ar x $src
          tar xf data.tar.* --no-same-permissions
        '';

        installPhase = ''
          mkdir -p $out/bin $out/lib $out/share
          cp -r usr/lib/antigravity-manager $out/lib/
          cp -r usr/share/* $out/share/

          ln -s $out/lib/antigravity-manager/antigravity-manager $out/bin/antigravity-manager
        '';

        postFixup = ''
          # Wrap the executable so it finds Wayland/X11 and libsecret
          wrapProgram $out/bin/antigravity-manager \
            --add-flags "--enable-features=WaylandWindowDecorations" \
            --add-flags "--ozone-platform-hint=auto" \
            --prefix LD_LIBRARY_PATH : ${pkgs.lib.makeLibraryPath [pkgs.libsecret]}

          if [ -e $out/share/applications/antigravity-manager.desktop ]; then
            substituteInPlace $out/share/applications/antigravity-manager.desktop \
              --replace "/usr/lib/antigravity-manager/antigravity-manager" "antigravity-manager"
          fi
        '';

        meta = with pkgs.lib; {
          description = "Professional multi-account manager for Google Gemini & Claude AI";
          homepage = "https://github.com/Draculabo/AntigravityManager";
          license = licenses.cc-by-nc-sa-40;
          maintainers = [];
          platforms = ["x86_64-linux" "aarch64-linux"];
          mainProgram = "antigravity-manager";
        };
      };
  in {
    overlays.default = final: prev: {
      antigravity-manager = mkPackage final;
    };

    packages = forAllSystems (system: let
      pkgs = import nixpkgs {
        inherit system;
        config.allowUnfree = true;
      };
    in {
      default = mkPackage pkgs;
    });
  };
}
