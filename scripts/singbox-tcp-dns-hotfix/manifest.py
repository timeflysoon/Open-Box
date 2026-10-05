#!/usr/bin/env python3
"""Record and verify that a bundled kernel was built from this checkout's inputs."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
# 面板生成的配置依赖的最小功能集:任何内核(精简或完整)缺了其中一个都不能发布
SLIM_REQUIRED_TAGS = ('with_gvisor', 'with_quic', 'with_dhcp', 'with_wireguard', 'with_utls', 'with_clash_api')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inputs():
    return {p.name: sha(p) for p in sorted(HERE.iterdir())
            if p.is_file() and p.suffix in ('.sh', '.py', '.patch', '.go')}


def inspect(binary, arch):
    header = binary.read_bytes()[:20]
    assert header[:6] == b'\x7fELF\x02\x01', 'Expected a 64-bit little-endian ELF'
    assert int.from_bytes(header[18:20], 'little') == {'amd64': 62, 'arm64': 183}[arch], 'Wrong kernel architecture'
    subprocess.run([sys.executable, str(HERE.parent / 'dt-needed.py'), '--assert-static', str(binary)], check=True)


mode, bundle_arg, arch, version = sys.argv[1:5]
bundle = Path(bundle_arg)
binary = bundle / 'sing-box'
inspect(binary, arch)
if mode == 'create':
    source, go = sys.argv[5:7]
    build = subprocess.check_output([go, 'version', '-m', str(binary)], text=True)
    full = os.environ.get('OPENBOX_KERNEL_FULL', '0') == '1'
    tags_env = os.environ.get('OPENBOX_KERNEL_TAGS', '')
    tags = tags_env.split(',') if tags_env else (Path(source) / 'release/DEFAULT_BUILD_TAGS').read_text().strip().split(',') + ['with_musl']
    required = ['GOOS=linux', f'GOARCH={arch}'] + (['CGO_ENABLED=1'] if full else ['CGO_ENABLED=0']) + tags
    for item in required:
        assert item in build, f'Missing build feature: {item}'
    if full:
        assert 'with_naive_outbound' in tags and 'with_musl' in tags, 'Full build needs Naive and musl'
    manifest = {
        'version': version,
        'arch': arch,
        'binary_sha256': sha(binary),
        'upstream_source_sha256': os.environ['SINGBOX_SOURCE_SHA256'],
        'build_inputs': inputs(),
        'openbox_commit': subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip(),
        'go_version': subprocess.check_output([go, 'version'], text=True).strip(),
        'clang_archive_sha256': os.environ.get('OPENBOX_CLANG_SHA256') if full else None,
        'sysroot_archive_sha256': os.environ.get('OPENBOX_SYSROOT_SHA256') if full else None,
        'build_tags': tags,
        'kernel_profile': 'full' if full else 'slim',
        'cgo_enabled': full,
        'static_musl': full,
        'go_build_information': build,
    }
    (bundle / 'BUILD-INFO.json').write_text(json.dumps(manifest, indent=2) + '\n')
elif mode == 'verify':
    manifest = json.loads((bundle / 'BUILD-INFO.json').read_text())
    assert manifest['version'] == version and manifest['arch'] == arch, 'Kernel version/architecture mismatch'
    assert manifest['binary_sha256'] == sha(binary), 'Kernel binary checksum mismatch'
    assert manifest['build_inputs'] == inputs(), 'Kernel build inputs differ from this checkout; rebuild the kernel'
    assert manifest['upstream_source_sha256'] == os.environ['SINGBOX_SOURCE_SHA256'], 'Upstream source mismatch'
    if manifest['cgo_enabled']:
        assert manifest['static_musl'], 'Incomplete kernel build'
        assert 'with_naive_outbound' in manifest['build_tags'], 'Naive support is required in the full build'
    else:
        assert not manifest['static_musl'], 'Inconsistent kernel build record'
        for tag in SLIM_REQUIRED_TAGS:
            assert tag in manifest['build_tags'], f'Slim kernel is missing required tag {tag}'
    assert (bundle / 'LICENSE').is_file(), 'Missing kernel license'
    print(f'Verified locally built kernel: {version} {arch} {manifest["binary_sha256"]}')
else:
    raise SystemExit(f'Unknown mode: {mode}')
