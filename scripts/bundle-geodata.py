#!/usr/bin/env python3
"""Freeze all MetaCubeX Geo SRS files at one commit; never fetch on the router."""
import argparse
import base64
import io
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tarfile
import tempfile
import urllib.request

REPO = 'MetaCubeX/meta-rules-dat'
API = f'https://api.github.com/repos/{REPO}'
SAFE = re.compile(r'^(geoip|geosite)-[A-Za-z0-9._!@-]+\.srs$')


def request(url):
    headers = {'User-Agent': 'Open-Box-geodata-builder'}
    if url.startswith('https://api.github.com/') and os.environ.get('GITHUB_TOKEN'):
        headers['Authorization'] = 'Bearer ' + os.environ['GITHUB_TOKEN']
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=90)


def get_json(url):
    with request(url) as response:
        return json.load(response)


def verify(directory):
    directory = Path(directory)
    manifest = json.loads((directory / 'manifest.json').read_text())
    assert manifest['schema'] == 1 and manifest['source'] == REPO
    assert (directory / 'LICENSE').is_file() and (directory / 'sources.tar.gz').is_file()
    assert re.fullmatch('[a-f0-9]{40}', manifest['version'])
    files = manifest['files']
    assert files and all(SAFE.fullmatch(name) and '..' not in name for name in files)
    assert set(files) == {p.name for p in directory.glob('*.srs')}, 'incomplete Geo snapshot'
    for name, sha in files.items():
        path = directory / name
        assert not path.is_symlink(), f'symlink: {name}'
        data = path.read_bytes()
        assert data[:3] == b'SRS' and len(data) > 4, f'invalid SRS: {name}'
        assert hashlib.sha256(data).hexdigest() == sha, f'hash mismatch: {name}'
    for kind in ('geoip', 'geosite'):
        assert manifest['counts'][kind] == sum(n.startswith(kind + '-') for n in files) > 0
    return manifest


def build(destination, ref='sing'):
    commit = get_json(f'{API}/commits/{ref}')
    version = commit['sha']
    root = get_json(f'{API}/git/trees/{version}')
    geo = next(entry for entry in root['tree'] if entry['path'] == 'geo')
    # The repository-wide recursive tree is truncated (many ASN files). Query Geo alone.
    tree = get_json(f"{API}/git/trees/{geo['sha']}?recursive=1")
    assert not tree.get('truncated'), 'truncated Geo tree'
    blobs = {entry['path']: entry for entry in tree['tree']
             if entry['type'] == 'blob' and re.fullmatch(r'(geoip|geosite)/[^/]+\.(srs|json)', entry['path'])}
    assert all(any(n.startswith(k + '/') for n in blobs) for k in ('geoip', 'geosite'))
    destination = Path(destination).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.geodata-', dir=destination.parent) as temp:
        stage = Path(temp)
        files = {}
        source_count = 0
        license_data = base64.b64decode(get_json(f'{API}/license')['content'])
        (stage / 'LICENSE').write_bytes(license_data)
        sources = tarfile.open(stage / 'sources.tar.gz', 'w:gz')
        license_entry = tarfile.TarInfo('LICENSE')
        license_entry.size = len(license_data)
        sources.addfile(license_entry, io.BytesIO(license_data))
        # Stream the archive; only selected regular files are written, never extract upstream paths.
        with request(f'https://codeload.github.com/{REPO}/tar.gz/{version}') as response:
            with tarfile.open(fileobj=response, mode='r|gz') as archive:
                prefix = f'meta-rules-dat-{version}/geo/'
                for entry in archive:
                    if not entry.name.startswith(prefix):
                        continue
                    relative = entry.name[len(prefix):]
                    if relative not in blobs:
                        continue
                    expected = blobs[relative]
                    assert entry.isfile() and entry.size == expected['size'] < 16 * 1024 * 1024
                    data = archive.extractfile(entry).read()
                    git_hash = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
                    assert git_hash == expected['sha'], f'upstream hash mismatch: {relative}'
                    if relative.endswith('.json'):
                        src = tarfile.TarInfo(relative)
                        src.size = len(data)
                        sources.addfile(src, io.BytesIO(data))
                        source_count += 1
                        continue
                    name = relative.replace('/', '-')
                    assert SAFE.fullmatch(name) and '..' not in name and name not in files
                    (stage / name).write_bytes(data)
                    files[name] = hashlib.sha256(data).hexdigest()
        sources.close()
        assert len(files) == source_count and len(files) + source_count == len(blobs), 'archive missing Geo files'
        manifest = {
            'schema': 1, 'source': REPO, 'version': version,
            'date': commit['commit']['committer']['date'],
            'counts': {k: sum(n.startswith(k + '-') for n in files) for k in ('geoip', 'geosite')},
            'files': dict(sorted(files.items())),
        }
        (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        (stage / 'SOURCE.txt').write_text(f'https://github.com/{REPO}/tree/{version}/geo\n'
                                         'Compiled rule sets distributed unchanged from MetaCubeX.\n'
                                         'Corresponding JSON sources are included in sources.tar.gz; see LICENSE.\n')
        verify(stage)
        if destination.exists():
            shutil.rmtree(destination)
        stage.rename(destination)
    print(json.dumps({k: manifest[k] for k in ('source', 'version', 'date', 'counts')}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory')
    parser.add_argument('--ref', default='sing')
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    if args.verify:
        result = verify(args.directory)
        print(f"Verified {len(result['files'])} Geo rule sets: {result['version']}")
    else:
        build(args.directory, args.ref)
