#!/usr/bin/env python3
"""Logically export masked rows, import into new files, and back up that clean DB.

SqlPackage and a loopback-only proxy to the owned seed builder are required.
The original restored data/log files are never used as the distributable seed.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
from trim_seed import Builder, quote


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--builder', required=True, type=Path)
    parser.add_argument('--sqlpackage', required=True, type=Path)
    args = parser.parse_args()
    b = Builder(args.builder)
    manifest = json.loads((b.root / 'fixture.json').read_text())
    if manifest['version'] != 'ihrms-tomei-v1' or not manifest['status'].startswith('masked'):
        raise ValueError('An anonymized fixture receipt is required before export')
    # Old SqlDependency subscriptions belong to the source process, not a fixture.
    ephemeral = b.sql("SELECT name FROM sys.services WHERE name LIKE 'SqlQueryNotificationService-%' FOR JSON PATH", True)
    for service in ephemeral: b.sql('DROP SERVICE ' + quote(service['name']))
    ephemeral = b.sql("SELECT SCHEMA_NAME(schema_id) [schema],name FROM sys.service_queues WHERE name LIKE 'SqlQueryNotificationService-%' FOR JSON PATH", True)
    for queue in ephemeral: b.sql('DROP QUEUE ' + quote(queue['schema']) + '.' + quote(queue['name']))
    port = subprocess.check_output(b.docker + ['port', b.record['container'] + '-export', '1433/tcp'], text=True).strip()
    if not port.startswith('127.0.0.1:'): raise ValueError('Export port is not local loopback')
    def package(action, database, file):
        connection = f"Server=127.0.0.1,{port.split(':')[-1]};Initial Catalog={database};User Id=sa;Password={b.record['password']};Encrypt=True;TrustServerCertificate=True"
        side = 'Source' if action == 'Export' else 'Target'
        file_side = 'Target' if action == 'Export' else 'Source'
        log = b.root / (action.lower() + '.log')
        fd = os.open(log, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as output:
            result = subprocess.run([str(args.sqlpackage.resolve()), '/Action:' + action,
                '/' + side + 'ConnectionString:' + connection, '/' + file_side + 'File:' + str(file),
                '/p:CommandTimeout=120'], stdout=output, stderr=subprocess.STDOUT)
        if result.returncode: raise RuntimeError(f'{action} failed. Private diagnostics: {log}')
        print(action + ' passed.', flush=True)
    if b.sql("SELECT DB_ID('octiq_fixture') id FOR JSON PATH", True)[0].get('id') is not None:
        raise ValueError('Clean fixture DB already exists; refusing to overwrite it')
    package('Export', 'octiq_seed', b.root / 'seed.bacpac')
    package('Import', 'octiq_fixture', b.root / 'seed.bacpac')
    b.sql("""USE octiq_fixture;
        ALTER DATABASE octiq_fixture SET RECOVERY SIMPLE;
        CHECKPOINT;
        BACKUP DATABASE octiq_fixture TO DISK='/seed/seed.bak' WITH INIT, COMPRESSION, CHECKSUM;
        RESTORE VERIFYONLY FROM DISK='/seed/seed.bak' WITH CHECKSUM;
    """)
    for name in ['seed.bak', 'seed.bacpac']: (b.root / name).chmod(0o600)
    print('Clean seed backup verified:', b.root / 'seed.bak', flush=True)


if __name__ == '__main__': main()
