package routing

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"unicode/utf8"
)

// 分流设置的指纹:sha256(JSON.stringify(normalizeRouting(...))) 的前 16 位十六进制。
// 部署时记进 config.meta.json,规则页拿它和当前档案比,不一样就说明分流改过但内核还在跑旧配置。
// 这里不用 encoding/json,因为要字节级复刻 JS 的 JSON.stringify(Go 会把 U+2028/2029 转义,JS 不会)。

func quote(buf *bytes.Buffer, s string) {
	buf.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"':
			buf.WriteString(`\"`)
		case r == '\\':
			buf.WriteString(`\\`)
		case r == '\b':
			buf.WriteString(`\b`)
		case r == '\f':
			buf.WriteString(`\f`)
		case r == '\n':
			buf.WriteString(`\n`)
		case r == '\r':
			buf.WriteString(`\r`)
		case r == '\t':
			buf.WriteString(`\t`)
		case r < 0x20:
			buf.WriteString(`\u00`)
			buf.WriteByte("0123456789abcdef"[r>>4])
			buf.WriteByte("0123456789abcdef"[r&0xf])
		case r == utf8.RuneError:
			// 非法 UTF-8 在 JS 里是孤立代理,会被写成 \udxxx;Go 这边拿不到原值,按替换符输出
			buf.WriteString("\ufffd")
		default:
			buf.WriteRune(r)
		}
	}
	buf.WriteByte('"')
}

func writeStrs(buf *bytes.Buffer, list []string) {
	buf.WriteByte('[')
	for i, s := range list {
		if i > 0 {
			buf.WriteByte(',')
		}
		quote(buf, s)
	}
	buf.WriteByte(']')
}

func writeBool(buf *bytes.Buffer, b bool) {
	if b {
		buf.WriteString("true")
	} else {
		buf.WriteString("false")
	}
}

func writeField(buf *bytes.Buffer, name string, first bool) {
	if !first {
		buf.WriteByte(',')
	}
	quote(buf, name)
	buf.WriteByte(':')
}

func writePolicy(buf *bytes.Buffer, p Policy) {
	buf.WriteByte('{')
	writeField(buf, "id", true)
	quote(buf, p.ID)
	writeField(buf, "name", false)
	quote(buf, p.Name)
	writeField(buf, "icon", false)
	quote(buf, p.Icon)
	writeField(buf, "enabled", false)
	writeBool(buf, p.Enabled)
	writeField(buf, "ruleUrls", false)
	writeStrs(buf, p.RuleUrls)
	writeField(buf, "rulesets", false)
	writeStrs(buf, p.Rulesets)
	writeField(buf, "domain", false)
	writeStrs(buf, p.Domain)
	writeField(buf, "domainSuffix", false)
	writeStrs(buf, p.DomainSuffix)
	writeField(buf, "domainKeyword", false)
	writeStrs(buf, p.DomainKeyword)
	writeField(buf, "ipCidr", false)
	writeStrs(buf, p.IPCidr)
	if len(p.MissingRulesets) > 0 {
		writeField(buf, "missingRulesets", false)
		writeStrs(buf, p.MissingRulesets)
	}
	buf.WriteByte('}')
}

func writePolicies(buf *bytes.Buffer, list []Policy) {
	buf.WriteByte('[')
	for i, p := range list {
		if i > 0 {
			buf.WriteByte(',')
		}
		writePolicy(buf, p)
	}
	buf.WriteByte(']')
}

// stringify 复刻 JSON.stringify(normalizeRouting(...), 替换函数) 的输出。替换函数把键叫 default / fallbackDefault /
// notes / note 的整个丢掉:「默认出口」是代理页每切一次线路就写回档案的选择,备注只给界面看,都不算分流改过。
func (r Routing) stringify() []byte {
	var buf bytes.Buffer
	buf.WriteByte('{')
	writeField(&buf, "custom", true)
	buf.WriteByte('{')
	writeField(&buf, "name", true)
	quote(&buf, r.Custom.Name)
	writeField(&buf, "icon", false)
	quote(&buf, r.Custom.Icon)
	writeField(&buf, "iconScale", false)
	buf.WriteString(strconv.FormatFloat(r.Custom.IconScale, 'f', -1, 64))
	writeField(&buf, "enabled", false)
	writeBool(&buf, r.Custom.Enabled)
	writeField(&buf, "rules", false)
	buf.WriteByte('[')
	for i, c := range r.Custom.Rules {
		if i > 0 {
			buf.WriteByte(',')
		}
		buf.WriteByte('{')
		writeField(&buf, "type", true)
		quote(&buf, c.Type)
		writeField(&buf, "value", false)
		quote(&buf, c.Value)
		writeField(&buf, "outbound", false)
		quote(&buf, c.Outbound)
		buf.WriteByte('}')
	}
	buf.WriteByte(']')
	if len(r.Custom.MissingRulesets) > 0 {
		writeField(&buf, "missingRulesets", false)
		writeStrs(&buf, r.Custom.MissingRulesets)
	}
	buf.WriteByte('}')
	writeField(&buf, "policies", false)
	writePolicies(&buf, r.Policies)
	writeField(&buf, "activePolicies", false)
	writePolicies(&buf, r.ActivePolicies)
	writeField(&buf, "fallback", false)
	buf.WriteByte('{')
	writeField(&buf, "name", true)
	quote(&buf, r.Fallback.Name)
	writeField(&buf, "icon", false)
	quote(&buf, r.Fallback.Icon)
	buf.WriteByte('}')
	if len(r.MissingRulesets) > 0 {
		writeField(&buf, "missingRulesets", false)
		buf.WriteByte('[')
		for i, m := range r.MissingRulesets {
			if i > 0 {
				buf.WriteByte(',')
			}
			buf.WriteByte('{')
			writeField(&buf, "tag", true)
			quote(&buf, m.Tag)
			writeField(&buf, "owner", false)
			quote(&buf, m.Owner)
			buf.WriteByte('}')
		}
		buf.WriteByte(']')
	}
	buf.WriteByte('}')
	return buf.Bytes()
}

func routingFingerprint(routing any) string {
	sum := sha256.Sum256(normalizeRouting(routing).stringify())
	return hex.EncodeToString(sum[:])[:16]
}
