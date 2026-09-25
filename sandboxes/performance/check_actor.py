#!/usr/bin/env python3
"""Give readiness its own normal identity bound to one retained admin profile."""
import argparse
import json
from pathlib import Path
import uuid
from trim_seed import Builder, literal, quote


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--builder', required=True, type=Path)
    p.add_argument('--database', choices=['octiq_seed','octiq_fixture'], default='octiq_seed')
    args = p.parse_args()
    b = Builder(args.builder)
    path = b.root / 'fixture.json'
    manifest = json.loads(path.read_text())
    if not manifest['status'].startswith('masked'): raise ValueError('Only a masked copy can be used')
    prefix = 'USE ' + quote(args.database) + ';\n'
    if b.sql(prefix + "SELECT COUNT(*) n FROM dbo.ss_user_identity WHERE identifier='sandbox-check' FOR JSON PATH", True)[0]['n']:
        raise ValueError('Readiness identity already exists; refusing to replace its credentials')
    choices = b.sql(prefix + '''SELECT TOP (1) u.id userId,e.company companyId,a.id appraisalId,p.user_identity_id identityId,
        (SELECT TOP(1) id FROM dbo.ss_user WHERE id<>u.id ORDER BY id) deniedUserId
      FROM perf.appraisal a JOIN dbo.hr_employee e ON e.id=a.employee_id
      JOIN dbo.ss_user_access_control ac ON ac.company=e.company
      JOIN dbo.ss_user u ON u.id=ac.user_id
      JOIN dbo.ss_user_identity_profile p ON p.user_id=u.id
      WHERE u.user_type IN (9901,9905) AND u.status=1 AND u.is_deleted=0 AND a.deleted_at IS NULL
      ORDER BY u.id,a.id FOR JSON PATH''', True)
    if not choices: raise ValueError('No retained active admin can view a retained appraisal')
    chosen = choices[0]
    identity = str(uuid.uuid4())
    b.sql(prefix + f'''BEGIN TRANSACTION;
      INSERT dbo.ss_user_identity (id,identifier,description,password,email,account_status,create_date)
        SELECT {literal(identity)},'sandbox-check','Sandbox readiness',password,'readiness@example.invalid',1,GETDATE()
        FROM dbo.ss_user_identity WHERE id={literal(chosen['identityId'])};
      INSERT dbo.ss_user_identity_profile (user_identity_id,user_id,create_date)
        VALUES ({literal(identity)},{chosen['userId']},GETDATE());
      INSERT dbo.ss_user_identity_role (user_identity_id,role_id)
        SELECT {literal(identity)},role_id FROM dbo.ss_user_identity_role WHERE user_identity_id={literal(chosen['identityId'])};
      COMMIT;
    ''')
    manifest['check'] = {k:v for k,v in chosen.items() if k!='identityId'} | {'login':'sandbox-check'}
    path.write_text(json.dumps(manifest, indent=2)); path.chmod(0o600)
    print('Dedicated normal readiness identity created; actor and company recorded privately.')


if __name__ == '__main__': main()
