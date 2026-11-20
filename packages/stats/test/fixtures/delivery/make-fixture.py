#!/usr/bin/env python3
"""Generate synthetic input and standalone Chrome golden output."""
import datetime
import html.parser
import json
import os
import pathlib
import random
import subprocess
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
if 'REPORT_SOURCE_DIR' not in os.environ:
    raise SystemExit('set REPORT_SOURCE_DIR to the directory holding dev_performance/')
SOURCE = pathlib.Path(os.environ['REPORT_SOURCE_DIR']) / 'dev_performance'
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
rng = random.Random(4087)
types = ['feature','fix','test','refactor','chore','docs','ci','perf','other']
people = [{'name':f'Person {chr(65+i)}','team':f'Team {i%3+1}','roster':i<11,'lead':i%4==0} for i in range(12)]
start = datetime.date(2026, 1, 1)
daily, samples = [], []
for d in range(120):
    date = str(start + datetime.timedelta(days=d))
    for i in range(12):
        if rng.random() < .22 + i*.035:
            continue
        authored = rng.randint(1, 6) + i//4
        delivered = rng.randint(0, authored)
        counts = [0]*len(types)
        for _ in range(delivered):
            counts[rng.randrange(len(types))] += 1
        lines = delivered * rng.randint(8, 100)
        daily.append([i,date,authored,delivered,lines,round(lines**.5,1),*counts])
        if delivered and d % 7 == 0:
            kind = ['feature','fix','refactor'][i%3]
            samples.append([i,date,f'repo-{i%4}',kind,lines,f'{kind}: synthetic work {d} person {i}',i%2])
details = {str(i):{'emails': [],'repos': {},'unmerged': [],'unmerged_total': 0,'open_mrs': [],'closed_mrs': [],'reviews': i%4,'first': str(start),'last':str(start+datetime.timedelta(days=119))} for i in range(12)}
data = {'people':people,'daily':daily,'samples':samples,'types':types,'daily_layout':['person','date','authored','delivered','lines','effort',*types],'type_offset':6,'unit_types':['feature','fix','perf','refactor'],'unmapped':[],'repos':4,'details':details,'minDate':str(start),'maxDate':str(start+datetime.timedelta(days=119)),'synced':'2026-04-30 12:00'}
(HERE/'data.json').write_text(json.dumps({k:v for k,v in data.items() if k!='details'},separators=(',',':'))+'\n')
(HERE/'details.json').write_text(json.dumps(details,separators=(',',':'))+'\n')

class Reader(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(); self.stack=[]; self.section=None; self.depth=0; self.rows=[]; self.cells=[]; self.text=''; self.stats=[]; self.capture=False
    def handle_starttag(self, tag, attrs):
        attrs=dict(attrs)
        if attrs.get('id') in ('stats','teamTable','rankTable'):
            self.section=attrs['id']; self.depth=1
        elif self.section:
            self.depth+=1
        if self.section in ('teamTable','rankTable') and tag=='tr': self.cells=[]
        if self.section in ('teamTable','rankTable') and tag=='td': self.capture=True; self.text=''
        if self.section=='stats' and tag=='div' and attrs.get('class')=='v': self.capture=True; self.text=''
    def handle_data(self, value):
        if self.capture: self.text+=value
    def handle_endtag(self, tag):
        if self.capture and ((self.section=='stats' and tag=='div') or (self.section in ('teamTable','rankTable') and tag=='td')):
            if self.section=='stats': self.stats.append(self.text.strip())
            else: self.cells.append(self.text.strip())
            self.capture=False
        if self.section in ('teamTable','rankTable') and tag=='tr' and self.cells: self.rows.append((self.section,self.cells))
        if self.section:
            self.depth-=1
            if self.depth==0:self.section=None

html = (SOURCE/'template.html').read_text().replace('__CSS__',(SOURCE/'report.css').read_text()).replace('__JS__',(SOURCE/'app.js').read_text()).replace('__TITLE__','Fixture').replace('__DATA__',json.dumps(data,separators=(',',':')).replace('</','<\\/'))
expected={}
with tempfile.TemporaryDirectory() as tmp:
    page=pathlib.Path(tmp)/'index.html'; page.write_text(html)
    for label, days in [('21d',21),('90d',90),('all',None)]:
        from_date = data['minDate'] if days is None else str(datetime.date.fromisoformat(data['maxDate'])-datetime.timedelta(days=days-1))
        dom=subprocess.run([CHROME,'--headless=new','--disable-gpu','--dump-dom',f'{page.as_uri()}?from={from_date}&to={data["maxDate"]}&roster=1'],capture_output=True,text=True,check=True).stdout
        parsed=Reader(); parsed.feed(dom)
        expected[label]={'from':from_date,'to':data['maxDate'],'kpis':parsed.stats,'ranking':[[r[1],r[11],r[12]] for section,r in parsed.rows if section=='rankTable' and len(r)==13], 'teams':[r[:9] for section,r in parsed.rows if section=='teamTable']}
        if len(parsed.stats)!=6 or not expected[label]['ranking'] or not expected[label]['teams']:
            raise RuntimeError(f'Incomplete Chrome output for {label}')
(HERE/'expected.json').write_text(json.dumps(expected,indent=2)+'\n')
