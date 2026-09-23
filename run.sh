#!/usr/bin/env sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

for task_command in node npx uv; do
  if ! command -v "$task_command" >/dev/null 2>&1; then
    printf 'Для запуска требуется %s. См. README.md.\n' "$task_command" >&2
    exit 1
  fi
done
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) { console.error("Требуется Node.js 22.12 или новее."); process.exit(1); }'

cd frontend
task_package_manager=$(node -p 'require("./package.json").packageManager')
npx --yes "$task_package_manager" install --frozen-lockfile
npx --yes "$task_package_manager" build
cd ..
printf '\nСайт: http://127.0.0.1:%s\n' "${PORT:-8000}"
exec ./backend/run.sh
