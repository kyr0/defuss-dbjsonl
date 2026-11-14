# Bundled verification tooling

`defuss-vae-dc0f6b5.zip` contains the upstream plugin and license from commit `dc0f6b5ea4973b2f3224a589d38c19386126e09d` of [kyr0/defuss-vae](https://github.com/kyr0/defuss-vae). Its version is 0.9.0. The runtime and skills are unmodified.

`vae.json` pins the archive's SHA-256 checksum. `scripts/vae.ts` verifies it before extraction. This development tool is not included in the npm package and is not a runtime dependency of DBSONL.

VERIFIED: `defuss-dbsonl-0.2.0.tgz` is the previously shipped, unmodified package used by compatibility tests and matched benchmarks. SHA-256: `90eaf0e5e6c78cc636f6fb9273cc0475a1e2220180ecd569f97bac7ad0a3fe1b`. It retains its MIT license and is excluded from the published runtime package.
