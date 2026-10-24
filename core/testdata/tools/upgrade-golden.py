#!/usr/bin/env python3
"""把 v0.1.318 基线生成的金标准,升级到官方 v0.1.353 openbox-core 的行为(gen-*.mjs 生成之后跑一次)。

用法: python3 core/testdata/tools/upgrade-golden.py [官方 openbox-core 路径]
  官方 openbox-core 取自上游 Release 的 open-box-v*-linux-x64-app.tar.gz(panel/server/native/openbox-core),
  也可以用环境变量 OPENBOX_UPSTREAM_CORE。不进仓库;没有它时只做不需要它的部分(config),并提示跳过。

做了什么(都是对官方包差分核对过的增量,可重复运行,已升级的文件会跳过):
  config_golden.json   platform:"container" 多一个 dns-in-lan 入站 + route.rules[0] 的 hijack-dns;
                       rulesetDir 拼 .srs 路径前先去掉所有末尾的 "/"(null 当空字符串)。
  plans_golden.json    entryPlan 的期望值改读官方包(directAnswer 不再因终端走代理而关掉);
                       另追加 bypassPlan + ignoreProxyClients:true 的用例(期望值读官方包)。
"""
import copy, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, ".."))
MARK = "+upstream-v0.1.353"


def load(name):
    with open(os.path.join(DATA, name), encoding="utf-8") as f:
        return json.load(f)


def save(name, obj):
    with open(os.path.join(DATA, name), "w", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")


def upgrade_config():
    g = load("config_golden.json")
    if MARK in g["generatedBy"]:
        print("config_golden.json 已升级,跳过")
        return
    for c in g["cases"]:
        if c.get("error") or c.get("want") is None:
            continue
        cfg = c["want"]["config"]
        args = c["args"]
        # 1) rulesetDir:.srs 路径先去末尾 "/"
        if "rulesetDir" in args:
            rd = args["rulesetDir"]
            raw = "" if rd is None else str(rd)
            old_prefix = ("null" if rd is None else raw) + "/"
            new_prefix = raw.rstrip("/") + "/"
            for rs in cfg.get("route", {}).get("rule_set", []) or []:
                p = rs.get("path", "")
                if rs.get("format") == "binary" and p.startswith(old_prefix) and p.endswith(".srs"):
                    rs["path"] = new_prefix + p[len(old_prefix):]
        # 2) platform:container
        if args.get("platform") == "container":
            ins = cfg["inbounds"]
            at = next(i for i, x in enumerate(ins) if x.get("tag") == "dns-in")
            ins.insert(at + 1, {"type": "direct", "tag": "dns-in-lan", "listen": "0.0.0.0", "listen_port": 53})
            cfg["route"]["rules"].insert(0, {"action": "hijack-dns", "inbound": ["dns-in-lan"]})
    g["generatedBy"] += MARK
    save("config_golden.json", g)
    print("config_golden.json 已升级:", len(g["cases"]), "条")


def call(core, method, args):
    p = subprocess.run([core], input=json.dumps({"protocol": 1, "method": method, "args": args}).encode(), capture_output=True)
    r = json.loads(p.stdout)
    if not r.get("ok"):
        raise RuntimeError(f"{method}: {r.get('error')}")
    return r["value"]


def upgrade_plans(core):
    g = load("plans_golden.json")
    if MARK in g["generatedBy"]:
        print("plans_golden.json 已升级,跳过")
        return
    changed, extra = 0, []
    for c in g["cases"]:
        if c["fn"] == "entryPlan":
            w = call(core, "entryPlan", c["args"])
            if w != c["want"]:
                changed += 1
            c["want"] = w
        elif c["fn"] == "bypassPlan" and len(c["args"]) > 1 and isinstance(c["args"][1], dict):
            a = copy.deepcopy(c["args"])
            a[1]["ignoreProxyClients"] = True
            w = call(core, "bypassPlan", a)
            if w != c["want"]:  # 只收带这个选项后上游输出有变化的
                extra.append({"fn": "bypassPlan", "args": a, "want": w})
    g["cases"].extend(extra)
    g["generatedBy"] += MARK
    save("plans_golden.json", g)
    print(f"plans_golden.json 已升级: entryPlan 期望值改了 {changed} 条,追加 ignoreProxyClients 用例 {len(extra)} 条")


if __name__ == "__main__":
    core = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("OPENBOX_UPSTREAM_CORE", "")
    upgrade_config()
    if core and os.path.isfile(core):
        upgrade_plans(core)
    else:
        print("没有官方 openbox-core,跳过 plans_golden.json(传路径或设 OPENBOX_UPSTREAM_CORE)")
