#!/usr/bin/env python3
# 阶段 D 的辅助工具:拿官方 sing-box 对 testdata/config_golden.json 里的配置逐条跑 `sing-box check`。
# 用法: python3 sbcheck.py <sing-box 可执行文件> [config_golden.json] [最多条数]
#   官方 1.13.14: https://github.com/SagerNet/sing-box/releases/download/v1.13.14/sing-box-1.13.14-linux-amd64.tar.gz
# 检查前做的处理(都不是装配错误):
#   1) 剥掉官方版不认的字段:sing-box 1.14 才有的 tun dns_mode / dns_address / include_mac_address / exclude_mac_address、
#      规则里的 source_mac_address,以及上游补丁字段 expected_status;
#   2) 语料里的假 uuid / 密钥 / 证书路径换成合法值(证书用 openssl 现生成),规则集文件用占位内容现编译。
# 只用于验证,不进发布。
import json,subprocess,os,re,collections,shutil,sys,tempfile
SB=sys.argv[1]
GOLD=sys.argv[2] if len(sys.argv)>2 else os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','config_golden.json')
LIMIT=int(sys.argv[3]) if len(sys.argv)>3 else 300
work=tempfile.mkdtemp(prefix='sbcheck-')
subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',work+'/k.pem','-out',work+'/c.pem','-days','30','-subj','/CN=x'],capture_output=True)
d=json.load(open(GOLD))
ok=[c for c in d['cases'] if not c['error']]
src=os.path.join(work,'ph.json'); json.dump({"version":3,"rules":[{"domain":["placeholder.invalid"]}]},open(src,'w'))
cache={}
def mk(tag,fmt):
    p=os.path.join(work,tag+('.srs' if fmt=='binary' else '.json'))
    if p in cache: return p
    if fmt=='binary':
        subprocess.run([SB,'rule-set','compile','--output',p,src],capture_output=True)
    else: shutil.copy(src,p)
    cache[p]=1; return p
errs=collections.Counter(); n=0; passed=0; examples={}
for i,c in enumerate(ok[:LIMIT]):
    cfg=c['want']['config']
    for k in ('dns_mode','dns_address','include_mac_address','exclude_mac_address'): cfg['inbounds'][0].pop(k,None)
    def strip(o):
        if isinstance(o,dict):
            o.pop('source_mac_address',None)
            for v in o.values(): strip(v)
        elif isinstance(o,list):
            for v in o: strip(v)
    strip(cfg['route']); strip(cfg['dns'])
    KEY='A'*43+'='
    UU='11111111-2222-3333-4444-555555555555'
    def fix(o):
        if isinstance(o,dict):
            o.pop('expected_status',None)
            if 'uuid' in o: o['uuid']=UU
            if 'public_key' in o: o['public_key']=('A'*43 if 'short_id' in o else KEY)
            if 'private_key' in o: o['private_key']=KEY
            if 'peer_public_key' in o: o['peer_public_key']=KEY
            if 'pre_shared_key' in o: o['pre_shared_key']=KEY
            if 'certificate_path' in o: o['certificate_path']=work+'/c.pem'
            if 'key_path' in o: o['key_path']=work+'/k.pem'
            if 'short_id' in o: o['short_id']='ab12'
            for v in o.values(): fix(v)
        elif isinstance(o,list):
            for v in o: fix(v)
    fix(cfg)
    for rs in cfg['route'].get('rule_set',[]):
        if rs['type']=='local': rs['path']=mk(re.sub(r'[^A-Za-z0-9_.-]','_',rs['tag']),rs['format'])
    cfg['experimental']['cache_file']['path']=os.path.join(work,'cache.db')
    p=os.path.join(work,'c.json'); json.dump(cfg,open(p,'w'),ensure_ascii=False)
    r=subprocess.run([SB,'check','-c',p],capture_output=True,text=True)
    n+=1
    if r.returncode==0: passed+=1
    else:
        msg=(r.stdout+r.stderr).strip().splitlines()[-1][:160]
        key=re.sub(r'\d+','N',re.sub(r'[\u4e00-\u9fff\w.-]+(?=[」\]])','X',msg))
        errs[key]+=1; examples.setdefault(key,(i,msg))
print('checked',n,'passed',passed)
for k,v in errs.most_common(12): print(v,examples[k][1])
