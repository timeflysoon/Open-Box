#!/bin/sh
# Static TCP DNS compatibility build (slim by default, OPENBOX_KERNEL_FULL=1 for the full CGO/musl build). Does not deploy or publish.
set -eu

hotfix_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$hotfix_dir/versions.sh"
export SINGBOX_SOURCE_SHA256
hotfix_arch=${1:-amd64}
case "$hotfix_arch" in amd64|arm64) ;; *) echo 'Expected amd64 or arm64' >&2; exit 2 ;; esac
hotfix_output=${2:-"$hotfix_dir/../../.build-cache/tcp-dns-hotfix"}
mkdir -p "$hotfix_output"
hotfix_output=$(CDPATH= cd -- "$hotfix_output" && pwd)
hotfix_work=$(mktemp -d "${TMPDIR:-/tmp}/openbox-tcp-dns-build.XXXXXX")
hotfix_go=${OPENBOX_GO_BINARY:-go}
hotfix_version=$SINGBOX_VERSION
# 内核功能集(决定体积,约差一倍):
#   slim(默认):只保留面板实际用到的协议,纯 Go 静态链接(CGO=0),不需要 clang / musl 工具链。
#   full(OPENBOX_KERNEL_FULL=1):sing-box 官方完整 tag + CGO/musl(含 Naive 的 Cronet、Tailscale、
#     Cloudflared、OpenVPN 等),体积约 88MB;只有确实要用 Naive 出站时才开。
hotfix_full=${OPENBOX_KERNEL_FULL:-0}
hotfix_cc=
hotfix_cxx=
if [ "$hotfix_full" = 1 ]; then
  if [ -n "${CC:-}" ] && [ -n "${CXX:-}" ]; then
    hotfix_cc=$CC
    hotfix_cxx=$CXX
  else
    . "$hotfix_dir/toolchain.sh"
  fi
fi

printf 'Build workspace: %s\n' "$hotfix_work"
"$hotfix_go" version
if [ -n "${OPENBOX_SINGBOX_SOURCE_ARCHIVE:-}" ]; then
  cp "$OPENBOX_SINGBOX_SOURCE_ARCHIVE" "$hotfix_work/source.tar.gz"
else
  curl -fSL --connect-timeout 10 --max-time 120 \
    "https://codeload.github.com/SagerNet/sing-box/tar.gz/refs/tags/v$SINGBOX_UPSTREAM_VERSION" \
    -o "$hotfix_work/source.tar.gz"
fi
if command -v sha256sum >/dev/null 2>&1; then
  hotfix_actual=$(sha256sum "$hotfix_work/source.tar.gz" | awk '{print $1}')
else
  hotfix_actual=$(shasum -a 256 "$hotfix_work/source.tar.gz" | awk '{print $1}')
fi
[ "$hotfix_actual" = "$SINGBOX_SOURCE_SHA256" ] || { echo 'Source archive checksum mismatch' >&2; exit 1; }
tar -xzf "$hotfix_work/source.tar.gz" -C "$hotfix_work"
cd "$hotfix_work/sing-box-$SINGBOX_UPSTREAM_VERSION"
patch -p1 < "$hotfix_dir/tcp-dns-short-connections.patch"
patch -p1 < "$hotfix_dir/http-latency.patch"
cp "$hotfix_dir/tcp_short_connection_test.go" dns/transport/openbox_tcp_test.go
cp "$hotfix_dir/http_latency_test.go" common/urltest/openbox_http_test.go

if [ "$hotfix_full" = 1 ]; then
  # 保留上游完整功能集,包括 Naive 的静态 Cronet 库。
  hotfix_tags="$(cat release/DEFAULT_BUILD_TAGS),with_musl"
  hotfix_cgo=1
else
  # 精简集:面板生成的配置只用到 TUN(gvisor 栈)、QUIC 系协议(hysteria2 / tuic)、WireGuard、
  # uTLS(reality)、DHCP、Clash API。每个 tag 都必须存在于上游 DEFAULT_BUILD_TAGS,
  # 升级 sing-box 版本后上游改了名字会在这里直接失败,而不是悄悄少编一个功能。
  hotfix_tags="with_gvisor,with_quic,with_dhcp,with_wireguard,with_utls,with_clash_api,badlinkname,tfogo_checklinkname0"
  hotfix_cgo=0
  for hotfix_tag in $(printf '%s' "$hotfix_tags" | tr ',' ' '); do
    case ",$(cat release/DEFAULT_BUILD_TAGS)," in
      *",$hotfix_tag,"*) ;;
      *) echo "Build tag $hotfix_tag is not in upstream release/DEFAULT_BUILD_TAGS" >&2; exit 1 ;;
    esac
  done
fi
export OPENBOX_KERNEL_FULL="$hotfix_full" OPENBOX_KERNEL_TAGS="$hotfix_tags"
CGO_ENABLED=0 GOMAXPROCS=2 "$hotfix_go" test -p 2 -count=1 -timeout 30s \
  ./dns/transport ./common/urltest -run '^TestOpenBox(TCPDNS|HTTP)' -v
hotfix_bundle="$hotfix_output/sing-box-$hotfix_version-linux-$hotfix_arch-musl"
mkdir -p "$hotfix_bundle"
hotfix_binary="$hotfix_bundle/sing-box"
hotfix_ldflags="-X github.com/sagernet/sing-box/constant.Version=$hotfix_version -X runtime.godebugDefault=multipathtcp=0,tlssha1=1 -checklinkname=0 -s -w -buildid="
if [ "$hotfix_cgo" = 1 ]; then
  CGO_ENABLED=1 GOOS=linux GOARCH="$hotfix_arch" GOMAXPROCS=2 \
    CC="$hotfix_cc" CXX="$hotfix_cxx" CGO_LDFLAGS="${CGO_LDFLAGS:--fuse-ld=lld}" \
    "$hotfix_go" build -p 2 -trimpath -tags "$hotfix_tags" \
    -ldflags "$hotfix_ldflags" -o "$hotfix_binary.tmp" ./cmd/sing-box
else
  CGO_ENABLED=0 GOOS=linux GOARCH="$hotfix_arch" GOMAXPROCS=2 \
    "$hotfix_go" build -p 2 -trimpath -tags "$hotfix_tags" \
    -ldflags "$hotfix_ldflags" -o "$hotfix_binary.tmp" ./cmd/sing-box
fi
python3 "$hotfix_dir/../dt-needed.py" --assert-static "$hotfix_binary.tmp"
mv "$hotfix_binary.tmp" "$hotfix_binary"
cp LICENSE "$hotfix_bundle/LICENSE"
python3 "$hotfix_dir/manifest.py" create "$hotfix_bundle" "$hotfix_arch" "$hotfix_version" "$PWD" "$hotfix_go"
python3 "$hotfix_dir/manifest.py" verify "$hotfix_bundle" "$hotfix_arch" "$hotfix_version"
# Publish the exact patched source and repository build inputs alongside the
# application packages. Go modules remain pinned by go.mod/go.sum.
hotfix_source_bundle="$hotfix_work/source-bundle"
cp -R "$PWD" "$hotfix_source_bundle"
mkdir -p "$hotfix_source_bundle/open-box-patch"
cp "$hotfix_dir"/*.sh "$hotfix_dir"/*.py "$hotfix_dir"/*.go "$hotfix_dir"/*.patch "$hotfix_dir/README.md" "$hotfix_source_bundle/open-box-patch/"
cp "$hotfix_dir/../dt-needed.py" "$hotfix_source_bundle/open-box-patch/"
COPYFILE_DISABLE=1 tar -czf "$hotfix_output/sing-box-$hotfix_version-source.tar.gz" -C "$hotfix_work" source-bundle
printf 'Complete static musl binary: %s\n' "$hotfix_binary"
if [ "$hotfix_full" = 1 ]; then
  printf 'Full feature set, includes with_naive_outbound. No deployment or release was performed.\n'
else
  printf 'Slim feature set (no Naive / Tailscale / Cloudflared). No deployment or release was performed.\n'
fi
