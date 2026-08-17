#!/bin/sh
set -eu

OMD_REPO="${OMD_REPO:-amplifthq/oh-my-dsh}"
OMD_INSTALL_ROOT="${OMD_INSTALL_ROOT:-$HOME/.local/share/oh-my-dsh}"
OMD_BIN_DIR="${OMD_BIN_DIR:-$HOME/.local/bin}"
LOCK_HELD=0
LOCK_FILE=''
manifest_file=''

die() {
  printf 'oh-my-dsh installer: %s\n' "$1" >&2
  exit "${2:-1}"
}

expand_path() {
  case "$1" in
    '') printf '%s' "$1" ;;
    '~') printf '%s' "$HOME" ;;
    '~'/*) printf '%s' "$HOME/${1#~/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

OMD_INSTALL_ROOT="$(expand_path "$OMD_INSTALL_ROOT")"
OMD_BIN_DIR="$(expand_path "$OMD_BIN_DIR")"

detect_platform() {
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os-$arch" in
    Darwin-arm64) printf '%s' 'darwin-arm64' ;;
    Linux-x86_64 | Linux-amd64) printf '%s' 'linux-x64' ;;
    *)
      die "unsupported platform: ${os}-${arch}. Supported: darwin-arm64, linux-x64."
      ;;
  esac
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

sha256_file() {
  file_path="$1"
  if have_cmd sha256sum; then
    sha256sum "$file_path" | awk '{print $1}'
  elif have_cmd shasum; then
    shasum -a 256 "$file_path" | awk '{print $1}'
  else
    die 'sha256 verification requires sha256sum or shasum.'
  fi
}

fetch_url() {
  url="$1"
  dest="$2"
  mkdir -p "$(dirname "$dest")"
  if have_cmd curl; then
    curl -fsSL "$url" -o "$dest"
  else
    die 'curl is required to download release artifacts.'
  fi
}

json_field() {
  field="$1"
  file_path="$2"
  sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$file_path" | head -n 1
}

json_number_field() {
  field="$1"
  file_path="$2"
  sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p" "$file_path" | head -n 1
}

extract_platform_block() {
  platform="$1"
  file_path="$2"
  awk -v platform="$platform" '
    $0 ~ "\"" platform "\"" { capture = 1 }
    capture { print }
    capture && /\}/ { exit }
  ' "$file_path"
}

artifact_field() {
  platform="$1"
  field="$2"
  file_path="$3"
  block_file="$(mktemp "${TMPDIR:-/tmp}/omd-artifact-block.XXXXXX")"
  extract_platform_block "$platform" "$file_path" >"$block_file"
  json_field "$field" "$block_file"
  rm -f "$block_file"
}

artifact_number_field() {
  platform="$1"
  field="$2"
  file_path="$3"
  block_file="$(mktemp "${TMPDIR:-/tmp}/omd-artifact-block.XXXXXX")"
  extract_platform_block "$platform" "$file_path" >"$block_file"
  json_number_field "$field" "$block_file"
  rm -f "$block_file"
}

json_string_or_null() {
  value="$1"
  if [ -z "$value" ]; then
    printf 'null'
  else
    printf '"%s"' "$value"
  fi
}

validate_artifact_url() {
  url="$1"
  case "$url" in
    file://*)
      if [ -z "${OMD_MANIFEST_URL:-}" ]; then
        die "unauthorized artifact url: $url"
      fi
      ;;
    https://github.com/"${OMD_REPO}"/releases/download/*) ;;
    *)
      die "unauthorized artifact url: $url"
      ;;
  esac
}

is_valid_omd_version() {
  value="$1"
  case "$value" in
    */* | *\\* | *..*) return 1 ;;
  esac
  awk -v value="$value" 'BEGIN {
    exit(value ~ /^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$/ ? 0 : 1)
  }'
}

is_valid_artifact_filename() {
  value="$1"
  case "$value" in
    */* | *\\* | *..*) return 1 ;;
  esac
  awk -v value="$value" 'BEGIN {
    exit(value ~ /^[a-zA-Z0-9_.-]+\.tar\.gz$/ ? 0 : 1)
  }'
}

is_valid_sha256() {
  value="$1"
  awk -v value="$value" 'BEGIN {
    exit(length(value) == 64 && value ~ /^[0-9a-fA-F]+$/ ? 0 : 1)
  }'
}

archive_path_is_safe() {
  value="$1"
  awk -v value="$value" 'BEGIN {
    gsub(/\\/, "/", value)
    if (substr(value, 1, 1) == "/") exit 1
    depth = 0
    count = split(value, parts, "/")
    for (i = 1; i <= count; i += 1) {
      part = parts[i]
      if (part == "" || part == ".") continue
      if (part == "..") {
        if (depth == 0) exit 1
        depth -= 1
      } else {
        depth += 1
      }
    }
    exit 0
  }'
}

validate_archive_entries() {
  archive_path="$1"
  entries_file="${archive_path}.entries.$$"
  verbose_file="${archive_path}.verbose.$$"
  tar -tzf "$archive_path" >"$entries_file" || die "cannot inspect archive: $archive_path"
  tar -tvzf "$archive_path" >"$verbose_file" || die "cannot inspect archive links: $archive_path"
  entry_count="$(wc -l <"$entries_file" | tr -d ' ')"
  verbose_count="$(wc -l <"$verbose_file" | tr -d ' ')"
  if [ "$entry_count" != "$verbose_count" ]; then
    die "cannot correlate archive entries with link metadata"
  fi

  while IFS= read -r entry && IFS= read -r listing <&3; do
    [ -z "$entry" ] && continue
    case "$entry" in
      ./*) entry="${entry#./}" ;;
    esac
    [ -z "$entry" ] && continue
    archive_path_is_safe "$entry" || die "unsafe archive entry: $entry"

    case "$listing" in
      l*)
        case "$listing" in
          *" -> "*) target="${listing##* -> }" ;;
          *) die "cannot inspect archive symlink: $entry" ;;
        esac
        case "$target" in
          /* | \\*) die "unsafe archive symlink: $entry -> $target" ;;
        esac
        case "$entry" in
          */*) entry_dir="${entry%/*}" ;;
          *) entry_dir='.' ;;
        esac
        archive_path_is_safe "${entry_dir}/${target}" ||
          die "unsafe archive symlink: $entry -> $target"
        ;;
    esac
  done <"$entries_file" 3<"$verbose_file"
  rm -f "$entries_file" "$verbose_file"
}

extract_archive() {
  archive_path="$1"
  destination="$2"
  validate_archive_entries "$archive_path"
  mkdir -p "$destination"
  tar -xzf "$archive_path" -C "$destination" || die "archive extraction failed"
}

find_extracted_version_dir() {
  staging_dir="$1"
  if [ -f "$staging_dir/distribution.json" ]; then
    printf '%s' "$staging_dir"
    return 0
  fi
  for entry in "$staging_dir"/*; do
    [ -e "$entry" ] || continue
    case "$entry" in
      "$staging_dir"/.*) continue ;;
    esac
    if [ -f "$entry/distribution.json" ]; then
      printf '%s' "$entry"
      return 0
    fi
  done
  die 'cannot locate extracted portable version directory'
}

atomic_symlink() {
  target="$1"
  link_path="$2"
  tmp_link="${link_path}.tmp.$$"
  ln -sfn "$target" "$tmp_link"
  mv "$tmp_link" "$link_path"
}

write_install_state() {
  install_root="$1"
  payload="$2"
  tmp_state="${install_root}/install-state.json.tmp.$$"
  umask 077
  printf '%s\n' "$payload" >"$tmp_state"
  mv "$tmp_state" "${install_root}/install-state.json"
}

read_install_state_field() {
  field="$1"
  install_root="$2"
  state_path="${install_root}/install-state.json"
  if [ ! -f "$state_path" ]; then
    printf ''
    return 0
  fi
  json_field "$field" "$state_path"
}

acquire_install_lock() {
  install_root="$1"
  lock_path="${install_root}/update.lock"
  LOCK_FILE="$lock_path"
  mkdir -p "$install_root"
  attempts=0
  while [ "$attempts" -lt 3 ]; do
    attempts=$((attempts + 1))
    umask 077
    if (
      set -C
      printf '{\n  "pid": %s,\n  "createdAt": "%s"\n}\n' \
        "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$lock_path"
    ) 2>/dev/null; then
      LOCK_HELD=1
      return 0
    fi

    [ -e "$lock_path" ] || continue
    lock_pid="$(json_number_field pid "$lock_path")"
    case "$lock_pid" in
      '' | *[!0-9]*) die "install lock is invalid and cannot be safely removed: $lock_path" ;;
    esac
    if kill -0 "$lock_pid" 2>/dev/null; then
      die "install lock is held by another process (PID ${lock_pid})"
    fi
    if ! have_cmd ps; then
      die "cannot verify whether install lock PID ${lock_pid} is stale"
    fi
    if ps -p "$lock_pid" >/dev/null 2>&1; then
      die "install lock is held by another process (PID ${lock_pid})"
    fi
    rm -f "$lock_path" || die "cannot remove stale install lock: $lock_path"
  done
  die "could not acquire install lock: $lock_path"
}

release_install_lock() {
  if [ "$LOCK_HELD" != "1" ] || [ -z "$LOCK_FILE" ]; then
    return 0
  fi
  lock_pid="$(json_number_field pid "$LOCK_FILE")"
  if [ "$lock_pid" = "$$" ]; then
    rm -f "$LOCK_FILE"
  fi
  LOCK_HELD=0
}

cleanup_staging_dirs() {
  install_root="$1"
  for dir in "${install_root}"/.staging.* "${install_root}"/.staging-* "${install_root}"/staging.*; do
    [ -d "$dir" ] || continue
    rm -rf "$dir"
  done
}

run_health_check() {
  version_dir="$1"
  node_bin="${version_dir}/runtime/bin/node"
  omd_bin="${version_dir}/app/bin/omd"
  if [ ! -x "$node_bin" ]; then
    die "health check failed: missing runtime node at $node_bin"
  fi
  if [ ! -f "$omd_bin" ]; then
    die "health check failed: missing app entry at $omd_bin"
  fi
  health_home="$(mktemp -d "${TMPDIR:-/tmp}/omd-health-home.XXXXXX")"
  health_dsh="$(mktemp -d "${TMPDIR:-/tmp}/omd-health-dsh.XXXXXX")"
  if ! PATH='' HOME="$health_home" DSH_HOME="$health_dsh" "$node_bin" "$omd_bin" --version >/dev/null 2>&1; then
    rm -rf "$health_home" "$health_dsh"
    die 'health check failed: packaged omd --version did not succeed'
  fi
  rm -rf "$health_home" "$health_dsh"
}

verify_distribution_identity() {
  version_dir="$1"
  expected_omd_version="$2"
  expected_platform="$3"
  expected_node_version="$4"
  expected_dsh_version="$5"
  identity_file="${version_dir}/distribution.json"
  [ -f "$identity_file" ] || die "distribution identity is missing: $identity_file"

  actual_omd_version="$(json_field omdVersion "$identity_file")"
  actual_platform="$(json_field platform "$identity_file")"
  actual_node_version="$(json_field nodeVersion "$identity_file")"
  actual_dsh_version="$(json_field dshVersion "$identity_file")"

  [ "$actual_omd_version" = "$expected_omd_version" ] ||
    die "distribution identity omdVersion mismatch (expected $expected_omd_version, got ${actual_omd_version:-missing})"
  [ "$actual_platform" = "$expected_platform" ] ||
    die "distribution identity platform mismatch (expected $expected_platform, got ${actual_platform:-missing})"
  [ "$actual_node_version" = "$expected_node_version" ] ||
    die "distribution identity nodeVersion mismatch (expected $expected_node_version, got ${actual_node_version:-missing})"
  [ "$actual_dsh_version" = "$expected_dsh_version" ] ||
    die "distribution identity dshVersion mismatch (expected $expected_dsh_version, got ${actual_dsh_version:-missing})"
}

resolve_manifest_url() {
  if [ -n "${OMD_MANIFEST_URL:-}" ]; then
    printf '%s' "$OMD_MANIFEST_URL"
    return 0
  fi
  if [ -n "${OMD_VERSION:-}" ]; then
    version_tag="$OMD_VERSION"
    case "$version_tag" in
      v*) requested_version="${version_tag#v}" ;;
      *) requested_version="$version_tag"; version_tag="v${version_tag}" ;;
    esac
    is_valid_omd_version "$requested_version" ||
      die "invalid OMD_VERSION: $OMD_VERSION"
    printf 'https://github.com/%s/releases/download/%s/release-manifest.json' "$OMD_REPO" "$version_tag"
    return 0
  fi
  printf 'https://github.com/%s/releases/latest/download/release-manifest.json' "$OMD_REPO"
}

path_contains_dir() {
  dir="$1"
  old_ifs="$IFS"
  IFS=':'
  for entry in $PATH; do
    if [ "$entry" = "$dir" ]; then
      IFS="$old_ifs"
      return 0
    fi
  done
  IFS="$old_ifs"
  return 1
}

print_path_hint() {
  bin_dir="$1"
  if path_contains_dir "$bin_dir"; then
    return 0
  fi
  shell_path="${SHELL:-}"
  case "$shell_path" in
    */zsh)
      printf '\nAdd oh-my-dsh to your PATH:\n  export PATH="%s:$PATH"\n' "$bin_dir"
      ;;
    */fish)
      printf '\nAdd oh-my-dsh to your PATH:\n  fish_add_path "%s"\n' "$bin_dir"
      ;;
    *)
      printf '\nAdd oh-my-dsh to your PATH:\n  export PATH="%s:$PATH"\n' "$bin_dir"
      ;;
  esac
}

platform="$(detect_platform)"
manifest_url="$(resolve_manifest_url)"
staging_root=""
install_root="$OMD_INSTALL_ROOT"

cleanup() {
  if [ -n "$staging_root" ] && [ -d "$staging_root" ]; then
    rm -rf "$staging_root"
  fi
  if [ -n "$manifest_file" ]; then
    rm -f "$manifest_file"
  fi
  release_install_lock 2>/dev/null || true
}
trap cleanup EXIT INT TERM

acquire_install_lock "$install_root"
cleanup_staging_dirs "$install_root"

manifest_file="$(mktemp "${TMPDIR:-/tmp}/omd-manifest.XXXXXX")"
case "$manifest_url" in
  file://*) fetch_url "$manifest_url" "$manifest_file" ;;
  /*) cp "$manifest_url" "$manifest_file" ;;
  *)
    fetch_url "$manifest_url" "$manifest_file" || die "failed to fetch release manifest from $manifest_url"
    ;;
esac

schema_version="$(json_number_field schemaVersion "$manifest_file")"
if [ "$schema_version" != "1" ]; then
  die "unsupported release manifest schema version: ${schema_version:-unknown}"
fi

channel="$(json_field channel "$manifest_file")"
if [ "$channel" != "stable" ]; then
  die "unsupported release manifest channel: ${channel:-unknown}"
fi

omd_version="$(json_field omdVersion "$manifest_file")"
is_valid_omd_version "$omd_version" ||
  die 'invalid release manifest omdVersion'

artifact_filename="$(artifact_field "$platform" filename "$manifest_file")"
artifact_sha256="$(artifact_field "$platform" sha256 "$manifest_file")"
artifact_url="$(artifact_field "$platform" url "$manifest_file")"
artifact_platform="$(artifact_field "$platform" platform "$manifest_file")"
artifact_node_version="$(artifact_field "$platform" nodeVersion "$manifest_file")"
artifact_dsh_version="$(artifact_field "$platform" dshVersion "$manifest_file")"

if [ -z "$artifact_filename" ] || [ -z "$artifact_sha256" ] || [ -z "$artifact_url" ] ||
  [ -z "$artifact_platform" ] || [ -z "$artifact_node_version" ] ||
  [ -z "$artifact_dsh_version" ]; then
  die "no artifact available for platform ${platform} in release ${omd_version}"
fi
is_valid_artifact_filename "$artifact_filename" ||
  die "invalid artifact filename: $artifact_filename"
is_valid_sha256 "$artifact_sha256" ||
  die "invalid artifact sha256 for $artifact_filename"
[ "$artifact_platform" = "$platform" ] ||
  die "artifact platform mismatch (expected $platform, got $artifact_platform)"
artifact_sha256="$(printf '%s' "$artifact_sha256" | tr 'A-F' 'a-f')"

validate_artifact_url "$artifact_url"

staging_root="$(mktemp -d "${install_root}/.staging.XXXXXX")"
archive_path="${staging_root}/artifact.tar.gz"
fetch_url "$artifact_url" "$archive_path"

digest="$(sha256_file "$archive_path")"
digest="$(printf '%s' "$digest" | tr 'A-F' 'a-f')"
if [ "$digest" != "$artifact_sha256" ]; then
  die "artifact checksum mismatch (expected ${artifact_sha256}, got ${digest})"
fi

extract_dir="${staging_root}/extract"
extract_archive "$archive_path" "$extract_dir"
version_dir="$(find_extracted_version_dir "$extract_dir")"
verify_distribution_identity \
  "$version_dir" "$omd_version" "$platform" "$artifact_node_version" "$artifact_dsh_version"
run_health_check "$version_dir"

mkdir -p "${install_root}/versions"
target_dir="${install_root}/versions/${omd_version}"
rm -rf "$target_dir"
mv "$version_dir" "$target_dir"

old_current="$(read_install_state_field currentVersion "$install_root")"
old_previous="$(read_install_state_field previousVersion "$install_root")"
installed_at="$(read_install_state_field installedAt "$install_root")"
if [ -z "$installed_at" ]; then
  installed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

write_install_state "$install_root" "$(cat <<EOF
{
  "schemaVersion": 1,
  "currentVersion": "${omd_version}",
  "previousVersion": $(json_string_or_null "$old_current"),
  "installedAt": "${installed_at}",
  "updatedAt": "${now}",
  "openTransaction": {
    "op": "install",
    "candidateVersion": "${omd_version}",
    "oldCurrent": $(json_string_or_null "$old_current"),
    "oldPrevious": $(json_string_or_null "$old_previous"),
    "startedAt": "${now}"
  },
  "verifiedArtifacts": {}
}
EOF
)"

if [ -n "$old_current" ] && [ "$old_current" != "$omd_version" ]; then
  atomic_symlink "versions/${old_current}" "${install_root}/previous"
fi
atomic_symlink "versions/${omd_version}" "${install_root}/current"

if [ -n "$old_current" ] && [ "$old_current" != "$omd_version" ]; then
  previous_version="$old_current"
elif [ -n "$old_previous" ] && [ "$old_previous" != "$omd_version" ]; then
  previous_version="$old_previous"
else
  previous_version=""
fi

write_install_state "$install_root" "$(cat <<EOF
{
  "schemaVersion": 1,
  "currentVersion": "${omd_version}",
  "previousVersion": $(json_string_or_null "$previous_version"),
  "installedAt": "${installed_at}",
  "updatedAt": "${now}",
  "openTransaction": null,
  "verifiedArtifacts": {
    "${omd_version}": {
      "sha256": "${artifact_sha256}",
      "url": "${artifact_url}",
      "platform": "${platform}"
    }
  }
}
EOF
)"

mkdir -p "$OMD_BIN_DIR"
atomic_symlink "${install_root}/current/bin/omd" "${OMD_BIN_DIR}/omd"

printf 'Installed oh-my-dsh %s for %s.\n' "$omd_version" "$platform"
printf 'Run `%s` to get started.\n' "${OMD_BIN_DIR}/omd"
print_path_hint "$OMD_BIN_DIR"
