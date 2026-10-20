# Sourced by rn-app.sh. copy_fixture_files <fixture-dir> <app-dir> <names>: copies further
# JS/TS sources of a fixture into the app (FIXTURE_FILES). Each name must be a plain file name
# (letters, digits, _ and -, then .ts/.tsx/.js/.json), not a template or build-configuration
# name (compared case-insensitively: on a case-insensitive file system app.tsx would replace
# App.tsx), and resolve (no symlink) to a regular file directly inside the fixture directory. The
# names are split on whitespace without glob expansion. Prints nothing; returns 1 on refusal.
copy_fixture_files() {
  local dir app names f src
  dir="$(realpath -e "$1")" || return 1
  app="$2"
  names="$3"
  local -a files
  set -f
  read -r -a files <<< "$names"
  set +f
  for f in "${files[@]}"; do
    if ! [[ "$f" =~ ^[A-Za-z0-9_-]+\.(ts|tsx|js|json)$ ]]; then echo "FIXTURE_FILES: '$f' is not a plain .ts/.tsx/.js/.json file name" >&2; return 1; fi
    case "${f,,}" in
      app.tsx|smoke.ts|index.js|package.json|package-lock.json|app.json|tsconfig.json|test_vectors.json|*config.js|*config.json|*rc.js|*rc.json)
        echo "FIXTURE_FILES: '$f' is a template or configuration name and cannot be replaced" >&2; return 1 ;;
    esac
    src="$dir/$f"
    if [ -L "$src" ] || [ ! -f "$src" ] || [ "$(realpath -e "$src")" != "$src" ]; then
      echo "FIXTURE_FILES: '$f' must be a regular file directly in $dir (no symlinks)" >&2; return 1
    fi
  done
  # Validate all names before copying any.
  for f in "${files[@]}"; do cp "$dir/$f" "$app/$f"; done
}
