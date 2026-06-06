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
    spacetimedb = {
      url = "github:clockworklabs/SpacetimeDB";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay, spacetimedb, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [(import rust-overlay)];
        };

        inherit (pkgs) lib;

        # The Rust toolchain that we actually build with.
        rustStable = pkgs.rust-bin.stable.latest.default.override {
          targets = [ "wasm32-unknown-unknown" ];
        };

        rustNightly = pkgs.rust-bin.selectLatestNightlyWith (toolchain: toolchain.rust-analyzer);

        spacetime = spacetimedb.packages.${system}.default;
      in
        {
          devShells.default = pkgs.mkShell {
            packages = [
              spacetime
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
