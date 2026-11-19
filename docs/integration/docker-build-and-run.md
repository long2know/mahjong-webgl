# Source-only browser/hosting image

`bash build.sh --tag mahjong-webgl:local` (or `pwsh -File ./build.ps1 -Tag mahjong-webgl:local`)
builds the canonical Dockerfile. Node produces the default WebGL bundle; the
.NET SDK publishes the existing API; the ASP.NET runtime image serves both.
There is no required prebuilt engine output or license input.

New installations:

```sh
./scripts/compose-bootstrap.sh
docker compose up -d --build
```

The bootstrap creates a local signing key only when absent. Never copy another
operator's `.env`, keys or database. Existing installations must retain the
existing Compose project/volume name and their stable signing configuration;
use `docker compose -p EXISTING_PROJECT ...` when a changed checkout folder
would otherwise select a new project. Internal API/database namespaces and
the compatibility `/autotable/` address are intentionally unchanged.

For example, **only if your existing Compose project is `mahjong-web`**, continue
using `docker compose -p mahjong-web up -d --build` after renaming its checkout.
Alternatively keep that existing value in `COMPOSE_PROJECT_NAME`. Retain the same
project name for every Compose command and the same provider overlay `-f` options.
Do not run `down -v`, delete volumes, or generate replacement signing material
as part of a rename. A future unrelated `mahjong-web` deployment must use a
different project/volume namespace rather than share this deployment's data.

The logical volumes remain `mahjong-data` and `bootstrap-cache`, plus
`mahjong-postgres-data` or `mahjong-sqlserver-data` for the optional overlays.
SQLite still uses `/data/mahjong-autotable.db`; provider selection and connection
configuration are unchanged. No automatic volume/database migration is needed
or performed by the source rename.

Compose binds loopback 8950 by default, mounts persistent `/data` plus the
retained bootstrap-cache directory, and enforces non-root/read-only/cap-drop/
no-new-privileges hardening. `MAHJONG_IMAGE`, `MAHJONG_HOST_PORT` and
`MAHJONG_BIND_ADDRESS` remain explicit overrides. Do not select or promote a
registry image merely because a repository was renamed.
New registry publication targets only `ghcr.io/long2know/mahjong-webgl`; the
`ghcr.io/long2know/mahjong-web` and `ghcr.io/long2know/mahjong-unity` namespaces
remain historical/rollback packages, not aliases updated by the new workflows.

Stable internal identifiers intentionally keep their `mahjong-web` spelling:
the renderer schema URN, build/runtime/source-CI receipt `artifactKind` values,
service-worker cache namespace/version, `org.mahjong-web.engine` label key,
and build-only npm-cache/Vite-plugin IDs. These are compatibility/cache
identifiers, not repository URLs or image destinations. API/assembly names,
configuration keys, wire contracts and game UI are unchanged.

For a disposable native fixture, restore the locked Node/.NET dependencies and
run `bash scripts/run-web.sh`. It uses fresh synthetic state and loopback 5087,
not the operator's persistence. Stop the foreground process normally.

PR CI builds the actual default image from the exact PR head without pushing
it. `tests/migration/container_smoke.py` starts an owned hardened fixture and
verifies health/source labels, every served file hash, strict CSP, retained
notices, and absence/rejection of engine/player artifacts, then removes only
that fixture. Browser gameplay is independently exercised by
`tests/migration/browser-webgl.mjs`. Build/health smoke alone is not device or
complete multiplayer qualification.
