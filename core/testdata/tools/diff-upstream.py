#!/usr/bin/env python3
"""拿金标准里的输入同时喂官方 openbox-core 和自研核心,数不一致的条数(官方包只放本地,不进仓库)。

用法: python3 core/testdata/tools/diff-upstream.py <官方 openbox-core> <自研 openbox-core> [显示几条差异,默认 3]
  自研核心先编译: (cd core && go build -o /tmp/mine ./cmd/openbox-core)
  没有官方包(路径不存在)时直接跳过,退出码 0。
也可以用环境变量 OPENBOX_UPSTREAM_CORE 代替第一个参数。

比较的方法: entryPlan / bypassPlan(再加 ignoreProxyClients:true 的变体)/ configDetailed(再把 platform 换成 container)。
已知、有意保留的差异(configDetailed 约 100 条,全在脏数据语料里):
  - 非 ASCII 主机(directHosts.domains / dns、route 规则里的 domain):上游丢弃,自研转 punycode 保留。
  - BOM、__proto__ 键、旧版 regions 数据的 fallback.default:见 core/README.md。
"""
import collections, copy, json, os, subprocess, sys

DATA = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def cases(name):
    with open(os.path.join(DATA, name), encoding="utf-8") as f:
        return json.load(f)["cases"]


def run(core, method, args):
    p = subprocess.run([core], input=json.dumps({"protocol": 1, "method": method, "args": args}).encode(), capture_output=True)
    r = json.loads(p.stdout)
    return json.dumps(r["value"] if r.get("ok") else {"ERR": r.get("error")}, sort_keys=True, ensure_ascii=False)


def main():
    argv = sys.argv[1:]
    up = argv[0] if argv else os.environ.get("OPENBOX_UPSTREAM_CORE", "")
    mine = argv[1] if len(argv) > 1 else ""
    show = int(argv[2]) if len(argv) > 2 else 3
    if not up or not os.path.isfile(up):
        print("没有官方 openbox-core,跳过差分")
        return
    if not mine or not os.path.isfile(mine):
        sys.exit("用法: diff-upstream.py <官方 openbox-core> <自研 openbox-core>")
    stat, shown = collections.Counter(), collections.Counter()

    def check(label, method, args):
        stat[(label, "total")] += 1
        u, m = run(up, method, args), run(mine, method, args)
        if u != m:
            stat[(label, "不一致")] += 1
            shown[label] += 1
            if shown[label] <= show:
                print(f"[{label}] 输入 {json.dumps(args, ensure_ascii=False)[:300]}\n  官方 {u[:300]}\n  自研 {m[:300]}")

    for c in cases("plans_golden.json"):
        if c["fn"] not in ("entryPlan", "bypassPlan"):
            continue
        check(c["fn"], c["fn"], c["args"])
        if c["fn"] == "bypassPlan" and len(c["args"]) > 1 and isinstance(c["args"][1], dict):
            a = copy.deepcopy(c["args"])
            a[1]["ignoreProxyClients"] = True
            check("bypassPlan+ignoreProxyClients", "bypassPlan", a)
    for c in cases("config_golden.json"):
        check("configDetailed", "configDetailed", [c["args"]])
        a = copy.deepcopy(c["args"])
        a["platform"] = "container"
        check("configDetailed+container", "configDetailed", [a])
    for (label, k), v in sorted(stat.items()):
        print(f"{label:34s}{k:6s}{v}")


if __name__ == "__main__":
    main()
