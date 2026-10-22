package routing

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/timeflysoon/Open-Box/core/internal/clientroutes"
)

func clientRoutesFromJSON(v any) []clientroutes.Route {
	var out []clientroutes.Route
	list, _ := v.([]any)
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
		out = append(out, r)
	}
	return out
}

func knownFromJSON(v any) map[string]bool {
	list, ok := v.([]any)
	if !ok {
		return nil
	}
	known := map[string]bool{}
	for _, s := range strSlice(list) {
		known[s] = true
	}
	return known
}

func tagFilter(m map[string]any, all, tags string) func(string) bool {
	if m[all] == true {
		return func(string) bool { return true }
	}
	if list, ok := m[tags].([]any); ok {
		set := map[string]bool{}
		for _, s := range strSlice(list) {
			set[s] = true
		}
		return func(tag string) bool { return set[tag] }
	}
	return nil
}

func hostsFromJSON(v any) *DirectHosts {
	if dh, ok := v.(map[string]any); ok {
		return &DirectHosts{Domains: strSlice(dh["domains"]), Cidrs: strSlice(dh["cidrs"])}
	}
	return nil
}

func routeOptionsFromJSON(v any) RouteOptions {
	m, _ := v.(map[string]any)
	o := RouteOptions{RuleLists: parseRuleLists(m["ruleLists"])}
	o.DNSMode, _ = m["dnsMode"].(string)
	o.DirectTag, _ = m["directTag"].(string)
	o.BlockTag, _ = m["blockTag"].(string)
	o.DnsmasqTag, _ = m["dnsmasqTag"].(string)
	o.DNSDirectInbound, _ = m["dnsDirectInbound"].(string)
	o.TunCidrs = strSlice(m["tunCidrs"])
	o.PreMatchBypass = m["preMatchBypass"] == true
	o.DirectHosts = hostsFromJSON(m["directHosts"])
	if hs, ok := m["directHostSets"].(map[string]any); ok {
		d, _ := hs["domain"].(string)
		ip, _ := hs["ip"].(string)
		o.DirectHostSets = &DirectHostSets{Domain: d, IP: ip}
	}
	o.RejectV6For = tagFilter(m, "rejectV6All", "rejectV6Tags")
	o.RejectQuicFor = tagFilter(m, "rejectQuicAll", "rejectQuicTags")
	o.ClientRoutes = clientRoutesFromJSON(m["clientRoutes"])
	o.KnownOutbounds = knownFromJSON(m["knownOutbounds"])
	return o
}

func preMatchOptionsFromJSON(v any) PreMatchOptions {
	m, _ := v.(map[string]any)
	o := PreMatchOptions{RuleLists: parseRuleLists(m["ruleLists"])}
	o.DirectTag, _ = m["directTag"].(string)
	o.BlockTag, _ = m["blockTag"].(string)
	o.DirectHostSet, _ = m["directHostSet"].(string)
	o.TunCidrs = strSlice(m["tunCidrs"])
	o.DirectHosts = hostsFromJSON(m["directHosts"])
	o.ClientRoutes = clientRoutesFromJSON(m["clientRoutes"])
	o.KnownOutbounds = knownFromJSON(m["knownOutbounds"])
	return o
}

func TestRouteGoldenAgainstUpstream(t *testing.T) {
	b, err := os.ReadFile("../../testdata/route_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Cases []struct {
			Fn   string          `json:"fn"`
			Args []any           `json:"args"`
			Want json.RawMessage `json:"want"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	bad, counts := 0, map[string]int{}
	for i, c := range g.Cases {
		var got any
		switch c.Fn {
		case "buildRoute":
			dir, _ := c.Args[1].(string)
			route, tags := BuildRoute(c.Args[0], dir, routeOptionsFromJSON(c.Args[2]))
			got = roundTrip(t, map[string]any{"route": route, "rulesetTags": tags})
		case "preMatchBypassRules":
			got = roundTrip(t, PreMatchBypassRules(normalizeRouting(c.Args[0]), preMatchOptionsFromJSON(c.Args[1])))
		default:
			t.Fatalf("#%d 未知用例类型 %q", i, c.Fn)
		}
		counts[c.Fn]++
		var want any
		json.Unmarshal(c.Want, &want)
		if !reflect.DeepEqual(got, want) {
			if bad++; bad <= 3 {
				gb, _ := json.Marshal(got)
				ab, _ := json.Marshal(c.Args)
				t.Errorf("#%d %s 输出不一致\n输入: %.1500s\n有: %.1800s\n要: %.1800s", i, c.Fn, ab, gb, c.Want)
			}
		}
	}
	if bad > 0 {
		t.Fatalf("共 %d 条不一致", bad)
	}
	t.Logf("通过 %d 条 %v", len(g.Cases), counts)
}
