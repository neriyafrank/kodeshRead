#!/usr/bin/env bash
# Streams an Otzaria library source into <dest> without ever holding a second multi-GB copy:
# every archive is extracted and deleted right away, a repository tarball is piped straight
# into tar. Used by .github/workflows/build-library.yml.
#
#   fetch-otzaria-source.sh <owner/repo> <dest> <classical_full|all>
#
# 1. The repository's latest GitHub Release is inspected (API). Its library archives are used:
#    `otzaria_latest.zip` when present (Otzaria/otzaria-library), otherwise every .zip / .7z (or
#    split .zip.001 / .7z.001) asset that is not a PDF / Dicta side archive.
# 2. Without a usable release (Sivan22/otzaria-library has none) the default-branch tarball is
#    streamed and only the `אוצריא` folder is unpacked.
# The `links/` folder and (classical_full) the contemporary authors' folders are never written.
# scripts/build-db.js --scope applies the same filter again, so this is only a disk optimisation.
set -euo pipefail
export LANG=C.UTF-8 LC_ALL=C.UTF-8

repo="${1:?owner/repo}"
dest="${2:?destination}"
scope="${3:?scope}"
mkdir -p "$dest"
tmp="$(mktemp -d "${RUNNER_TEMP:-/tmp}/otzaria-dl.XXXXXX")"
mkdir -p "$tmp/dl"
trap 'rm -rf "$tmp"' EXIT

modern=('מחברי זמננו' 'מחברי זמנינו')
zip_excludes=('links/*' '*/links/*' '*.pdf')
tar_excludes=(--exclude='*/links')
if [[ "$scope" == "classical_full" ]]; then
  for m in "${modern[@]}"; do
    zip_excludes+=("*/$m/*" "$m/*")
    tar_excludes+=(--exclude="*/$m")
  done
fi

free_gb() { df -BG --output=avail "$dest" | tail -1 | tr -dc '0-9'; }
echo "free space before download: $(free_gb) GB"

# --- 1. release assets ---------------------------------------------------------------------------
assets="$tmp/assets.tsv"
if gh api "repos/$repo/releases/latest" --jq '.assets[] | [.name, .size] | @tsv' > "$assets" 2> "$tmp/api.err"; then
  echo "latest release of $repo:"; sed 's/^/  /' "$assets"
else
  echo "no usable latest release for $repo ($(head -c 200 "$tmp/api.err"))"; : > "$assets"
fi

pick=()
if awk -F'\t' '$1=="otzaria_latest.zip"{f=1} END{exit !f}' "$assets"; then
  pick=(otzaria_latest.zip)
else
  while IFS=$'\t' read -r name _; do
    [[ -z "$name" ]] && continue
    shopt -s nocasematch
    if [[ "$name" =~ \.(zip|7z)(\.[0-9]+)?$ && ! "$name" =~ (dicta|pdf|bavli|aux) ]]; then pick+=("$name"); fi
    shopt -u nocasematch
  done < "$assets"
fi

extract_zip() { # <file>
  unzip -q -o -d "$dest" "$1" -x "${zip_excludes[@]}"
}

if ((${#pick[@]})); then
  echo "using release assets: ${pick[*]}"
  need7z=0
  for n in "${pick[@]}"; do [[ "$n" =~ \.7z(\.[0-9]+)?$ || "$n" =~ \.zip\.[0-9]+$ ]] && need7z=1; done
  if ((need7z)) && ! command -v 7z >/dev/null; then sudo apt-get install -y -qq p7zip-full >/dev/null; fi
  for n in "${pick[@]}"; do
    # Later volumes (.002, ...) are fetched together with the first one.
    [[ "$n" =~ \.(zip|7z)\.([0-9]+)$ && "${BASH_REMATCH[2]}" != 001 ]] && continue
    rm -f "$tmp"/dl/*
    if [[ "$n" =~ ^(.*\.(zip|7z))\.001$ ]]; then
      gh release download -R "$repo" --pattern "${BASH_REMATCH[1]}.*" --dir "$tmp/dl" --clobber
      7z x -y -bd -o"$dest" "$tmp/dl/$n" '-xr!links' >/dev/null
    else
      gh release download -R "$repo" --pattern "$n" --dir "$tmp/dl" --clobber
      if [[ "$n" =~ \.7z$ ]]; then 7z x -y -bd -o"$dest" "$tmp/dl/$n" '-xr!links' >/dev/null; else extract_zip "$tmp/dl/$n"; fi
    fi
    rm -f "$tmp"/dl/*      # archive deleted before the next one is fetched
    echo "extracted $n; free: $(free_gb) GB"
  done
else
  # --- 2. repository tarball, streamed straight into tar ---------------------------------------------
  echo "no library archive in the release: streaming the repository tarball (only אוצריא)"
  ok=0
  for attempt in 1 2 3; do
    rm -rf "${dest:?}"/* 2>/dev/null || true
    if curl -fsSL --retry 3 -H "Authorization: Bearer ${GH_TOKEN:?GH_TOKEN is required}" -H 'Accept: application/vnd.github+json' \
        "https://api.github.com/repos/$repo/tarball" \
      | tar -xz --strip-components=1 -C "$dest" "${tar_excludes[@]}" --wildcards '*/אוצריא/*'; then ok=1; break; fi
    echo "tarball attempt $attempt failed" >&2; sleep $((attempt * 15))
  done
  ((ok)) || { echo "could not download the repository tarball" >&2; exit 1; }
fi

if ! find "$dest" -maxdepth 4 -type d -name 'אוצריא' -print -quit | grep -q .; then
  echo "WARNING: no 'אוצריא' folder under $dest; build-db will index the whole tree. Top level:" >&2
  ls -1 "$dest" | head -20 >&2
fi
echo "source ready: $(find "$dest" -type f -name '*.txt' | wc -l) .txt files, $(du -sh "$dest" | cut -f1); free: $(free_gb) GB"
