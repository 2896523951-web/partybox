#!/bin/sh
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "没找到 Node.js，去 https://nodejs.org 装一个 LTS 版本。"
  exit 1
fi

echo "正在启动… 打开 http://localhost:3210/host"
(sleep 2 && (open http://localhost:3210/host 2>/dev/null || xdg-open http://localhost:3210/host 2>/dev/null)) &
node server.js
