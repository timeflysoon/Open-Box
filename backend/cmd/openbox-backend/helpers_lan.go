package main

import "github.com/timeflysoon/Open-Box/backend/internal/system"

// firstLANIP 返回本机第一个局域网地址(容器自检里显示访问入口用)。
// 拿不到就返回空串,由前端显示占位符。
func firstLANIP() string {
	addrs, _ := system.LAN()
	if len(addrs) == 0 {
		return ""
	}
	return addrs[0]
}
