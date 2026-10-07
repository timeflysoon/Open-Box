#!/usr/bin/env python3
"""Build separately downloadable update components from a verified full install tree."""
import hashlib
import json
from pathlib import Path
import sys
import tarfile


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def build(stage, output):
    stage, output = Path(stage), Path(output)
    meta = json.loads((stage / 'meta.json').read_text())
    geo_dir = 'panel/server/resources/geodata'
    geo = json.loads((stage / geo_dir / 'manifest.json').read_text())
    meta['geoVersion'] = geo['version']
    meta['geoDate'] = geo['date']
    (stage / 'meta.json').write_text(json.dumps(meta, indent=2) + '\n')
    manifest = {'schema': 1, 'version': meta['version'], 'arch': meta['arch'], 'components': {}}
    # License copies travel in the small app update too; missing documentation must
    # not force a download of an otherwise identical kernel/runtime.
    licenses = stage / 'panel/server/resources/licenses'
    licenses.mkdir(parents=True, exist_ok=True)
    for source, name in [('bin/sing-box.LICENSE', 'sing-box.LICENSE'), ('node/LICENSE', 'node.LICENSE')]:
        if (stage / source).is_file():
            (licenses / name).write_bytes((stage / source).read_bytes())
    layouts = {
        'app': (meta['version'], ['panel', 'openwrt', 'debian', 'meta.json', 'uninstall.sh', 'update.sh']),
        'runtime': (meta['nodeVersion'], ['node']),
        'kernel': (meta['singboxVersion'], ['bin']),
        'geo': (geo['version'], [geo_dir]),
    }
    for kind, (version, roots) in layouts.items():
        name = f"open-box-{meta['version']}-linux-{meta['arch']}-{kind}.tar.gz"
        target = output / name
        def selected(entry):
            if kind == 'app' and (entry.name == geo_dir or entry.name.startswith(geo_dir + '/')):
                return None
            entry.uid = entry.gid = 0
            entry.uname = entry.gname = 'root'
            entry.pax_headers = {}
            return entry
        with tarfile.open(target, 'w:gz', format=tarfile.PAX_FORMAT) as archive:
            for item in roots:
                archive.add(stage / item, arcname=item, filter=selected)
        component = {'version': version, 'asset': name, 'sha256': sha(target), 'size': target.stat().st_size}
        if kind in ('kernel', 'runtime'):
            component['files'] = {p.relative_to(stage).as_posix(): sha(p)
                                  for item in roots for p in sorted((stage / item).rglob('*'))
                                  if p.is_file() and ((kind == 'kernel' and p.name == 'sing-box')
                                                     or (kind == 'runtime' and p.name != 'LICENSE'))}
        elif kind == 'geo':
            component['manifestSha256'] = sha(stage / geo_dir / 'manifest.json')
        manifest['components'][kind] = component
        (output / (name + '.sha256')).write_text(f"{component['sha256']}  {name}\n")
    name = f"open-box-{meta['version']}-linux-{meta['arch']}-components.json"
    (output / name).write_text(json.dumps(manifest, indent=2) + '\n')
    (output / (name + '.sha256')).write_text(f'{sha(output / name)}  {name}\n')
    # Stable manifest allows the updater to discover a pinned version even without API access.
    stable = f"open-box-linux-{meta['arch']}-components.json"
    (output / stable).write_bytes((output / name).read_bytes())
    (output / (stable + '.sha256')).write_text(f'{sha(output / stable)}  {stable}\n')
    print(f"Components: {name}")


if __name__ == '__main__':
    build(*sys.argv[1:])
