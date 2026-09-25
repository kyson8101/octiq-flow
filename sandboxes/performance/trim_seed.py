#!/usr/bin/env python3
"""Trim an offline, owned SQL Server copy. Never accepts a source connection.

The builder record is private JSON with container/password; its container must
carry octiq.seed=ihrms-tomei-v1, use network=none, and contain octiq_seed.
Run only after restoring a COPY_ONLY backup into that disposable local builder.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess


def quote(name):
    return '[' + name.replace(']', ']]') + ']'


def literal(value):
    value = str(value)
    # Keep sqlcmd input lines short even for JSON snapshots. Its stdin reader
    # may split very long lines in the middle of an identifier or string.
    chunks = [value[i:i + 800] for i in range(0, len(value), 800)] or ['']
    quoted = ["N'" + chunk.replace("'", "''") + "'" for chunk in chunks]
    if len(quoted) > 1: quoted[0] = 'CAST(' + quoted[0] + ' AS nvarchar(max))'
    return '(' + ' +\n'.join(quoted) + ')'


class Builder:
    def __init__(self, record):
        self.record = json.loads(record.read_text())
        self.root = record.parent
        endpoint = os.environ.get('DOCKER_HOST') or subprocess.check_output(
            ['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], text=True).strip()
        if not endpoint.startswith(('unix:///', 'npipe:////./pipe/')):
            raise ValueError('A local Docker socket is required')
        self.docker = ['docker', '--host', endpoint]
        info = json.loads(subprocess.check_output(self.docker + ['inspect', self.record['container']], text=True))[0]
        network = info['HostConfig']['NetworkMode']
        isolated = network == 'none'
        if network.startswith('octiq-seed-tomei-'):
            net = json.loads(subprocess.check_output(self.docker + ['network', 'inspect', network], text=True))[0]
            isolated = net['Internal'] and net['Labels'].get('octiq.seed') == 'ihrms-tomei-v1'
        if (not info['Name'].startswith('/octiq-seed-tomei-')
                or info['Config']['Labels'].get('octiq.seed') != 'ihrms-tomei-v1'
                or not isolated
                or any(p['HostIp'] != '127.0.0.1' for ports in info['NetworkSettings'].get('Ports', {}).values() for p in (ports or []))):
            raise ValueError('Refusing to modify a container that is not an isolated seed builder')

    def sql(self, query, rows=False):
        args = self.docker + ['exec', '-i', '-e', 'SQLCMDPASSWORD=' + self.record['password'],
            self.record['container'], '/opt/mssql-tools18/bin/sqlcmd', '-S', '127.0.0.1',
            '-U', 'sa', '-d', 'octiq_seed', '-C', '-b', '-m', '1', '-y', '0', '-w', '65535']
        result = subprocess.run(args, input='SET NOCOUNT ON; SET XACT_ABORT ON; SET QUOTED_IDENTIFIER ON; SET ANSI_NULLS ON; SET ANSI_WARNINGS ON; SET ANSI_PADDING ON; SET CONCAT_NULL_YIELDS_NULL ON; SET ARITHABORT ON; SET NUMERIC_ROUNDABORT OFF;\n' + query,
            text=True, capture_output=True)
        if result.returncode:
            log = self.root / 'trim-error.log'
            log.write_text(result.stdout + result.stderr); log.chmod(0o600)
            raise RuntimeError(f'Seed SQL failed; private diagnostics: {log}')
        return json.loads(''.join(result.stdout.splitlines()).strip() or '[]') if rows else result.stdout

    def metadata(self):
        tables = self.sql('''SELECT t.object_id id,s.name [schema],t.name,
          (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id=t.object_id AND p.index_id IN (0,1)) [rows],
          (SELECT c.name,ty.name type,c.max_length size,c.is_nullable nullable,c.is_computed computed,
             c.column_id ordinal FROM sys.columns c JOIN sys.types ty ON ty.user_type_id=c.user_type_id
             WHERE c.object_id=t.object_id ORDER BY c.column_id FOR JSON PATH) columns,
          (SELECT c.name FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
             JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
             WHERE i.object_id=t.object_id AND i.is_primary_key=1 ORDER BY ic.key_ordinal FOR JSON PATH) pk
          FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id FOR JSON PATH''', True)
        fks = self.sql('''SELECT f.name,f.parent_object_id child,f.referenced_object_id parent,
          f.delete_referential_action_desc [delete],f.update_referential_action_desc [update],
          (SELECT COL_NAME(k.parent_object_id,k.parent_column_id) child,
                  COL_NAME(k.referenced_object_id,k.referenced_column_id) parent
           FROM sys.foreign_key_columns k WHERE k.constraint_object_id=f.object_id
           ORDER BY k.constraint_column_id FOR JSON PATH) columns
          FROM sys.foreign_keys f FOR JSON PATH''', True)
        for table in tables:
            table['pk'] = [c['name'] for c in table.get('pk', [])]
            table['full'] = quote(table['schema']) + '.' + quote(table['name'])
            table['keep'] = '#k' + str(table['id'])
        return tables, fks


def trim_plan(tables, fks):
    by_id = {t['id']: t for t in tables}
    by_name = {t['name']: t for t in tables}
    sql = ["IF DB_NAME() <> 'octiq_seed' THROW 50000, 'Only the offline seed copy may be trimmed', 1;",
           "ALTER DATABASE octiq_seed SET RECOVERY SIMPLE;"]
    def exists(t, alias='t'):
        return 'EXISTS (SELECT 1 FROM ' + t['keep'] + ' k WHERE ' + ' AND '.join(
            'k.' + quote(c) + '=' + alias + '.' + quote(c) for c in t['pk']) + ')'
    def add(t, predicate='1=1'):
        if not t['pk']:
            return ''
        cols = ','.join('t.' + quote(c) for c in t['pk'])
        return f"INSERT {t['keep']} SELECT {cols} FROM {t['full']} t WHERE ({predicate}) AND NOT {exists(t)}; SET @n+=@@ROWCOUNT;"
    for t in tables:
        if t['pk']:
            cols = ','.join('t.' + quote(c) for c in t['pk'])
            sql.append(f"SELECT TOP (0) {cols} INTO {t['keep']} FROM {t['full']} t UNION ALL SELECT TOP (0) {cols} FROM {t['full']} t; CREATE UNIQUE CLUSTERED INDEX pk ON {t['keep']} ({','.join(map(quote,t['pk']))});")
    sql.append('DECLARE @n int=0;')
    omitted = {'employee_competency', 'employee_competency_header', 'async_job', 'appraisal_export_preset',
               'appraisal_export_preset_share', 'user_dashboard_preferences', 'user_page_column_preferences'}
    references = {'__EFMigrationsHistory', 'ss_user_account_status', 'ss_user_identity_role_type',
                  'sys_modules', 'sys_module_control', 'sys_module_control_template', 'sys_module_control_template_detail',
                  'sys_code', 'sys_code_type', 'ss_code_setting_type', 'sys_license_detail', 'sys_password_policy'}
    for t in tables:
        if (t['schema'] == 'perf' and t['name'] not in omitted and 'attachment' not in t['name']) or t['name'] in references:
            sql.append(add(t))
    user, employee = by_name['ss_user'], by_name['hr_employee']
    # Include one ordinary admin profile as well as the appraisal actors.
    sql.append(add(user, "t.id IN (SELECT TOP(1) u.id FROM dbo.ss_user u JOIN dbo.ss_user_identity_profile p ON p.user_id=u.id WHERE u.user_type=9901 ORDER BY u.id)"))
    links = []
    for t in tables:
        if t['schema'] == 'perf' and t['pk']:
            for c in t['columns']:
                target = user if (c['name'] == 'user_id' or c['name'].endswith('_user_id')) else employee if c['name'] == 'employee_id' else None
                if target and c['type'] in ('int', 'bigint'):
                    links.append(add(target, f"t.id IN (SELECT p.{quote(c['name'])} FROM {t['full']} p WHERE {exists(t, 'p')})"))
    relations = [
        ('ss_user', f"t.employee IN (SELECT id FROM {employee['keep']})"),
        ('hr_employee', f"t.id IN (SELECT u.employee FROM dbo.ss_user u WHERE {exists(user,'u')})"),
        ('ss_user_identity_profile', f"t.user_id IN (SELECT id FROM {user['keep']})"),
        ('ss_user_access_control', f"t.user_id IN (SELECT id FROM {user['keep']})"),
        ('hr_employee_job_service', f"t.employee IN (SELECT id FROM {employee['keep']})"),
        ('employee_competency_header', f"t.employee_id IN (SELECT id FROM {employee['keep']})"),
        ('sys_profile_access_template', f"t.id IN (SELECT a.general_profile_access FROM dbo.ss_user_access_control a WHERE a.user_id IN (SELECT id FROM {user['keep']})) OR t.id IN (SELECT a.payroll_profile_access FROM dbo.ss_user_access_control a WHERE a.user_id IN (SELECT id FROM {user['keep']}))"),
        ('sys_parameter', f"t.company IN (SELECT id FROM {by_name['ss_company']['keep']})"),
    ]
    for name, predicate in relations:
        if name in by_name: links.append(add(by_name[name], predicate))
    for child, parent, column in [('ss_user_identity_role','ss_user_identity','user_identity_id'),
                                  ('employee_competency','employee_competency_header','employee_competency_header_id'),
                                  ('sys_profile_access_template_detail','sys_profile_access_template','template_id'),
                                  ('sys_profile_access_template_criteria','sys_profile_access_template','template_id')]:
        if child in by_name and parent in by_name:
            links.append(add(by_name[child], f"t.{quote(column)} IN (SELECT id FROM {by_name[parent]['keep']})"))
    for fk in fks:
        child, parent = by_id[fk['child']], by_id[fk['parent']]
        if not child['pk'] or not parent['pk']: continue
        join = ' AND '.join('c.'+quote(c['child'])+'=t.'+quote(c['parent']) for c in fk['columns'])
        links.append(add(parent, f"EXISTS (SELECT 1 FROM {child['full']} c WHERE {exists(child,'c')} AND {join})"))
    sql += ['SET @n=1; WHILE @n>0 BEGIN SET @n=0;', *links, 'END;']
    # No row values leave SQL; persist only the plan for review and diagnosis.
    sql.append('BEGIN TRANSACTION;')
    for t in tables: sql.append(f"DISABLE TRIGGER ALL ON {t['full']};")
    for fk in fks: sql.append(f"ALTER TABLE {by_id[fk['child']]['full']} DROP CONSTRAINT {quote(fk['name'])};")
    for t in tables:
        if t['pk']:
            sql.append(f"IF EXISTS (SELECT 1 FROM {t['keep']}) DELETE t FROM {t['full']} t WHERE NOT {exists(t)}; ELSE TRUNCATE TABLE {t['full']};")
        elif t['name'] != '__EFMigrationsHistory':
            sql.append(f"TRUNCATE TABLE {t['full']};")
    for fk in fks:
        child, parent = by_id[fk['child']], by_id[fk['parent']]
        columns = ','.join(quote(c['child']) for c in fk['columns'])
        target = ','.join(quote(c['parent']) for c in fk['columns'])
        actions = ' ON DELETE ' + fk['delete'].replace('_',' ') + ' ON UPDATE ' + fk['update'].replace('_',' ')
        sql.append(f"ALTER TABLE {child['full']} WITH CHECK ADD CONSTRAINT {quote(fk['name'])} FOREIGN KEY ({columns}) REFERENCES {parent['full']} ({target}){actions};")
    sql.append('COMMIT;')
    return '\n'.join(filter(None, sql))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--builder', type=Path, required=True)
    parser.add_argument('--apply', action='store_true', help='Apply the generated pruning plan to the owned copy')
    args = parser.parse_args()
    builder = Builder(args.builder)
    tables, fks = builder.metadata()
    plan = builder.root / 'trim-plan.sql'
    plan.write_text(trim_plan(tables, fks)); plan.chmod(0o600)
    print(f'Generated relationship-preserving plan for {len(tables)} tables; {len(fks)} foreign keys.', flush=True)
    if args.apply:
        builder.sql(plan.read_text())
        print('Pruning complete. This copy still requires anonymization before export.', flush=True)


if __name__ == '__main__':
    main()
