#!/bin/sh
# 从上游(默认 liandu2024/Open-Box)的 Release 取现成的 sing-box 内核,代替自己编译。
#
# 用法: sh scripts/fetch-upstream-kernel.sh <amd64|arm64> <outdir>
#
# 环境变量:
#   OPENBOX_KERNEL_REPO   上游仓库,默认 liandu2024/Open-Box
#   OPENBOX_KERNEL_TAG    固定到某个上游版本(如 v0.1.283);留空 = 取 Latest
#
# 为什么不自己编:上游内核带着一批没有公开的补丁(直连应答放行、出站热替换、tun 放行标记等),
# 面板的某些功能要靠它们,而这些补丁的内容不在公开仓库里,只能取现成的二进制。
#
# 产出(与自己编译时的目录布局一致,build-release.sh 不用区分来源):
#   <outdir>/sing-box-<内核版本>-linux-<arch>-musl/{sing-box,LICENSE,BUILD-INFO.json}
#   <outdir>/sing-box-<内核版本>-source.tar.gz(+ .sha256)   对应源码,发布时一并附上
#   <outdir>/compat/libobmadvise-*.so                          缺 madvise 固件用的兼容库(取不到只警告)
#   <outdir>/KERNEL-SOURCE.txt                                 来源记录
#
# 校验:内核包的 sha256 同时对照 components.json 和 .sha256 文件,再核对 BUILD-INFO.json 里
# 记录的二进制哈希、架构、版本。任何一项不符都直接失败。
set -eu

REPO="${OPENBOX_KERNEL_REPO:-liandu2024/Open-Box}"
TAG="${OPENBOX_KERNEL_TAG:-}"

die() { echo "[fetch-kernel] 错误:$*" >&2; exit 1; }
log() { echo "[fetch-kernel] $*" >&2; }

[ "$#" -eq 2 ] || die "用法: $0 <amd64|arm64> <outdir>"
case "$1" in
  amd64|x64) GOARCH=amd64; ASSET_ARCH=x64 ;;
  arm64) GOARCH=arm64; ASSET_ARCH=arm64 ;;
  *) die "不支持的架构:$1(应为 amd64 或 arm64)" ;;
esac
mkdir -p "$2"
OUT=$(CDPATH= cd -- "$2" && pwd)

command -v curl >/dev/null 2>&1 || die "需要 curl"
command -v python3 >/dev/null 2>&1 || die "需要 python3"

BASE="https://github.com/$REPO/releases"
fetch() { curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 -o "$2" "$1"; }

# ---- 1. 定下版本:没指定就看 releases/latest 跳转到哪个 tag(不走 api.github.com,没有限流)----
if [ -z "$TAG" ]; then
  TAG=$(curl -sI --retry 3 --retry-delay 2 --connect-timeout 20 "$BASE/latest" \
    | tr -d '\r' | sed -n 's/^[Ll]ocation: .*\/releases\/tag\/\(v[0-9][0-9A-Za-z._-]*\).*/\1/p' | head -n 1)
fi
case "$TAG" in
  v[0-9]*) ;;
  *) die "无法确定上游版本(取到的是「$TAG」)。可用 OPENBOX_KERNEL_TAG=vX.Y.Z 指定。" ;;
esac
case "$TAG" in *[!A-Za-z0-9._-]*) die "版本号含非法字符:$TAG" ;; esac
log "上游 $REPO 版本:$TAG(架构 $GOARCH)"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/open-box-kernel.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM

# ---- 2. 读组件清单,取出内核与 app 两个组件的资产名和 sha256 ----
fetch "$BASE/download/$TAG/open-box-$TAG-linux-$ASSET_ARCH-components.json" "$TMP/components.json" \
  || die "下载组件清单失败:$BASE/download/$TAG/open-box-$TAG-linux-$ASSET_ARCH-components.json"
FIELDS=$(python3 - "$TMP/components.json" <<'PY'
import json, re, sys
d = json.load(open(sys.argv[1]))
def pick(name, required):
    c = d.get('components', {}).get(name)
    if not c:
        if required:
            raise SystemExit(f'组件清单里没有 {name}')
        return ['-', '-', '-']
    ver, asset, sha = str(c.get('version', '')), str(c.get('asset', '')), str(c.get('sha256', ''))
    if not re.fullmatch(r'[0-9A-Za-z._-]+', ver): raise SystemExit(f'{name} 版本号异常: {ver}')
    if not re.fullmatch(r'open-box-[0-9A-Za-z._-]+\.tar\.gz', asset): raise SystemExit(f'{name} 资产名异常: {asset}')
    if not re.fullmatch(r'[0-9a-f]{64}', sha): raise SystemExit(f'{name} sha256 异常')
    return [ver, asset, sha]
print(' '.join(pick('kernel', True) + pick('app', False)))
PY
) || die "解析组件清单失败"
# shellcheck disable=SC2086
set -- $FIELDS
KERNEL_VERSION=$1; KERNEL_ASSET=$2; KERNEL_SHA=$3; APP_ASSET=$5; APP_SHA=$6
log "内核版本:$KERNEL_VERSION"

sha_of() { python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }
# 下载并同时核对 components.json 与 .sha256 文件两处记录
fetch_verified() { # <资产名> <期望sha256> <目标文件>
  fetch "$BASE/download/$TAG/$1" "$3" || die "下载失败:$1"
  [ "$(sha_of "$3")" = "$2" ] || die "$1 的 sha256 与组件清单不符"
  if fetch "$BASE/download/$TAG/$1.sha256" "$3.sha256" 2>/dev/null; then
    [ "$(awk 'NR==1{print $1}' "$3.sha256")" = "$2" ] || die "$1 的 sha256 与 .sha256 文件不符"
  fi
}

# ---- 3. 内核包:下载、校验、解包 ----
fetch_verified "$KERNEL_ASSET" "$KERNEL_SHA" "$TMP/kernel.tar.gz"
tar -tzf "$TMP/kernel.tar.gz" | while IFS= read -r entry; do
  case "$entry" in
    bin/|bin/sing-box|bin/sing-box.LICENSE|bin/sing-box.BUILD-INFO.json) ;;
    *) die "内核包里有预期之外的文件:$entry" ;;
  esac
done
mkdir -p "$TMP/k"
tar -xzf "$TMP/kernel.tar.gz" -C "$TMP/k"
for f in sing-box sing-box.LICENSE sing-box.BUILD-INFO.json; do
  [ -f "$TMP/k/bin/$f" ] || die "内核包缺少 bin/$f"
done

python3 - "$TMP/k/bin/sing-box.BUILD-INFO.json" "$TMP/k/bin/sing-box" "$KERNEL_VERSION" "$GOARCH" <<'PY' || die "内核 BUILD-INFO 校验失败"
import hashlib, json, sys
info = json.load(open(sys.argv[1]))
sha = hashlib.sha256(open(sys.argv[2], 'rb').read()).hexdigest()
assert info.get('version') == sys.argv[3], f"版本不符: {info.get('version')} != {sys.argv[3]}"
assert info.get('arch') == sys.argv[4], f"架构不符: {info.get('arch')} != {sys.argv[4]}"
assert info.get('binary_sha256') == sha, '二进制哈希与 BUILD-INFO 记录不符'
PY

BUNDLE="$OUT/sing-box-$KERNEL_VERSION-linux-$GOARCH-musl"
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE"
cp "$TMP/k/bin/sing-box" "$BUNDLE/sing-box"
chmod +x "$BUNDLE/sing-box"
cp "$TMP/k/bin/sing-box.LICENSE" "$BUNDLE/LICENSE"
cp "$TMP/k/bin/sing-box.BUILD-INFO.json" "$BUNDLE/BUILD-INFO.json"
log "内核已就绪:$BUNDLE"

# ---- 4. 对应源码(GPL:分发二进制就要能拿到对应源码;发布时附在 Release 里)----
SRC="sing-box-$KERNEL_VERSION-source.tar.gz"
if fetch "$BASE/download/$TAG/$SRC" "$OUT/$SRC" && fetch "$BASE/download/$TAG/$SRC.sha256" "$OUT/$SRC.sha256"; then
  [ "$(awk 'NR==1{print $1}' "$OUT/$SRC.sha256")" = "$(sha_of "$OUT/$SRC")" ] \
    || die "$SRC 的 sha256 校验失败"
  log "对应源码已取回:$SRC"
else
  rm -f "$OUT/$SRC" "$OUT/$SRC.sha256"
  die "取不到内核对应源码 $SRC;没有源码不能分发这个二进制"
fi

# ---- 5. 缺 madvise 的固件用的兼容库(属于上游 app 组件;取不到只警告,不影响其它固件)----
if [ "$APP_ASSET" != "-" ]; then
  if fetch_verified "$APP_ASSET" "$APP_SHA" "$TMP/app.tar.gz" 2>/dev/null; then
    mkdir -p "$TMP/app" "$OUT/compat"
    if tar -xzf "$TMP/app.tar.gz" -C "$TMP/app" openwrt/bin/compat 2>/dev/null; then
      cp "$TMP/app/openwrt/bin/compat/"libobmadvise-*.so "$OUT/compat/" 2>/dev/null \
        && log "已取回兼容库:$(ls "$OUT/compat" | tr '\n' ' ')" \
        || log "警告:上游 app 组件里没有 libobmadvise-*.so,缺 madvise 的固件将没有兼容库"
    fi
  else
    log "警告:没取到上游 app 组件,缺 madvise 的固件将没有兼容库"
  fi
fi

{
  echo "repo=$REPO"
  echo "tag=$TAG"
  echo "kernel_version=$KERNEL_VERSION"
  echo "arch=$GOARCH"
  echo "fetched_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$OUT/KERNEL-SOURCE.txt"
log "完成:内核 $KERNEL_VERSION 来自 $REPO@$TAG"
