#!/usr/bin/env python3
"""Have the release-compatible native sing-box validate every bundled SRS in one config."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile

directory = Path(sys.argv[1]).resolve()
binary = str(Path(sys.argv[2]).resolve())
if len(sys.argv) > 3:
    actual = subprocess.check_output([binary, 'version'], text=True).splitlines()[0]
    assert actual == f'sing-box version {sys.argv[3]}', f'Verifier version mismatch: {actual}'
manifest = json.loads((directory / 'manifest.json').read_text())
config = {
    'outbounds': [{'type': 'direct', 'tag': 'direct'}],
    'route': {'final': 'direct', 'rule_set': [
        {'type': 'local', 'tag': name[:-4], 'format': 'binary', 'path': str(directory / name)}
        for name in manifest['files']
    ]},
}
with tempfile.TemporaryDirectory(prefix='openbox-geo-check-') as temp:
    target = Path(temp) / 'check.json'
    target.write_text(json.dumps(config))
    subprocess.run([binary, 'check', '-c', str(target)], check=True, timeout=120)
print(f"sing-box accepted all {len(manifest['files'])} bundled Geo rule sets")
