#!/usr/bin/env python3
"""Install a local Performance recipe without putting its secrets in a checkout."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ['project', 'frontend', 'api', 'core', 'sso', 'seed', 'fixture']:
        p.add_argument('--' + name, type=Path, required=True)
    p.add_argument('--package-token-file', type=Path)
    args = p.parse_args()
    paths = {k: v.resolve(strict=True) for k, v in vars(args).items() if v is not None}
    root = paths['project'] / '.octiq'
    if (root / 'sandbox.json').exists(): raise SystemExit('A recipe already exists; keep or explicitly remove it first.')
    if json.loads(paths['fixture'].read_text()).get('status') != 'verified':
        raise SystemExit('The fixture must pass its authenticated checks before installation.')
    private = Path.home() / '.octiqflow/sandbox-recipes' / ('performance-' + secrets.token_hex(6))
    private.mkdir(parents=True, mode=0o700)
    # GitHub package restore reads a BuildKit secret, never a Docker build arg.
    package_token = paths['package_token_file'].read_text().strip() if args.package_token_file else os.environ.get('GITHUB_PERSONAL_ACCESS_TOKEN', '')
    if not package_token:
        token = subprocess.run(['gh', 'auth', 'token', '--hostname', 'github.com'], capture_output=True, text=True)
        if token.returncode: raise SystemExit('GitHub package authentication is unavailable; configure a token with package access.')
        package_token = token.stdout.strip()
    (private / 'nuget-token').write_text(package_token); (private / 'nuget-token').chmod(0o600)
    root.mkdir(exist_ok=True)
    ignore = root / '.gitignore'
    if not ignore.exists():
        ignore.write_text('# Host-local sandbox setup; regenerate with the OctiqFlow kit.\n*\n')
    kit = root / 'performance'
    kit.mkdir(exist_ok=False)
    for name in ['compose.yaml','dotnet.Dockerfile','frontend.Dockerfile','frontend-origin.sh','sso.Dockerfile','gateway.conf','verify.mjs']:
        shutil.copyfile(Path(__file__).parent / name, kit / name)
    values = {'KIT_DIR': str(kit), 'SEED_FILE': str(paths['seed']), 'FIXTURE_FILE': str(paths['fixture']),
              'NUGET_TOKEN_FILE': str(private / 'nuget-token')}
    for role in ['frontend','api','core','sso']:
        values[role.upper() + '_SOURCE'] = '${OCTIQ_PROJECT_DIR}' if paths[role] == paths['project'] else str(paths[role])
    envfile = private / 'sandbox.env'
    envfile.write_text('\n'.join(k + '=' + json.dumps(v) for k,v in values.items()) + '\n'); envfile.chmod(0o600)
    recipe = json.loads((Path(__file__).parent / 'sandbox.json').read_text())
    recipe['envFile'] = str(envfile)
    (root / 'sandbox.json').write_text(json.dumps(recipe, indent=2) + '\n')
    print('Installed recipe:', root / 'sandbox.json')
    print('Private configuration:', envfile)


if __name__ == '__main__': main()
