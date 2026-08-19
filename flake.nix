{
  description = "Agentero — Tauri desktop app";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };

        version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

        # ──────────────────────────────────────────────────────────────────
        # Prebuilt pdfium (pinned to chromium/7897, the version
        # liteparse-pdfium-sys expects). Provided via env vars so its
        # build script skips the network download.
        # ──────────────────────────────────────────────────────────────────
        pdfiumAsset = {
          "x86_64-linux" = "pdfium-linux-x64";
          "aarch64-linux" = "pdfium-linux-arm64";
        }.${system} or (throw "no pdfium asset for ${system}");

        pdfium = pkgs.stdenv.mkDerivation {
          pname = "pdfium-prebuilt";
          inherit version;
          src = pkgs.fetchurl {
            url = "https://github.com/run-llama/pdfium-binaries/releases/download/chromium%2F7897/${pdfiumAsset}.tgz";
            hash = {
              "x86_64-linux" = "sha256-r5byH9jp1TlVAT2tHRewA9ASACXnh7fOYRpoXVcodZQ=";
              "aarch64-linux" = pkgs.lib.fakeHash;
            }.${system} or pkgs.lib.fakeHash;
          };
          dontUnpack = true;
          dontBuild = true;
          nativeBuildInputs = [ pkgs.gzip ];
          installPhase = ''
            runHook preInstall
            mkdir -p $out
            tar xzf $src -C $out
            runHook postInstall
          '';
        };

        # ──────────────────────────────────────────────────────────────────
        # tesseract-rs (pulled by liteparse's default `tesseract` feature)
        # builds leptonica + tesseract from source via cmake, and downloads
        # the source zips + traineddata unless they already exist under
        # `$HOME/.tesseract-rs/`. We pre-fetch everything and drop it in
        # place so the build is fully offline.
        # ──────────────────────────────────────────────────────────────────
        leptonicaSrc = pkgs.fetchzip {
          url = "https://github.com/DanBloomberg/leptonica/archive/refs/tags/1.84.1.zip";
          hash = "sha256-SAJVm+Qn/HuiENKa5cLRnqezwKPlNWJBGIRScYObkSw=";
        };
        tesseractSrc = pkgs.fetchzip {
          url = "https://github.com/tesseract-ocr/tesseract/archive/refs/tags/5.3.4.zip";
          hash = "sha256-IKxzDhSM+BPsKyQP3mADAkpRSGHs4OmdFIA+Txt084M=";
        };
        engTraineddata = pkgs.fetchurl {
          url = "https://github.com/tesseract-ocr/tessdata_best/raw/main/eng.traineddata";
          hash = "sha256-goCu0Hgv4nJXpo6hD+fvMkyg+Nhb0v0UXRwrVgvLZro=";
        };
        turTraineddata = pkgs.fetchurl {
          url = "https://github.com/tesseract-ocr/tessdata_best/raw/main/tur.traineddata";
          hash = "sha256-4MMzjcF1A9x9M1pQfJrgGytGz9B1YRceHhrFXYXo5Dg=";
        };

        # ──────────────────────────────────────────────────────────────────
        # Tauri app — uses cargo-tauri.hook + buildRustPackage.
        #
        # The CLI is NOT a separate derivation. Tauri's `externalBin` expects
        # the binary at `src-tauri/binaries/agentero-cli-<target-triple>` at
        # build time, so we build it inline in `preBuild`:
        #   1. Stub the binary so tauri-build's generate_context! compiles.
        #   2. `cargo build -p agentero-cli` to get the real binary.
        #   3. Replace the stub with the real binary.
        # Pattern adapted from nur-packages/pkgs/agentero/package.nix.
        # ──────────────────────────────────────────────────────────────────
        tauriApp = pkgs.rustPlatform.buildRustPackage (
          finalAttrs:
          {
            pname = "agentero";
            inherit version;

            __structuredAttrs = true;
            strictDeps = true;

            src = ./.;
            cargoRoot = "./.";
            buildAndTestSubdir = "src-tauri";
            cargoHash = "sha256-0k0Pb44MFbPdHMkAKeZlarsgC+EqxqPXELatdJt0UZU=";

            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src;
              fetcherVersion = 4;
              hash = "sha256-lVYh4OOF7O9o+7QtIGJ8KQCx1jlAs/2V4NH0HX5yFTw=";
            };
            pnpmRoot = ".";

            doCheck = false;

            nativeBuildInputs = [
              pkgs.cargo-tauri.hook
              pkgs.cmake
              pkgs.jq
              pkgs.moreutils
              pkgs.nodejs
              pkgs.pnpm
              pkgs.pnpmConfigHook
              pkgs.pkg-config
              pkgs.wrapGAppsHook4
              pkgs.desktop-file-utils
              pkgs.writableTmpDirAsHomeHook
            ];

            buildInputs = [
              pkgs.glib-networking
              pkgs.libayatana-appindicator
              pkgs.libsoup_3
              pkgs.openssl
              pkgs.webkitgtk_4_1
            ];

            # tesseract-rs needs cmake for its sub-build but stdenv must not
            # run a top-level cmake configure.
            dontUseCmakeConfigure = true;

            env = {
              OPENSSL_NO_VENDOR = true;
              PDFIUM_LIB_PATH = "${pdfium}/lib";
              PDFIUM_INCLUDE_PATH = "${pdfium}/include";
            };

            preConfigure = ''
              export HOME=$TMPDIR
              mkdir -p "$HOME/.tesseract-rs/third_party" "$HOME/.tesseract-rs/tessdata"
              cp -r --no-preserve=mode ${leptonicaSrc} "$HOME/.tesseract-rs/third_party/leptonica"
              cp -r --no-preserve=mode ${tesseractSrc} "$HOME/.tesseract-rs/third_party/tesseract"
              chmod -R u+w "$HOME/.tesseract-rs/third_party"
              cp ${engTraineddata} "$HOME/.tesseract-rs/tessdata/eng.traineddata"
              cp ${turTraineddata} "$HOME/.tesseract-rs/tessdata/tur.traineddata"
            '';

            postPatch =
              ''
                rm -f src-tauri/Cargo.lock

                # Strip the upstream beforeBuildCommand (it runs
                # `cargo build -p agentero-cli` out-of-band, which fights the
                # Nix cargo vendor) and disable updater artifacts. We rebuild
                # the bundled CLI + frontend manually in preBuild.
                jq '
                  del(.build.beforeBuildCommand) |
                  .bundle.createUpdaterArtifacts = false |
                  .plugins.updater.endpoints = []
                ' src-tauri/tauri.conf.json | sponge src-tauri/tauri.conf.json
              ''
              + pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
                # libappindicator-sys dlopens libayatana-appindicator3.so.1 at
                # runtime; autoPatchelf/wrapGApps can't catch it.
                substituteInPlace $cargoDepsCopy/*/libappindicator-sys-*/src/lib.rs \
                  --replace-fail "libayatana-appindicator3.so.1" "${pkgs.libayatana-appindicator}/lib/libayatana-appindicator3.so.1"
              '';

            # Mirror what `pnpm cli:bundle:release && pnpm build` (the stripped
            # beforeBuildCommand) does, but through Nix's cargo vendor so all
            # cargo invocations are offline.
            preBuild = ''
              # 1) Seed the externalBin stub so tauri-build's generate_context!
              #    accepts `binaries/agentero-cli-<triple>` while agentero_lib
              #    compiles.
              triple="$(rustc --print host-tuple)"
              mkdir -p src-tauri/binaries
              stub="src-tauri/binaries/agentero-cli-''${triple}"
              printf '#!/bin/sh\necho "agentero-cli stub" >&2\nexit 1\n' > "$stub"
              chmod +x "$stub"

              # 2) Stage pdfium shared library into src-tauri/pdfium/ so Tauri's
              #    `resources: ["pdfium/*"]` glob matches. This replaces the
              #    upstream `pnpm pdfium:stage` (part of the stripped
              #    beforeBuildCommand).
              mkdir -p src-tauri/pdfium
              cp ${pdfium}/lib/libpdfium.so src-tauri/pdfium/libpdfium.so

              # 3) Build the headless CLI (same package prepare-bundled-cli.mjs
              #    builds).
              cargo build --offline --release -p agentero-cli

              # 4) Replace the stub with the real binary Tauri will embed via
              #    externalBin.
              cp target/release/agentero-cli "$stub"
              chmod +x "$stub"

              # 5) Frontend (`pnpm build` from the stripped beforeBuildCommand).
              pnpm build
            '';

            # wrapGAppsHook4 wraps the binary with GTK/WebKit env; extend it
            # with the WebKit DMABUF flag + libpdfium's libstdc++ lookup path.
            preFixup = ''
              gappsWrapperArgs+=(
                --set WEBKIT_DISABLE_DMABUF_RENDERER 1
                --prefix LD_LIBRARY_PATH : ${pkgs.lib.makeLibraryPath [
                  pkgs.stdenv.cc.cc.lib
                  pdfium
                ]}
              )
            '';

            postInstall = ''
              if [ -f "$out/share/applications/"*.desktop ]; then
                desktop-file-edit \
                  --set-comment "AI coding agent desktop app" \
                  --set-key="Keywords" --set-value="ai;agent;tauri;coding;vault;" \
                  --set-key="StartupWMClass" --set-value="Agentero" \
                  --set-key="Categories" --set-value="Development;Utility;" \
                  "$out/share/applications/"*.desktop
              fi
            '';

            passthru = {
              inherit pdfium;
            };

            meta = {
              description = "AI coding agent desktop app (Tauri)";
              homepage = "https://github.com/poco-ai/Agentero";
              license = pkgs.lib.licenses.mit;
              mainProgram = "agentero";
              platforms = [
                "x86_64-linux"
                "aarch64-linux"
              ];
            };
          }
        );
      in
      {
        packages = {
          default = tauriApp;
          inherit pdfium;
        };

        apps.default = {
          type = "app";
          program = "${tauriApp}/bin/agentero";
        };

        devShells.default = pkgs.mkShell {
          nativeBuildInputs =
            [
              pkgs.cargo-tauri.hook
              pkgs.cmake
              pkgs.jq
              pkgs.moreutils
              pkgs.nodejs
              pkgs.pnpm
              pkgs.pnpmConfigHook
              pkgs.pkg-config
              pkgs.wrapGAppsHook4
              pkgs.desktop-file-utils
              pkgs.writableTmpDirAsHomeHook
            ];
          buildInputs = [
            pkgs.glib-networking
            pkgs.libayatana-appindicator
            pkgs.libsoup_3
            pkgs.openssl
            pkgs.webkitgtk_4_1
          ];
        };
      }
    );
}
