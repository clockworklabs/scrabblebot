{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          # SpacetimeDB is BSL-licensed, which nixpkgs classes as unfree.
          config.allowUnfreePredicate = pkg: builtins.elem (lib.getName pkg) [ "spacetime" ];
          overlays = [
            (import ./overlays/spacetimedb.nix)
          ];
        };

        inherit (nixpkgs) lib;
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.spacetimedb
            pkgs.codex
            pkgs.nodejs
          ];
        };
      }
    );
}
