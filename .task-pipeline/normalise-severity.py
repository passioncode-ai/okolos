"""Maps a tier report's blocker/major/minor scale to breaks/risk (the orchestrator's prompt named the wrong scale)."""
import json, sys
MAP = {'blocker': 'breaks', 'major': 'breaks', 'minor': 'risk'}
for p in sys.argv[1:]:
    d = json.load(open(p))
    changed = False
    for f in d.get('findings', []):
        s = f.get('severity')
        if s in MAP:
            f['severity'] = MAP[s]; changed = True
    if changed:
        d.setdefault('not_examined', [])
        note = 'severity normalised by the orchestrator: blocker/major -> breaks, minor -> risk (its prompt named the wrong scale)'
        if isinstance(d['not_examined'], list) and note not in d['not_examined']:
            d['not_examined'].append(note)
        json.dump(d, open(p, 'w'), ensure_ascii=False, indent=2)
    print(p.split('/')[-1], d['verdict'], [f['severity'] for f in d.get('findings', [])])
