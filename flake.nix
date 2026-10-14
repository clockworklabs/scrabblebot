{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs = {
        nixpkgs.follows = "nixpkgs";
      };
    };
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          # SpacetimeDB is BSL-licensed, which nixpkgs classes as unfree.
          config.allowUnfreePredicate = pkg: builtins.elem (lib.getName pkg) [ "spacetime" ];
          overlays = [
            (import ./overlays/spacetimedb.nix)
            (import rust-overlay)
          ];
        };

        inherit (nixpkgs) lib;

        # The Rust toolchain that we actually build with.
        rustStable = pkgs.rust-bin.stable.latest.default.override {
          targets = [ "wasm32-unknown-unknown" ];
        };

        rustNightly = pkgs.rust-bin.selectLatestNightlyWith (toolchain: toolchain.rust-analyzer);
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.spacetimedb
            rustStable
            rustNightly
            pkgs.codex
            pkgs.python3
            pkgs.nodejs
            pkgs.openssl
            pkgs.pkg-config
          ];
        };
      }
    );
}
