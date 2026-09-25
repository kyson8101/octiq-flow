#!/usr/bin/env python3
"""Mask the trimmed offline copy before it can become a reusable fixture.

Uses the real application's PPLM password implementation. No original record
values are printed or saved to the report. Run after trim_seed.py.
"""
import argparse
import json
from pathlib import Path
import re
import secrets
import subprocess
from trim_seed import Builder, literal, quote

TECHNICAL = {
    'kpi_type', 'navigation_direction', 'question_type', 'value_mode', 'field_type',
    'visibility', 'state', 'actor_role', 'action_type', 'responsible_party', 'page_type',
    'type', 'status', 'section_type', 'stage_type', 'answer_input_type', 'field_name', 'operator',
    'permission', 'actor_type', 'rating_method', 'entry_type', 'calculation', 'period_type',
    'best_direction', 'target_mode', 'source_handle', 'target_handle', 'gender', 'marital_status',
    'pay_salary_count_by', 'pay_salary_paid', 'pay_payment_method', 'job_status',
    'view_access_actor_types', 'edit_access_actor_types', 'required_by_actor_types',
    'weightage_edit_access_actor_types', 'private_supporting_document_actor_types',
    'public_supporting_document_actor_types', 'optional_by_actor_types_json',
}
REFERENCE_TABLES = {
    '__EFMigrationsHistory', 'ss_user_account_status', 'ss_user_identity_role_type',
    'sys_modules', 'sys_module_control', 'sys_module_control_template_detail',
    'sys_code', 'sys_code_type', 'ss_code_setting_type', 'ss_country',
}
STRINGS = {'varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext'}


def scrub_json(value, technical_values):
    if isinstance(value, list): return [scrub_json(v, technical_values) for v in value]
    if isinstance(value, dict): return {k: scrub_json(v, technical_values) for k, v in value.items()}
    if isinstance(value, str):
        if value in technical_values or re.fullmatch(r'[\d\s,.-]*', value) or re.fullmatch(r'[a-fA-F0-9-]{32,36}', value): return value
        return 'Sample'
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--builder', required=True, type=Path)
    parser.add_argument('--password-tool', required=True, type=Path)
    args = parser.parse_args()
    builder = Builder(args.builder)
    tables, fks = builder.metadata()
    # Refuse to mask a full untrimmed restore by mistake.
    count = builder.sql('SELECT COUNT(*) n FROM dbo.hr_employee FOR JSON PATH', True)[0]['n']
    if count > 100: raise ValueError('Trim to at most 100 employees before anonymizing')
    password = 'Sandbox!' + secrets.token_hex(8)
    salt = 'SANDBOX1'
    encrypted = subprocess.check_output(['dotnet', str(args.password_tool.resolve())],
        input=json.dumps({'password': password, 'salt': salt}), text=True).strip()
    fk_columns = {(fk['child'], c['child']) for fk in fks for c in fk['columns']}
    data = {}
    technical_values = {'true','false','yes','no','number','text','rating','radio','checkbox','dropdown','textarea','date','employee','evaluator','admin'}
    for table in tables:
        # This data stays in process memory; only masked values become SQL.
        rows = builder.sql(f"SELECT * FROM {table['full']} FOR JSON PATH", True) if table.get('rows', 0) else []
        data[table['id']] = rows
        for row in rows:
            for c in table['columns']:
                if c['name'] in TECHNICAL and isinstance(row.get(c['name']), str): technical_values.add(row[c['name']])
    sql = ["IF DB_NAME() <> 'octiq_seed' THROW 50000, 'Not an offline seed copy', 1; BEGIN TRANSACTION;"]
    accounts = []
    for table in tables:
        name = table['name']
        rows = data[table['id']]
        if not rows or name in REFERENCE_TABLES: continue
        if not table['pk']: raise ValueError(f'Cannot mask a retained table without a primary key: {name}')
        for index, row in enumerate(rows, 1):
            marker = str(row.get('id', index))
            assignments = []
            for c in table['columns']:
                col, kind = c['name'], c['type']
                value = row.get(col)
                if value is None or c['computed'] or col in table['pk'] or (table['id'], col) in fk_columns: continue
                masked = value
                if kind in STRINGS and col not in TECHNICAL and not col.endswith('_identity_id'):
                    if name == 'ss_user_identity' and col == 'password' or name == 'ss_user' and col == 'password': masked = encrypted
                    elif col in ('identifier','username'): masked = f'sandbox-{index:02}' if name == 'ss_user_identity' else f'user-{marker}'
                    elif 'email' in col: masked = f'seed-{index}@example.invalid'
                    elif col == 'employee_no': masked = 'E' + str(row.get('employee_id', row.get('employee', row.get('id', index))))
                    elif col == 'nric': masked = f'{index:012}'
                    elif name == 'sys_license_detail' and col in ('cid','pid','sid'): masked = salt if col == 'cid' else 'SEED0001'
                    elif col.endswith('_user_ids') or col.endswith('_user_ids_json') or col == 'responder_user_ids':
                        if re.fullmatch(r'[\d\s,\[\]]*', value): masked = value
                        else: raise ValueError(f'Unexpected user ID list in {name}.{col}')
                    elif re.search(r'password|token|secret|path|phone|mobile|account_number|tax_number|socso_number|old_ic|address', col): masked = None if c['nullable'] else ''
                    else:
                        try: parsed = json.loads(value)
                        except (ValueError, TypeError): parsed = None
                        if isinstance(parsed, (dict, list)):
                            masked = json.dumps(scrub_json(parsed, technical_values), separators=(',', ':'))
                        elif kind in STRINGS and re.fullmatch(r'-?\d+(\.\d+)?', value) and ('response_value' in col or 'rate' in col): masked = '1'
                        else: masked = f'Sample {name} {marker}'
                    if masked is not None and c['size'] > 0:
                        masked = masked[:c['size'] // (2 if kind.startswith('n') else 1)]
                elif kind in ('decimal','money','numeric','float','real') and (table['schema'] != 'perf' or re.search(r'salary|amount|increment|bonus|allowance|compensation', col)):
                    masked = 0
                elif col == 'date_of_birth': masked = '2000-01-01'
                elif col == 'photo_attachment_id' and c['nullable']: masked = None
                if masked != value:
                    encoded = 'NULL' if masked is None else literal(masked) if isinstance(masked, str) else str(masked)
                    assignments.append(quote(col) + '=' + encoded)
            if name == 'ss_user_identity':
                assignments += ["[account_status]=1"]
                accounts.append({'login': f'sandbox-{index:02}', 'identityId': row['id']})
            if assignments:
                predicate = ' AND '.join(quote(c)+'='+literal(row[c]) for c in table['pk'])
                updates = ',\n'.join(assignments)
                sql.append(f"UPDATE {table['full']} SET\n{updates}\nWHERE {predicate};")
    # These contain production sessions, transports, credentials or personal logs.
    forbidden = ['ss_user_auth_session','ss_user_identity_external','ss_user_action_token','ss_user_login_detail',
        'ss_private_access_token','ss_two_factor_auth_code','ss_email_smtp','ss_email_queue','ss_email_log',
        'ss_upload_setting','sys_license','sys_error_log','sys_audit_trail','audit_user_activity','audit_database_change']
    for table in tables:
        if table['name'] in forbidden:
            sql.append(f"IF EXISTS(SELECT 1 FROM {table['full']}) THROW 50000, 'Unexpected sensitive rows remain after pruning', 1;")
    # The UI ships English fallback text; a synthetic locale lets Core return an
    # empty customization dictionary without copying customer translations.
    sql.append("IF NOT EXISTS(SELECT 1 FROM dbo.i18n_language WHERE locale_code='en') INSERT dbo.i18n_language(locale_code,display_name,native_name,is_active,is_default,created_date) VALUES('en','English','English',1,1,GETDATE());")
    sql += ['COMMIT;', 'DBCC CHECKCONSTRAINTS WITH ALL_CONSTRAINTS;']
    # Nothing containing the new credentials is committed with the kit.
    plan = builder.root / 'anonymize.sql'; plan.write_text('\n'.join(sql)); plan.chmod(0o600)
    builder.sql(plan.read_text())
    receipt = builder.root / 'fixture.json'
    receipt.write_text(json.dumps({'version': 'ihrms-tomei-v1', 'source': 'ihrms_tomei',
        'employees': count, 'password': password, 'accounts': accounts,
        'status': 'masked; authenticated application checks pending'}, indent=2))
    receipt.chmod(0o600)
    print(f'Masked {count} employees and {len(accounts)} identities. Private fixture manifest: {receipt}')


if __name__ == '__main__': main()
