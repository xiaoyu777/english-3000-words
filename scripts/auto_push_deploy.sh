#!/usr/bin/env sh
set -eu

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$repo_root"

if [ "${AUTO_PUSH_DEPLOY:-1}" = "0" ]; then
  log "AUTO_PUSH_DEPLOY=0; skipped."
  exit 0
fi

if [ "${AUTO_PUSH_DEPLOY_RUNNING:-}" = "1" ]; then
  log "Already running; skipped nested invocation."
  exit 0
fi
export AUTO_PUSH_DEPLOY_RUNNING=1

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" = "HEAD" ]; then
  log "Detached HEAD; cannot auto push."
  exit 1
fi

remote=${AUTO_PUSH_DEPLOY_REMOTE:-origin}
upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)

push_with_git_auth() {
  if [ -n "$upstream" ]; then
    GIT_TERMINAL_PROMPT=0 git push "$remote" "$branch"
  else
    GIT_TERMINAL_PROMPT=0 git push -u "$remote" "$branch"
  fi
}

push_with_token_file() {
  token_file=${GITHUB_TOKEN_FILE:-"$repo_root/Github_Codex_Tokens.txt"}
  [ -f "$token_file" ] || return 1

  token=$(grep -Eo 'github_pat_[A-Za-z0-9_]+' "$token_file" | head -n 1 || true)
  if [ -z "$token" ]; then
    token=$(grep -Eo 'ghp_[A-Za-z0-9_]+' "$token_file" | head -n 1 || true)
  fi
  [ -n "$token" ] || return 1

  askpass=$(mktemp "${TMPDIR:-/tmp}/git-askpass.XXXXXX")
  trap 'rm -f "$askpass"' EXIT HUP INT TERM
  cat > "$askpass" <<'EOF'
#!/bin/sh
case "$1" in
  *Username*) printf %s x-access-token ;;
  *Password*) printf %s "$GITHUB_TOKEN_FOR_PUSH" ;;
  *) printf %s "$GITHUB_TOKEN_FOR_PUSH" ;;
esac
EOF
  chmod 700 "$askpass"

  GIT_ASKPASS="$askpass" \
  GIT_TERMINAL_PROMPT=0 \
  GITHUB_TOKEN_FOR_PUSH="$token" \
  git push "$remote" "$branch"
}

log "Pushing $branch to $remote..."
if [ "${AUTO_PUSH_DEPLOY_DRY_RUN:-0}" = "1" ]; then
  log "DRY RUN: would push $branch to $remote, then deploy with Netlify mode ${AUTO_PUSH_DEPLOY_NETLIFY_MODE:-git}."
  exit 0
fi

if push_with_git_auth; then
  log "GitHub push succeeded."
elif push_with_token_file; then
  log "GitHub push succeeded via token file."
else
  log "GitHub push failed. Configure git credentials or GITHUB_TOKEN_FILE."
  exit 1
fi

if [ "${AUTO_PUSH_DEPLOY_SKIP_NETLIFY:-0}" = "1" ]; then
  log "AUTO_PUSH_DEPLOY_SKIP_NETLIFY=1; Netlify deploy skipped."
  exit 0
fi

deploy_mode=${AUTO_PUSH_DEPLOY_NETLIFY_MODE:-git}
site_id=${NETLIFY_SITE_ID:-}
if [ -z "$site_id" ] && [ -f "$repo_root/.netlify/state.json" ]; then
  site_id=$(sed -n 's/.*"siteId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$repo_root/.netlify/state.json" | head -n 1)
fi

if [ "$deploy_mode" = "build-hook" ]; then
  if [ -z "${NETLIFY_BUILD_HOOK_URL:-}" ]; then
    log "NETLIFY_BUILD_HOOK_URL is required for build-hook mode."
    exit 1
  fi
  log "Triggering Netlify build hook..."
  curl -fsS -X POST "$NETLIFY_BUILD_HOOK_URL" >/dev/null
  log "Netlify build hook triggered."
  exit 0
fi

if [ "$deploy_mode" = "git" ]; then
  log "Netlify mode is git; relying on Netlify GitHub auto deploy after push."
  exit 0
fi

if [ "$deploy_mode" != "cli" ]; then
  log "Unknown AUTO_PUSH_DEPLOY_NETLIFY_MODE=$deploy_mode."
  exit 1
fi

if [ -z "$site_id" ]; then
  log "Netlify site id not found. Set NETLIFY_SITE_ID or run netlify link."
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  log "npx not found; cannot run Netlify CLI."
  exit 1
fi

log "Deploying to Netlify site $site_id..."
npx --yes netlify deploy --prod --dir="$repo_root" --site="$site_id"
log "Netlify deploy completed."
