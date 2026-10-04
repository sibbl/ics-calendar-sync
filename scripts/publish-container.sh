#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ ${RELEASE_IMAGE:-} =~ ^ghcr\.io/[a-z0-9_.-]+/[a-z0-9_.-]+$ ]]
[[ ${RELEASE_SHA:-} =~ ^[a-f0-9]{40}$ ]]
args=(--platform linux/amd64,linux/arm64 --push --provenance=false --sbom=true --progress=plain --tag "$RELEASE_IMAGE:sha-$RELEASE_SHA" --label "org.opencontainers.image.source=https://github.com/${RELEASE_IMAGE#ghcr.io/}" --label "org.opencontainers.image.revision=$RELEASE_SHA")
if [[ -n ${RELEASE_BUILDER:-} ]]; then
  [[ $RELEASE_BUILDER =~ ^[A-Za-z0-9_.-]+$ ]]
  args+=(--builder "$RELEASE_BUILDER")
fi
if [[ ${RELEASE_REF:-} == refs/heads/main ]]; then
  args+=(--tag "$RELEASE_IMAGE:main" --tag "$RELEASE_IMAGE:latest")
elif [[ ${RELEASE_REF:-} == refs/tags/* ]]; then
  release_tag=${RELEASE_REF#refs/tags/}
  [[ $release_tag =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]
  args+=(--tag "$RELEASE_IMAGE:$release_tag")
else
  printf 'Unsupported release reference\n' >&2
  exit 1
fi
release_metadata=$(mktemp)
trap 'rm -f "$release_metadata"' EXIT
# Pass no GitHub event/runtime environment to Buildx. Do not print metadata JSON.
env -i PATH="$PATH" HOME="$HOME" DOCKER_CONFIG="${DOCKER_CONFIG:-$HOME/.docker}" BUILDX_METADATA_PROVENANCE=disabled BUILDX_GIT_INFO=false docker buildx build "${args[@]}" --metadata-file "$release_metadata" .
release_digest=$(python3 - "$release_metadata" <<'PY'
import json,re,sys
value=json.load(open(sys.argv[1])).get('containerimage.digest','')
if not re.fullmatch(r'sha256:[a-f0-9]{64}',value):raise SystemExit('Missing verified image digest')
print(value)
PY
)
printf '%s@%s\n' "$RELEASE_IMAGE" "$release_digest"
printf '%s@%s\n' "$RELEASE_IMAGE" "$release_digest" >> "$GITHUB_STEP_SUMMARY"
