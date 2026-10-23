package routing

// 给 config 包(configDetailed 装配)用的导出层:只是把包内已对齐基线的函数露出去,不含新逻辑。

// Builtin 是内置直连 / 拒绝的当前名字与启用开关(JS 里 builtinTags 的返回值)。
type Builtin = builtinTags

// NewBuiltin 按名字和开关造一个 Builtin。
func NewBuiltin(direct, block string, directEnabled, blockEnabled bool) Builtin {
	return builtinTags{direct, block, directEnabled, blockEnabled}
}

func (b Builtin) Direct() string { return b.direct }
func (b Builtin) Block() string  { return b.block }

// NormalizeRouting 对应 routing-model.mjs 的 normalizeRouting。
func NormalizeRouting(routing any) Routing { return normalizeRouting(routing) }

// PolicyClasses 对应 policyClasses:站点集(含兜底)此刻的出口类别。
func PolicyClasses(routing any, members []string, b Builtin, selections map[string]any) map[string]string {
	return policyClasses(routing, members, b, selections)
}

// PolicyOutboundOptions 对应 policyOutboundOptions:站点集 selector 的成员表。
func PolicyOutboundOptions(groupTags []string, b Builtin) []string {
	return policyOutboundOptions(groupTags, b)
}

// EffectiveOutbound 对应 effectiveOutbound。
func EffectiveOutbound(def string, members []string, b Builtin) string {
	return effectiveOutbound(def, members, b)
}

// CustomPolicyActive / CustomOutboundTag 对应 routing-model.mjs 的同名函数。
func CustomPolicyActive(c CustomPolicy) bool           { return customPolicyActive(c) }
func CustomOutboundTag(r CustomRule, b Builtin) string { return customOutboundTag(r, b) }

// NativeBypassPlan 对应 nativeBypassPlan(bypassPlan 的内部形态),给装配用。
func NativeBypassPlan(routing any, opts any) BypassPlan { return bypassPlan(routing, opts) }

// ParseRuleLists:部署时的规则集形状表(ruleLists)→ 内部形态。
func ParseRuleLists(v any) ruleLists { return parseRuleLists(v) }
