#!/usr/bin/env python3
"""Read-only, streaming candidate scan for Codex sandbox refusal evidence.

Only metadata is emitted. Review candidates against their command event to
exclude log readbacks and intentional test controls before ranking refusals.
Inputs are live; access comes from attempt/latest-index metadata, not per-turn
history. Files spanning the date cutoff are reported separately.
"""
import argparse, json, os, re, time, collections, glob, datetime
parser = argparse.ArgumentParser(description='Stream Codex runtime refusal candidates; emit metadata only, never commands or output.')
parser.add_argument('--profile', default=os.path.expanduser('~/.octiqflow/profiles/default'))
parser.add_argument('--diagnostics', default=os.path.expanduser('~/.octiqflow/logs/agent-diagnostics.jsonl'))
parser.add_argument('--end', help='UTC ISO timestamp; default is scan start')
parser.add_argument('--exclude-chat', action='append', default=[])
parser.add_argument('--output', required=True)
args = parser.parse_args()
base = args.profile
end = datetime.datetime.fromisoformat(args.end.replace('Z', '+00:00')).timestamp() if args.end else time.time()
start = end - 14 * 86400
index = {x['id']: x for x in json.load(open(base + '/chats/index.json'))['chats']}
ledger = json.load(open(base + '/orchestrations.json'))
attempts = {x['workerChatKey'].removeprefix('chat:'): x for x in ledger['attempts'].values()}
rows = []
scanned = collections.Counter()
itemtypes = collections.Counter()
start_iso = datetime.datetime.fromtimestamp(start, datetime.timezone.utc).isoformat()
net = re.compile('^(?:error connecting to|fatal: unable to access|fatal: unable to (?:look up|connect)|(?:curl|wget):|.*\\berror(?:\\[[^]]+\\])?:|\\s*(?:Error:|Caused by:|[0-9]+:)|ssh:|npm (?:ERR!|error))[^\\n]*(?:Could not resolve|name resolution|ENOTFOUND|EAI_AGAIN|nodename nor servname|Network is unreachable|failed to lookup address|error connecting to|Failed to connect)', re.I)
op = re.compile('Operation not permitted|Permission denied|\\bEPERM\\b|\\bEACCES\\b', re.I)
echo = re.compile('^\\s*(?:[0-9]+(?::|-(?![0-9]{2}-))|\\+|//|\\* |#|[-*] |(?:const|let|assert|if|print|eprintln|println|return|pub|fn)\\b|["\\x27`])')

def classify(text, command, cid):
    lines = [s for s in text.splitlines() if not echo.search(s)]
    real = [s for s in lines if op.search(s)]
    cats = set()
    for line in lines:
        if net.search(line):
            cats.add('network_dns')
    for line in real:
        ll = line.lower()
        if not re.search('^(?:\\s*(?:error|fatal|panic|caused by|called|thread|sh:|zsh:|bash:|sysctl:|find:|rg:|ssh:|listen|connect|octiq-job:|adb |\\[[0-9]+:|\\d{4}-\\d\\d-\\d\\d)|.*(?:Error:|Error opening log file|failed: operation not permitted|message:.*(?:EPERM|Operation not permitted)))', line, re.I):
            continue
        if 'cannot lock ref' in ll or ('unable to create' in ll and '.git' in ll) or 'could not create sequencer' in ll:
            if 'sequencer' in ll or 'rebase-' in ll:
                cats.add('git_sequencer_rebase')
            elif 'cannot lock ref' in ll:
                name = re.search("cannot lock ref 'refs/heads/([^']+)'", line)
                cats.add('git_other_branch' if name and attempts.get(cid, {}).get('branch') and name[1] != attempts[cid]['branch'] else 'git_ref_lock')
            elif 'packed-refs' in ll:
                cats.add('git_packed_refs')
            else:
                cats.add('git_admin_write')
        elif 'octiq-job:' in ll:
            cats.add('job_loopback_spooled')
        elif re.search('(?:sh:.*\\bps\\b|/bin/ps)', ll):
            cats.add('process_ps')
        elif 'sysctl:' in ll:
            cats.add('process_sysctl')
        elif 'kill' in ll:
            cats.add('process_kill')
        elif any((s in ll for s in ['simctl', 'smartsocket', 'bootstrap_check_in'])):
            cats.add('native_device_browser')
        elif 'watchman' in ll:
            cats.add('watchman_socket')
        elif any((s in ll for s in ['listen', 'connect', 'ssh:'])):
            cats.add('network_socket')
        elif any((s in ll for s in ['mkdir', 'rg:', 'find:'])):
            cats.add('outside_file')
        else:
            cats.add('os_permission_other')
    if 'git_other_branch' in cats:
        cats.discard('git_packed_refs')
    return cats

def add(source, cid, text, event, access, period, command='', status=None):
    cats = classify(text or '', command, cid)
    for cat in cats:
        rows.append(dict(source=source, chat=cid, access=access, kind='worker' if cid in attempts or cid.startswith('orch-') else 'chat', period=period, category=cat, event=event, exit=status))
for p in glob.glob(base + '/chats/*.jsonl'):
    cid = os.path.basename(p)[5:-6]
    m = index.get(cid, {})
    if cid in args.exclude_chat or os.stat(p).st_mtime < start:
        continue
    a = attempts.get(cid, {})
    if m.get('createdAt', a.get('createdAt', 0)) > end * 1000:
        continue
    period = 'within' if m.get('createdAt', a.get('createdAt', 0)) / 1000 >= start else 'spans_cutoff_undated'
    access = a.get('access') or m.get('access') or 'unknown'
    seen = set()
    codex = False
    scanned['all_recent_files'] += 1
    scanned['bytes'] += os.stat(p).st_size
    with open(p) as h:
        for n, line in enumerate(h, 1):
            if '"item.completed"' not in line:
                continue
            try:
                x = json.loads(line)
            except:
                scanned['invalid_lines'] += 1
                continue
            if x.get('type') != 'item.completed':
                continue
            codex = True
            item = x.get('item', {})
            it = item.get('type')
            iid = item.get('id')
            itemtypes[it] += 1
            if iid is not None and iid in seen:
                continue
            seen.add(iid)
            if it == 'command_execution':
                scanned['commands'] += 1
                add('transcript', cid, item.get('aggregated_output'), n, access, period, item.get('command', ''), item.get('exit_code'))
            elif it == 'mcp_tool_call':
                if 'request_access' in item.get('tool', ''):
                    rows.append(dict(source='transcript', chat=cid, access=access, kind='worker' if cid in attempts else 'chat', period=period, category='access_card_ask', event=n, exit=None))
                elif item.get('error'):
                    add('transcript', cid, str(item['error']), n, access, period)
    if codex:
        scanned[period + '_codex_files'] += 1
with open(args.diagnostics) as h:
    for n, l in enumerate(h, 1):
        try:
            x = json.loads(l)
        except:
            continue
        if not start * 1000 <= x.get('timestamp_ms', 0) <= end * 1000 or x.get('provider') != 'codex':
            continue
        scanned['diagnostics'] += 1
        cid = x.get('chat_key', 'unknown').removeprefix('chat:')
        add('diagnostics', cid, x.get('message', ''), n, attempts.get(cid, {}).get('access') or index.get(cid, {}).get('access', 'unknown'), 'within')
for a in ledger['attempts'].values():
    if a.get('agent') != 'codex' or not start * 1000 <= a.get('updatedAt', 0) <= end * 1000:
        continue
    err = a.get('execution', {}).get('latestError')
    if err:
        scanned['ledger_latestErrors'] += 1
        add('latestError', a['workerChatKey'].removeprefix('chat:'), str(err), a['id'], a.get('access', 'unknown'), 'within')
summary = []
for key, count in collections.Counter(((r['period'], r['source'], r['category'], r['access'], r['kind']) for r in rows)).most_common():
    examples = [r['chat'] for r in rows if (r['period'], r['source'], r['category'], r['access'], r['kind']) == key]
    summary.append(dict(zip(['period', 'source', 'category', 'access', 'kind'], key), count=count, chats=len(set(examples)), example=examples[0]))
result = {'start': start_iso, 'end': datetime.datetime.fromtimestamp(end, datetime.timezone.utc).isoformat(), 'scanned': dict(scanned), 'summary': summary, 'rows': rows, 'itemtypes': dict(itemtypes)}
open(args.output, 'w').write(json.dumps(result, indent=2))
print(json.dumps({k: v for k, v in result.items() if k not in ['rows', 'itemtypes']}, indent=2))
