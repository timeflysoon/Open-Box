#!/bin/sh
# 构建 openbox-core。
#
# 用法: sh core/scripts/build.sh <amd64|arm64> <outdir> [index.mjs 路径]
#
# buildID:Node 端(panel/server/index.mjs)里写死了期望值,hello 返回的必须与它相同。
# 默认从 panel/server/index.mjs 里读出来;也可以用环境变量 OPENBOX_CORE_BUILD_ID 指定。
#
# 产出:
#   <outdir>/openbox-core      静态链接、去符号的 linux 二进制
#   <outdir>/core-build.json   protocol/implementation/buildID/goVersion/os/arch/sha256/size
#                              (不写 bindingSha256;键的顺序要和 hardening-manifest.json 的 core 一致)
set -eu

die() { echo "[core-build] 错误:$*" >&2; exit 1; }

[ "$#" -ge 2 ] || die "用法: $0 <amd64|arm64> <outdir> [index.mjs]"
case "$1" in
  amd64|x64) GOARCH=amd64 ;;
  arm64) GOARCH=arm64 ;;
  *) die "不支持的架构:$1" ;;
esac
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CORE=$(CDPATH= cd -- "$HERE/.." && pwd)
mkdir -p "$2"
OUT=$(CDPATH= cd -- "$2" && pwd)
INDEX="${3:-$CORE/../panel/server/index.mjs}"

ID="${OPENBOX_CORE_BUILD_ID:-}"
if [ -z "$ID" ]; then
  [ -f "$INDEX" ] || die "找不到 $INDEX,也没有设置 OPENBOX_CORE_BUILD_ID"
  ID=$(python3 - "$INDEX" <<'PY'
import re, sys
t = open(sys.argv[1], encoding='utf-8', errors='replace').read()
# 形如  Re=qE(GE,"<64位hex>")  的核心桥接初始化
m = re.findall(r'[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*,"([0-9a-f]{64})"\)', t)
print(m[0] if len(set(m)) == 1 else '')
PY
)
fi
case "$ID" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) [ "${#ID}" = 64 ] || die "buildID 不是 64 位十六进制:$ID" ;;
  *) die "没能确定 buildID(index.mjs 里的写法可能变了)" ;;
esac
echo "[core-build] buildID=$ID arch=$GOARCH"

cd "$CORE"
GOVER=$(go env GOVERSION | sed 's/^go//')
CGO_ENABLED=0 GOOS=linux GOARCH=$GOARCH go build -trimpath \
  -ldflags "-s -w -X github.com/timeflysoon/Open-Box/core/internal/protocol.BuildID=$ID" \
  -o "$OUT/openbox-core" ./cmd/openbox-core
chmod +x "$OUT/openbox-core"

python3 - "$OUT" "$ID" "$GOARCH" "$GOVER" <<'PY'
import hashlib, json, sys
out, bid, arch, gover = sys.argv[1:5]
b = open(out + '/openbox-core', 'rb').read()
core = {
    'protocol': 1, 'implementation': 'go-native', 'buildID': bid, 'goVersion': gover,
    'os': 'linux', 'arch': arch, 'sha256': hashlib.sha256(b).hexdigest(), 'size': len(b),
}
open(out + '/core-build.json', 'w', encoding='utf-8', newline='\n').write(json.dumps(core, indent=2) + '\n')
print('[core-build] sha256=' + core['sha256'], 'size=%d' % len(b))
PY
