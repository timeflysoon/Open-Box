#!/usr/bin/env python3
"""把 v0.1.318 基线生成的金标准,升级到官方 v0.1.353 openbox-core 的行为(gen-*.mjs 生成之后跑一次)。

用法: python3 core/testdata/tools/upgrade-golden.py [官方 openbox-core 路径]
  官方 openbox-core 取自上游 Release 的 open-box-v*-linux-x64-app.tar.gz(panel/server/native/openbox-core),
  也可以用环境变量 OPENBOX_UPSTREAM_CORE。不进仓库;没有它时只做不需要它的部分(config),并提示跳过。

做了什么(都是对官方包差分核对过的增量,可重复运行,已升级的文件会跳过):
  config_golden.json   platform:"container" 多一个 dns-in-lan 入站 + route.rules[0] 的 hijack-dns;
                       rulesetDir 拼 .srs 路径前先去掉所有末尾的 "/"(null 当空字符串)。
  routing_golden.json / groups_golden.json
                       (需要第二个参数:自研核心,或环境变量 OPENBOX_MINE_CORE)对官方 v0.1.354 的增量:重复内置 id 取最后一个、
                       数组不转数字(tolerance / recoveryHoldMs / failureThreshold)、custom.iconScale 按 Number 转并限 int64、
                       旧 regions 的 catchAll / fallback 非法值按 direct、ipCidr 类型、legacy id 用 trim 后的值、没写 regionId 时按缺失 id 选地区。
                       只改自研输出和旧期望不同、且与官方只差 BOM / __proto__ 两类已知差异的用例;对不上官方的直接报错。
                       之后(MARK3)发现官方在完整 release 目录里其实也响应 normalizeGroups / builtinTags / migrateStoredRouting /
                       routingFingerprint,这几个也改成直接对官方:分组多了 keywordMode(or / and)、iconScale 取整 floor(x+0.5)、
                       migrateStoredRouting 的非对象输入返回 {}。官方核心要放在未改动的 release 的 panel/server/native/ 下才肯跑
                       (它校验 index.mjs 哈希,fork 里换了仓库地址的 index.mjs 过不了)。
  plans_golden.json    entryPlan 的期望值改读官方包(directAnswer 不再因终端走代理而关掉);
                       另追加 bypassPlan + ignoreProxyClients:true 的用例(期望值读官方包)。
"""
import copy, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, ".."))
MARK = "+upstream-v0.1.353"
MARK2 = "+upstream-v0.1.354-normalize"
MARK3 = "+upstream-v0.1.354-direct"


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


def call(core, method, args, geo=None):
    req = {"protocol": 1, "method": method, "args": args}
    if geo is not None:
        req["geoTags"] = geo
    p = subprocess.run([core], input=json.dumps(req).encode(), capture_output=True)
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


def _canon(o):
    """去掉两类已知、有意保留的差异(BOM、__proto__ 键)后再比较。"""
    if isinstance(o, dict):
        return {k.replace("\ufeff", ""): _canon(v) for k, v in o.items() if k != "__proto__"}
    if isinstance(o, list):
        return [_canon(x) for x in o]
    if isinstance(o, str):
        return o.replace("\ufeff", "")
    return o


def upgrade_normalize(core, mine):
    verifiable = ("normalizeRouting", "normalizePolicy", "emitGroups")
    for name in ("routing_golden.json", "groups_golden.json"):
        g = load(name)
        if MARK2 in g["generatedBy"]:
            print(name, "已升级,跳过")
            continue
        changed = unverified = 0
        for c in g["cases"]:
            geo = c.get("geoTags")
            got = call(mine, c["fn"], c["args"], geo)
            if got != c["want"]:
                if c["fn"] in verifiable:
                    up = call(core, c["fn"], c["args"], geo)
                    if json.dumps(_canon(up), sort_keys=True, ensure_ascii=False) != json.dumps(_canon(got), sort_keys=True, ensure_ascii=False):
                        raise RuntimeError(f"{name} {c['fn']} 与官方不一致: {json.dumps(c['args'], ensure_ascii=False)[:200]}")
                else:
                    unverified += 1
                c["want"] = got
                changed += 1
            if "fp" in c:
                req = {"protocol": 1, "method": "routingFingerprint", "args": c["args"], "geoTags": c.get("geoTags")}
                p = subprocess.run([mine], input=json.dumps(req).encode(), capture_output=True)
                fp = json.loads(p.stdout)["value"]
                if fp != c["fp"]:
                    c["fp"] = fp
        g["generatedBy"] += MARK2
        save(name, g)
        print(f"{name} 已升级: 期望值改了 {changed} 条(其中官方无法直接对的 {unverified} 条)")


def upgrade_direct(core, mine):
    for name in ("routing_golden.json", "groups_golden.json"):
        g = load(name)
        if MARK3 in g["generatedBy"]:
            print(name, "已升级(direct),跳过")
            continue
        changed = 0
        for c in g["cases"]:
            geo = c.get("geoTags")
            got = call(mine, c["fn"], c["args"], geo)
            up = call(core, c["fn"], c["args"], geo)
            if json.dumps(_canon(up), sort_keys=True, ensure_ascii=False) != json.dumps(_canon(got), sort_keys=True, ensure_ascii=False):
                raise RuntimeError(f"{name} {c['fn']} 与官方不一致: {json.dumps(c['args'], ensure_ascii=False)[:200]}")
            if got != c["want"]:
                c["want"] = got
                changed += 1
        g["generatedBy"] += MARK3
        save(name, g)
        print(f"{name} 已升级(direct): 期望值改了 {changed} 条")


if __name__ == "__main__":
    core = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("OPENBOX_UPSTREAM_CORE", "")
    mine = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("OPENBOX_MINE_CORE", "")
    upgrade_config()
    if core and os.path.isfile(core):
        upgrade_plans(core)
        if mine and os.path.isfile(mine):
            upgrade_normalize(core, mine)
            upgrade_direct(core, mine)
        else:
            print("没有自研 openbox-core,跳过 routing / groups 金标准(传第二个参数或设 OPENBOX_MINE_CORE)")
    else:
        print("没有官方 openbox-core,跳过 plans_golden.json(传路径或设 OPENBOX_UPSTREAM_CORE)")
