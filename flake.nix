{
  description = "GPS Tracker - serial GPS to interactive map";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        # Python 3.14's NumPy currently aborts while loading libffi on macOS.
        python = pkgs.python313.withPackages (ps: with ps; [
          matplotlib
          pyserial
        ]);
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            python
            pkgs.python313Packages.matplotlib
            pkgs.python313Packages.pyserial
            pkgs.nodejs_22
          ];

          shellHook = ''
            echo "GPS Tracker dev shell"
            echo "Python: $(python --version)"
            echo "Node: $(node --version)"
            echo ""
            echo "Usage:"
            echo "  python gps_tracker.py -p /dev/cu.usbmodem3665388B32321 -b 115200"
            echo "  python gps_tracker.py --kml track.kml"
            echo "  cd web && npm install && npm run dev"
            echo ""
            echo "Then open http://localhost:8080"
          '';
        };

        packages.default = python.pkgs.buildPythonPackage {
          pname = "gps-tracker";
          version = "0.1.0";
          src = ./.;
          propagatedBuildInputs = with python.pkgs; [ matplotlib pyserial ];
        };
      });
}
