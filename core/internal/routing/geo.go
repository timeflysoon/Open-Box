package routing

import (
	"encoding/json"
	"regexp"
	"unicode/utf16"

	"github.com/timeflysoon/Open-Box/core/internal/protocol"
)

// 随包规则库里有哪些 geosite / geoip 规则集(对应 JS 的 setAvailableGeoTags / geoRulesetAvailable)。
// 上游(MetaCubeX)会删掉 / 改名分类,档案里还引用着已经没有的,部署就卡在「安装包缺少规则集」。
// 规整站点集、前置自定义分流时把包里没有的去掉:只是不进配置,档案原样不动,去掉了哪些记在 missingRulesets。
// Node 没带 geoTags 就不筛(测试、预览),和以前一样。
//
// 核心是一次调用一个进程,所以和 JS 一样用一个包级变量;每个方法入口按这次请求的 geoTags 重新设一遍。
var availableGeoTags map[string]bool

var geoPrefixRe = regexp.MustCompile(`^(geoip|geosite)-`)

func setAvailableGeoTags(tags *[]string) {
	if tags == nil {
		availableGeoTags = nil
		return
	}
	availableGeoTags = make(map[string]bool, len(*tags))
	for _, t := range *tags {
		availableGeoTags[t] = true
	}
}

func geoRulesetAvailable(tag string) bool {
	return availableGeoTags == nil || !geoPrefixRe.MatchString(tag) || availableGeoTags[tag]
}

// withGeo 在每个方法入口按这次请求带来的 geoTags 设好筛选名单。
func withGeo(h protocol.Handler) protocol.Handler {
	return func(c *protocol.Context, args []json.RawMessage) (any, error) {
		if c != nil && c.HasGeoTags {
			tags := c.GeoTags
			setAvailableGeoTags(&tags)
		} else {
			setAvailableGeoTags(nil)
		}
		return h(c, args)
	}
}

// ---- 备注 ----

const noteMax = 60

// sliceUTF16 相当于 JS 的 s.slice(0, n)(按 UTF-16 码元数)。切在代理对中间时,JS 会留下孤立代理,
// 序列化出去是 \\udxxx;Go 的字符串装不下,按替换符算。
func sliceUTF16(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[:n]))
}

// normalizeNotes:每条规则的备注 { '类型:值': '一句话' }。键和值都要是非空字符串,值 trim 后最多 60 个码元。
// JS 里 out['__proto__'] = 字符串 不会生成键,这里一样跳过。
func normalizeNotes(raw any) map[string]string {
	out := map[string]string{}
	m, ok := asObject(raw)
	if !ok {
		return out
	}
	for k, v := range m {
		key, ok1 := nonEmpty(k)
		val, ok2 := nonEmpty(v)
		if !ok1 || !ok2 || key == "__proto__" {
			continue
		}
		out[key] = sliceUTF16(val, noteMax)
	}
	return out
}

func nilIfEmpty(list []string) []string {
	if len(list) == 0 {
		return nil
	}
	return list
}
