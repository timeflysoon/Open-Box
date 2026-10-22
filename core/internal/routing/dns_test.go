package routing

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/timeflysoon/Open-Box/core/internal/clientroutes"
	"github.com/timeflysoon/Open-Box/core/internal/jsx"
)

type dnsGolden struct {
	Cases []struct {
		Fn    string          `json:"fn"`
		Args  []any           `json:"args"`
		Want  json.RawMessage `json:"want"`
		Error string          `json:"error"`
	} `json:"cases"`
}

func strSlice(v any) []string {
	out := []string{}
	if a, ok := v.([]any); ok {
		for _, e := range a {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}

// dnsOptionsFromJSON 把金标准里的 options(JSON)翻成 DNSOptions,语义对应旧 JS 读 options 的方式。
func dnsOptionsFromJSON(v any) DNSOptions {
	m, _ := v.(map[string]any)
	o := DNSOptions{Builtin: parseBuiltin(m["builtin"]), Selections: parseSelections(m["selections"]), RuleLists: parseRuleLists(m["ruleLists"])}
	if _, has := m["builtin"]; !has {
		o.Builtin = defaultBuiltin
	}
	o.SystemDNS, _ = m["systemDns"].([]any)
	o.GroupTags = strSlice(m["groupTags"])
	if dh, ok := m["directHosts"].(map[string]any); ok {
		o.DirectDomains = strSlice(dh["domains"])
	}
	if hs, ok := m["directHostSets"].(map[string]any); ok {
		d, _ := hs["domain"].(string)
		o.DirectHostSets = &DirectHostSets{Domain: d}
	}
	if list, ok := m["clientRoutes"].([]any); ok {
		for _, e := range list {
			em, ok := e.(map[string]any)
			if !ok {
				continue
			}
			r := clientroutes.Route{Sources: strSlice(em["sources"]), Macs: strSlice(em["macs"])}
			r.ID, _ = em["id"].(string)
			r.Name, _ = em["name"].(string)
			r.Match, _ = em["match"].(string)
			r.Outbound, _ = em["outbound"].(string)
			r.Bypass, _ = em["bypass"].(bool)
			if len(r.Macs) == 0 {
				r.Macs = nil
			}
			o.ClientRoutes = append(o.ClientRoutes, r)
		}
	}
	if list, ok := m["knownOutbounds"].([]any); ok {
		o.KnownOutbounds = map[string]bool{}
		for _, s := range strSlice(list) {
			o.KnownOutbounds[s] = true
		}
	}
	o.FilterRules, _ = m["filterRules"].([]any)
	if td, ok := m["terminalDns"].(map[string]any); ok {
		o.Terminal.AutoRedirect = td["autoRedirect"] == true
		o.Terminal.DirectBypassOff = td["directBypass"] == false // 只有明确写 false 才算关(JS: directBypass !== false)
		if s, ok := td["admitDirect"].(string); ok {
			o.Terminal.AdmitDirect = s
		}
	}
	return o
}

func roundTrip(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestDNSGoldenAgainstUpstream(t *testing.T) {
	b, err := os.ReadFile("../../testdata/dns_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g dnsGolden
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	bad, n := 0, map[string]int{}
	report := func(i int, fn string, args any, got, want any) {
		if bad++; bad <= 4 {
			gb, _ := json.Marshal(got)
			wb, _ := json.Marshal(want)
			ab, _ := json.Marshal(args)
			t.Errorf("#%d %s 输出不一致\n输入: %.1500s\n有: %.1500s\n要: %.1500s", i, fn, ab, gb, wb)
		}
	}
	for i, c := range g.Cases {
		n[c.Fn]++
		switch c.Fn {
		case "buildDns":
			result, err := BuildDNS(c.Args[0], dnsOptionsFromJSON(c.Args[1]))
			if c.Error != "" {
				if err == nil {
					report(i, c.Fn, c.Args, "无错误", "抛错 "+c.Error)
				}
				continue
			}
			if err != nil {
				report(i, c.Fn, c.Args, err.Error(), json.RawMessage(c.Want))
				continue
			}
			var want any
			json.Unmarshal(c.Want, &want)
			got := roundTrip(t, result)
			if !reflect.DeepEqual(got, want) {
				report(i, c.Fn, c.Args, got, want)
			}
		case "normalizeDnsUpstream", "isValidDnsUpstream":
			var want any
			json.Unmarshal(c.Want, &want)
			var in any = jsx.Undefined
			if len(c.Args) > 0 {
				in = c.Args[0]
			}
			var got any
			if c.Fn == "normalizeDnsUpstream" {
				got = normalizeDNSUpstream(in)
			} else {
				got = isValidDNSUpstream(in)
			}
			if !reflect.DeepEqual(got, want) {
				report(i, c.Fn, c.Args, got, want)
			}
		case "flip":
			var want any
			json.Unmarshal(c.Want, &want)
			conf := normalizeRouting(c.Args[0])
			classes := map[string]string{}
			if cm, ok := c.Args[1].(map[string]any); ok {
				for k, v := range cm {
					classes[k], _ = v.(string)
				}
			}
			pairs := []any{}
			FlipFlagMap(conf).Each(func(name, tag string) { pairs = append(pairs, []any{name, tag}) })
			tags := []any{}
			for _, p := range conf.ActivePolicies {
				tags = append(tags, FlipFlagTag(p))
			}
			states := map[string]any{}
			for k, v := range FlipFlagStates(conf, classes) {
				states[k] = v
			}
			got := roundTrip(t, map[string]any{
				"flagMap": pairs, "flagStates": states, "bypassCandidates": FlipBypassCandidates(conf), "flagTags": tags,
			})
			if !reflect.DeepEqual(got, want) {
				report(i, c.Fn, c.Args, got, want)
			}
		case "flipFlagTag":
			var want any
			json.Unmarshal(c.Want, &want)
			pm, _ := c.Args[0].(map[string]any)
			pol := Policy{}
			pol.ID, _ = pm["id"].(string)
			pol.Name, _ = pm["name"].(string)
			if got := FlipFlagTag(pol); !reflect.DeepEqual(any(got), want) {
				report(i, c.Fn, c.Args, got, want)
			}
		case "clientSourceMatch", "terminalDnsRedirected":
			var want any
			json.Unmarshal(c.Want, &want)
			cm, _ := c.Args[0].(map[string]any)
			cr := clientroutes.Route{Sources: strSlice(cm["sources"]), Macs: strSlice(cm["macs"])}
			cr.Match, _ = cm["match"].(string)
			cr.Outbound, _ = cm["outbound"].(string)
			cr.Bypass, _ = cm["bypass"].(bool)
			var got any
			if c.Fn == "clientSourceMatch" {
				if m := clientroutes.SourceMatch(cr); m != nil {
					got = roundTrip(t, m)
				}
			} else {
				om, _ := c.Args[1].(map[string]any)
				o := clientroutes.TerminalDNSOptions{DirectBypass: om["directBypass"] != false}
				o.DNSMode, _ = om["dnsMode"].(string)
				o.AutoRedirect, _ = om["autoRedirect"].(bool)
				o.SplitDNS, _ = om["splitDns"].(bool)
				o.DirectTag, _ = om["directTag"].(string)
				o.BlockTag, _ = om["blockTag"].(string)
				got = clientroutes.TerminalDNSRedirected(cr, o)
			}
			if !reflect.DeepEqual(got, want) {
				report(i, c.Fn, c.Args, got, want)
			}
		case "flipConsts":
			var want any
			json.Unmarshal(c.Want, &want)
			got := roundTrip(t, map[string]any{
				"fallback": FlipFallbackTag, "bypassTag": FlipBypassTag("geoip-cn"), "needTag": FlipNeedTag("geoip-cn"), "needFixed": FlipNeedFixed,
				"on": FlipFlagOn, "off": FlipFlagOff, "content": []string{FlipFlagContent(true), FlipFlagContent(false)},
				"placeholderSource": FlipPlaceholderSource(), "placeholderSrs": FlipPlaceholderSRSBase64, "placeholder": FlipBypassPlaceholder,
				"fakeIpCachePath": FakeIPCachePath("/var/lib/openbox/cache.db"), "v4": FakeIPV4, "v6": FakeIPV6,
			})
			if !reflect.DeepEqual(got, want) {
				report(i, c.Fn, c.Args, got, want)
			}
		case "extractHost":
			var want any
			json.Unmarshal(c.Want, &want)
			if got := extractHost(c.Args[0]); !reflect.DeepEqual(got, want) {
				report(i, c.Fn, c.Args, got, want)
			}
		}
	}
	if bad > 0 {
		t.Fatalf("共 %d 条不一致", bad)
	}
	t.Logf("通过:%v", n)
}
