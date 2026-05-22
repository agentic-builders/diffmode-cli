#!/usr/bin/env bash
# Release helper for diffmode-cli.
#
# Usage:
#   npm run release patch   # 0.1.0 -> 0.1.1
#   npm run release minor   # 0.1.0 -> 0.2.0
#   npm run release major   # 0.1.0 -> 1.0.0
#
# What it does (in order):
#   1. Refuses to run if not on main, working tree is dirty, or origin is
#      ahead of local (a release from a divergent state is almost always
#      a mistake).
#   2. Computes the next version from package.json + bump type.
#   3. Refuses if CHANGELOG.md doesn't already have a "## [<next>]" entry —
#      forces the changelog to be written before the tag exists.
#   4. Runs `npm version <bump>` — which fires the `preversion` hook
#      (full lint+typecheck+build+test chain) before writing the tag.
#   5. Pushes commit + tag to origin. The .github/workflows/publish.yml
#      workflow picks up the tag and runs `npm publish --provenance`.
#
# Refuses every check before doing anything so a partial-release state
# is impossible.

set -euo pipefail

BUMP="${1:-}"
if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: npm run release <patch|minor|major>" >&2
  exit 1
fi

# 1a. On main?
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "Refusing: must be on main (currently on '$BRANCH')." >&2
  exit 1
fi

# 1b. Working tree clean?
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing: working tree has uncommitted changes." >&2
  git status --short >&2
  exit 1
fi

# 1c. In sync with origin?
echo "Fetching origin..." >&2
git fetch origin --quiet
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse origin/main)"
if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  echo "Refusing: local main ($LOCAL_SHA) differs from origin/main ($REMOTE_SHA)." >&2
  echo "Pull or push first." >&2
  exit 1
fi

# 2. Compute next version (without writing anything).
NEXT_VERSION="$(node -e "
const v = require('./package.json').version.split('.').map(Number);
const t = '$BUMP';
if (t === 'major') { v[0]++; v[1] = 0; v[2] = 0; }
else if (t === 'minor') { v[1]++; v[2] = 0; }
else if (t === 'patch') { v[2]++; }
console.log(v.join('.'));
")"
echo "Next version: $NEXT_VERSION" >&2

# 3. CHANGELOG.md must mention the next version.
if ! grep -q "^## \[$NEXT_VERSION\]" CHANGELOG.md; then
  echo "Refusing: CHANGELOG.md has no '## [$NEXT_VERSION]' entry." >&2
  echo "Write the changelog before releasing." >&2
  exit 1
fi

# 4. Run npm version. This fires `preversion` (lint+typecheck+build+test)
#    before writing the package.json bump or the git tag.
echo "Bumping to $NEXT_VERSION..." >&2
npm version "$BUMP"

# 5. Push commit + tag. Publish workflow takes over from here.
echo "Pushing commit and v$NEXT_VERSION tag..." >&2
git push --follow-tags

echo >&2
echo "✓ Released v$NEXT_VERSION." >&2
echo "  Watch the publish workflow at:" >&2
echo "  https://github.com/agentic-builders/diffmode-cli/actions" >&2
