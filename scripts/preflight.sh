#!/usr/bin/env bash
# preflight.sh — 推之前跑这一个。
#
# 为什么存在：`ace070c` 把 selfcheck.ts 里的一句 import 推上去了，而被 import 的
# riskExplain.ts 留在本地没交。于是任何人 pull 之后 `node src/selfcheck.ts` 直接
# ERR_MODULE_NOT_FOUND —— 整套断言跑不起来，而本地永远是绿的，因为文件还在磁盘上。
# 同类事故这一周已经出现两次（另一次是 A 的改动让 selfcheck 三条断言过期）。
#
# 结论：**门禁必须在一个"只有 git 里有的东西"的状态下跑**。这个脚本不做 checkout，
# 但它至少保证三件事都会被执行到，并且以非零退出码结束，不会有人"看了一眼没报错"。
#
#   bash scripts/preflight.sh
#
# 三个门禁（docs/dev.md:884 写的就是这三个）：
#   1. web  纯函数断言      node src/selfcheck.ts
#   2. web  类型            tsc --noEmit
#   3. backend 断言          python selfcheck.py（必须用 venv 的 python，系统缺 numpy）

set -u
root="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

run() {
  local name="$1"
  shift
  echo "── $name"
  if "$@"; then
    echo "   PASS"
  else
    echo "   FAIL"
    fail=1
  fi
}

cd "$root/web" || exit 2
run "web selfcheck" node src/selfcheck.ts
run "web tsc" node node_modules/typescript/bin/tsc --noEmit

cd "$root/backend" || exit 2
if [ -x .venv/Scripts/python.exe ]; then
  py=.venv/Scripts/python.exe
elif [ -x .venv/bin/python ]; then
  py=.venv/bin/python
else
  py="$(command -v python3 || command -v python)"
  echo "   (警告：没有 .venv，用 $py —— 缺 numpy 会失败)"
fi
run "backend selfcheck" "$py" selfcheck.py

echo
if [ "$fail" -ne 0 ]; then
  echo "preflight: FAIL —— 不要推。"
  exit 1
fi
echo "preflight: OK —— 可以推。"
