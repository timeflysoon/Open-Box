package routing

import (
	"encoding/json"

	"github.com/timeflysoon/Open-Box/core/internal/protocol"
)

// entryPlan:系统入口(nft)的进内核策略。
//
// 契约来自 Node 端的调用处:选项和 bypassPlan 相同,返回 mode / reason / needSets / needCidrs /
// directAnswer / fakeIp,其中 needSets、needCidrs 是数组。
//   blacklist  全部进内核,直连的 IP 集合旁路出去(集合由 bypassPlan 给出)
//   whitelist  只有 needSets / needCidrs 里的目标进内核
//
// 第一版只实现 blacklist:needSets / needCidrs 恒为空。这和 Node 在纯 tun(没有 nft 重定向)时
// 自己返回的形状一致,功能上是安全的,最多少一点性能优化。whitelist 一旦判错,
// 该走代理的流量会绕过内核,风险比较大,所以不在没有对照的情况下实现。

type EntryPlan struct {
	Mode         string   `json:"mode"`
	Reason       string   `json:"reason"`
	NeedSets     []string `json:"needSets"`
	NeedCidrs    []string `json:"needCidrs"`
	DirectAnswer bool     `json:"directAnswer"`
	FakeIP       bool     `json:"fakeIp"`
}

func entryPlan(routing any, opts any) EntryPlan {
	bp := bypassPlan(routing, opts)
	plan := EntryPlan{Mode: "blacklist", NeedSets: []string{}, NeedCidrs: []string{}, FakeIP: bp.FakeIP}
	// 旁路没开时,把原因带上,界面上才看得出为什么全部进内核
	if !bp.Enabled {
		plan.Reason = bp.Reason
	}
	return plan
}

// entryPlan(routing, {members, builtin, selections, clientRoutes, fakeIp, dnsMode, enabled})
func hEntryPlan(_ *protocol.Context, args []json.RawMessage) (any, error) {
	routing, err := arg(args, 0)
	if err != nil {
		return nil, err
	}
	opts, err := arg(args, 1)
	if err != nil {
		return nil, err
	}
	return entryPlan(routing, opts), nil
}
