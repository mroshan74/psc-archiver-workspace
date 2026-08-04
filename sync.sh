#!/usr/bin/env bash
# Clones (if missing) or fast-forward-pulls (if present) every repo listed in
# repos.json, next to this script. Never merges or overwrites local work --
# a repo with diverging/uncommitted changes is left alone and flagged.
#
# Usage: bash sync.sh

set -eu

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
manifest="$script_dir/repos.json"

if [ ! -f "$manifest" ]; then
  echo "repos.json not found next to sync.sh at $manifest" >&2
  exit 1
fi

names=()
while IFS= read -r v; do names+=("$v"); done < <(grep -o '"name": *"[^"]*"' "$manifest" | sed -E 's/.*"([^"]*)"$/\1/')
urls=()
while IFS= read -r v; do urls+=("$v"); done < <(grep -o '"url": *"[^"]*"' "$manifest" | sed -E 's/.*"([^"]*)"$/\1/')
branches=()
while IFS= read -r v; do branches+=("$v"); done < <(grep -o '"branch": *"[^"]*"' "$manifest" | sed -E 's/.*"([^"]*)"$/\1/')

status_repo=()
status_text=()

i=0
while [ "$i" -lt "${#names[@]}" ]; do
  name="${names[$i]}"
  url="${urls[$i]}"
  branch="${branches[$i]}"
  path="$script_dir/$name"

  if [ ! -d "$path/.git" ]; then
    echo "[$name] cloning ($branch)..."
    if git clone --branch "$branch" "$url" "$path"; then
      status_repo+=("$name"); status_text+=("cloned")
    else
      status_repo+=("$name"); status_text+=("CLONE FAILED")
    fi
  else
    echo "[$name] pulling (--ff-only)..."
    if git -C "$path" pull --ff-only; then
      status_repo+=("$name"); status_text+=("up to date / fast-forwarded")
    else
      status_repo+=("$name"); status_text+=("NEEDS MANUAL ATTENTION (diverged or local changes conflict)")
    fi
  fi
  i=$((i + 1))
done

echo ""
echo "=== sync summary ==="
fail=0
i=0
while [ "$i" -lt "${#status_repo[@]}" ]; do
  printf '%-22s %s\n' "${status_repo[$i]}" "${status_text[$i]}"
  case "${status_text[$i]}" in
    *FAILED*|*ATTENTION*) fail=1 ;;
  esac
  i=$((i + 1))
done

exit "$fail"
