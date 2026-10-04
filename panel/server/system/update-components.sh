# Sourced by update.sh after channel, temporary directory and download helpers are ready.
# All URLs come from the same Open-Box release; the manifest contains asset names, never URLs.
prepare_component_update() {
  _component_helper="$INSTALL_ROOT/panel/server/system/component-update.mjs"
  _component_node="$INSTALL_ROOT/node/bin/node"
  [ -f "$_component_helper" ] && [ -x "$_component_node" ] || return 1
  # 内核缺 madvise 的设备上 Node 要带兼容库(安装 / 升级脚本的冒烟测试记在 data/node-preload,GitHub #290 #293)。
  # || true:update.sh 是 set -eu,文件不在(绝大多数机器)时 cat 失败会让整个升级退出
  _component_preload=$(cat "$INSTALL_ROOT/data/node-preload" 2>/dev/null || true)
  if [ -n "$EXPECT_VERSION" ]; then
    _manifest_name="open-box-${EXPECT_VERSION}-linux-${ARCH}-components.json"
    _manifest_base="https://github.com/$REPO/releases/download/$EXPECT_VERSION"
  else
    _manifest_name="open-box-linux-${ARCH}-components.json"
    _manifest_base="https://github.com/$REPO/releases/latest/download"
  fi
  info "读取 Open-Box 组件版本清单..."
  # 清单和它的校验文件都先直连 GitHub 取(update.sh 的 fetch_to_file_trusted;跑的是还没有它的老 update.sh 就照旧
  # 走通道):清单里写着每个组件的哈希,它来自 GitHub 本身时,镜像给的组件正文就换不掉(审查第七项)
  if command -v fetch_to_file_trusted >/dev/null 2>&1; then
    _component_fetch() { fetch_to_file_trusted "$1" "$2" "${3:-}"; }
  else
    _component_fetch() { fetch_to_file "$(build_url "$1")" "$2"; }
  fi
  # Old releases have only the full installer; retain the existing upgrade path for those.
  if ! _component_fetch "$_manifest_base/$_manifest_name" "$TMP_DL/components.json"; then
    warn "未取到组件清单，改用完整安装包升级。"
    return 1
  fi
  # 清单自己的 SHA256(发布时 scripts/release-components.py 生成):以前生成了却从不核对
  if _component_fetch "$_manifest_base/$_manifest_name.sha256" "$TMP_DL/components.json.sha256" sha; then
    _component_want=$(awk 'NR==1{print $1}' "$TMP_DL/components.json.sha256" 2>/dev/null || true)
    if command -v sha256sum >/dev/null 2>&1; then
      _component_have=$(sha256sum "$TMP_DL/components.json" | awk '{print $1}')
    else
      _component_have=$(shasum -a 256 "$TMP_DL/components.json" | awk '{print $1}')
    fi
    [ -n "$_component_want" ] && [ "$_component_want" = "$_component_have" ] || die "组件清单校验失败(SHA256 不匹配),现有安装未改动。"
  else
    warn "未取到组件清单的校验文件,只按清单内容校验。"
  fi
  check_cancel_and_abort
  LD_PRELOAD="$_component_preload" LD_LIBRARY_PATH="$INSTALL_ROOT/node/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
    "$_component_node" "$_component_helper" plan "$TMP_DL/components.json" "$INSTALL_ROOT" "$ARCH" "$EXPECT_VERSION" \
    > "$TMP_DL/components.plan" || die "组件清单校验失败，现有安装未改动。"
  # Pin the download URL to the version inside the checked manifest (also when latest moved).
  _component_version=$(sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$TMP_DL/components.json" | head -n 1)
  _component_base="https://github.com/$REPO/releases/download/$_component_version"
  STAGE_DIR="$INSTALL_ROOT/.update-stage.$$"
  safe_rm_rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR" || die "无法创建升级暂存目录。"
  UPDATE_COMPONENTS="panel openwrt debian"
  while read -r _kind _action _name _hash _size; do
    check_cancel_and_abort
    case "$_kind" in
      app|runtime|kernel|geo) ;;
      *) die "未知更新组件:$_kind" ;;
    esac
    if [ "$_action" = "reuse" ]; then
      info "$_kind 版本及文件校验一致，复用本地文件，不下载。"
      case "$_kind" in
        runtime) ln -s "$INSTALL_ROOT/node" "$STAGE_DIR/node" || die "无法复用 Node。" ;;
        kernel) ln -s "$INSTALL_ROOT/bin" "$STAGE_DIR/bin" || die "无法复用 sing-box。" ;;
        geo)
          mkdir -p "$STAGE_DIR/panel/server/resources"
          cp -pR "$INSTALL_ROOT/panel/server/resources/geodata" "$STAGE_DIR/panel/server/resources/geodata" \
            || die "无法复用 Geo 数据。"
          ;;
        *) die "无法复用程序组件。" ;;
      esac
      continue
    fi
    info "下载 $_kind 更新:$_name"
    download_with_progress "$(build_url "$_component_base/$_name")" "$TMP_DL/$_name" "$_size" \
      || die "下载组件 $_kind 失败。现有安装未改动。"
    check_cancel_and_abort
    # Names and hashes are validated by the local helper; never execute manifest text as shell.
    printf '%s  %s\n' "$_hash" "$_name" > "$TMP_DL/$_name.sha256"
    if command -v sha256sum >/dev/null 2>&1; then
      (cd "$TMP_DL" && sha256sum -c "$_name.sha256" >/dev/null) || die "$_kind SHA256 校验失败。"
    else
      (cd "$TMP_DL" && shasum -a 256 -c "$_name.sha256" >/dev/null) || die "$_kind SHA256 校验失败。"
    fi
    write_status extracting "" "" "正在解包 $_kind"
    # extract_tgz 是 update.sh 里的(系统 tar 失败换 busybox tar 重试,GitHub #140);跑的若是还没有它的老 update.sh 就直接 tar
    if command -v extract_tgz >/dev/null 2>&1; then
      extract_tgz "$TMP_DL/$_name" "$STAGE_DIR" || die "组件 $_kind 解包失败。"
    else
      tar -xzf "$TMP_DL/$_name" -C "$STAGE_DIR" || die "组件 $_kind 解包失败。"
    fi
    rm -f "$TMP_DL/$_name"
    case "$_kind" in
      runtime) UPDATE_COMPONENTS="$UPDATE_COMPONENTS node" ;;
      kernel) UPDATE_COMPONENTS="$UPDATE_COMPONENTS bin" ;;
    esac
  done < "$TMP_DL/components.plan"
  LD_PRELOAD="$_component_preload" LD_LIBRARY_PATH="$INSTALL_ROOT/node/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
    "$_component_node" "$_component_helper" verify "$TMP_DL/components.json" "$STAGE_DIR" \
    || die "组合后的安装包校验失败，现有安装未改动。"
  return 0
}
