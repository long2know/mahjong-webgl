# WebGL source candidates and protected promotion

The source repository is **`long2know/mahjong-webgl`** and the only new-publication
namespace is **`ghcr.io/long2know/mahjong-webgl`**. A repository rename does not
move registry packages. All existing tags/digests in `ghcr.io/long2know/mahjong-web`
and `ghcr.io/long2know/mahjong-unity` are intentionally left unchanged for
history/rollback: do not delete, retag or redirect them. The old repository name
may be reused by an unrelated project; never dispatch this project's builds
against that future `long2know/mahjong-web` repository or publish to its image.

The main-only `ghcr-publish.yml` workflow accepts an exact clean source SHA
and same-repository PR to `dev`. It verifies repository/base/head identity and
cleanliness, then builds the frontend/API directly. No draft-release bundle,
Unity manifest, Editor receipt, activation or engine artifact is an input.
It publishes only unique `candidate-RUN-ATTEMPT` and
`sha-SOURCE-RUN-ATTEMPT` tags with build provenance, never `latest`.

After pushing, that same job pulls the build output's immutable
`ghcr.io/long2know/mahjong-webgl@sha256:...` index reference for `linux/amd64`.
From the approved source checkout it must pass both canonical
`tests/migration/container_smoke.py` and `container_proxy_smoke.py` runners
with that exact image reference and source SHA. Root hardening/static/health
checks and actual nginx TLS/browser checks at root plus three runtime prefixes therefore
exercise the published candidate, not a separately built source-CI image.
Failure of either runner fails packaging and prevents the identity summary.
The always-uploaded `candidate-runtime-RUN-ATTEMPT` artifact uses an explicit
receipt/log/PNG allowlist; fixture databases, signing keys and TLS private keys
are excluded. Its receipts bind the published index reference, resolved image
ID, source SHA and prefix results. Automated checks qualify the pulled
Linux/amd64 runtime only; independent digest acceptance and protected promotion
remain separate requirements.

PR source/image CI does **not** publish to any registry. Its real image smoke
is supplementary evidence for an independently accepted candidate digest.

`ghcr-promote.yml` remains main-only and uses the existing **ghcr-production**
protected environment. The script refuses promotion without required reviewers,
explicit `runtime-qualified:sha256:...` confirmation, source ancestry in main,
a successful main packaging attempt, a merged same-repository acceptance PR
naming the exact source/pullable digest, and candidate/source tags that both
resolve to that digest. Promotion copies the accepted digest without rebuilding.
It changes only `ghcr.io/long2know/mahjong-webgl:latest`; it cannot silently
rewrite either historical image namespace or an operator's Compose configuration.

## Package visibility and repository access

Repository rename, repository visibility and package visibility/access are
separate concerns. A newly created personal GHCR package defaults to **private**,
even when its source repository is public. Neither the rename nor a successful
authenticated Actions push/pull makes the new package anonymously pullable.
For public distribution, a package administrator must separately change its
visibility in GitHub's package settings and verify an anonymous pull of the
qualified exact digest. This is an operator step, not a bypass of candidate
runtime checks, independent acceptance or protected promotion.

Keep both old packages intact for rollback. If a different new `mahjong-web`
repository is later created, its Actions are not automatically authorized to
use the pre-existing `ghcr.io/long2know/mahjong-web` package merely because the
name matches. A package administrator may need to grant that repository explicit
Actions access or reassociate the package, as a separate intentional operation.
Do not perform that reassociation as part of this source rename.

Package API `403`/`404` responses from a token without `read:packages` do not
establish package absence or anonymous availability. Resolve visibility/access
through the authorized package administrator; do not broaden credentials or
weaken publishing guards to work around an inaccessible package.

## Rename/source bootstrap

Commit/push the complete reviewed source to `main` and rename the existing GitHub
repository before dispatching these workflows; their repository guards and API
requests now deliberately require `long2know/mahjong-webgl`. The checkout folder
does not need to be renamed. No workflow in the future unrelated `mahjong-web`
repository is authorized by these guards.

If a source authorization PR is needed after that main update, a real same-repository
`main` → `dev` synchronization PR is supported. `prepare` requires its exact head
SHA, base `dev`, an open or merged PR, and a clean source checkout; it does not
require a feature-branch name. Dispatch the packaging workflow on `main` with
that PR number and exact head SHA. Later branch movement requires rechecking
the exact head, not inventing a commit or allowing dirty source.

The resulting candidate still needs both exact-digest runtime runners, independent
acceptance in a merged same-repository PR naming its source/digest, and protected
`ghcr-production` approval before promotion. Its source must be an ancestor of
`main` (already true for an unchanged main-head source). Repository rename or
source synchronization alone is not release acceptance.

No publishing/promotion dispatch is part of renderer development or a PR
review. Keep the candidate/acceptance/digest evidence in the PR description.
