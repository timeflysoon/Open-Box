# singbox/(预留)

目前 sing-box 内核直接取上游 Release 里的成品(见 `scripts/fetch-upstream-kernel.sh`),
本目录先空着。

将来如果要维护自己的 sing-box 补丁或构建脚本,放在这里:
`sync-main.sh` / `sync-upstream.yml` 只保留 `core/` 和 `panel/`,放在这两个目录以外的文件会被同步抹掉。
