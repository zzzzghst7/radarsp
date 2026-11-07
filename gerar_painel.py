#!/usr/bin/env python3
"""Gera estatísticas agregadas do Radar no Brasil para SP, sem expor pontos individuais.
Uso: python tools/gerar_painel.py /caminho/para/radares.csv
Dados derivados de OpenStreetMap (ODbL) e ANTT: manter atribuição e ODbL.
"""
import collections
import csv
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]

def as_float(v):
    try: return float(v.strip().replace(',', '.'))
    except (AttributeError, ValueError): return None

def generate(csv_path):
    with open(csv_path, encoding='utf-8-sig', newline='') as f:
        rows = [r for r in csv.DictReader(f) if (r.get('estado') or '').strip().upper() == 'SP']
    if not rows: raise ValueError('CSV sem registros do estado de SP')
    cities = collections.defaultdict(list)
    roads = collections.defaultdict(list)
    speeds = collections.Counter()
    sources = collections.Counter()
    valid = 0
    for r in rows:
        city = (r.get('cidade') or 'Não informado').strip()
        road = (r.get('rodovia') or 'Via não informada').strip()
        cities[city].append(r)
        roads[road].append(r)
        s = (r.get('velocidade_kmh') or '').strip()
        speeds[s if s.isdecimal() and 0 < int(s) <= 140 else 'Não informado'] += 1
        sources[(r.get('fonte') or 'Não informada').strip()] += 1
        if as_float(r.get('latitude')) is not None and as_float(r.get('longitude')) is not None: valid += 1
    city_data = []
    for name, items in cities.items():
        good = [(as_float(x.get('latitude')),as_float(x.get('longitude'))) for x in items]
        good = [(a,b) for a,b in good if a is not None and b is not None and -26 < a < -19 and -54 < b < -44]
        # Only city-scale approximate center is exported (rounded to 0.1°), NOT radar coordinates.
        lat = round(sum(a for a,b in good) / len(good), 1) if good else None
        lon = round(sum(b for a,b in good) / len(good), 1) if good else None
        c_roads = collections.Counter((x.get('rodovia') or 'Via não informada').strip() for x in items)
        c_speeds = collections.Counter((x.get('velocidade_kmh') or '').strip() for x in items)
        city_data.append(dict(name=name, count=len(items), lat=lat, lon=lon,
                              roads=[dict(name=n,count=v) for n,v in c_roads.most_common(8)],
                              with_speed=sum(s.isdecimal() and 0<int(s)<=140 for s in c_speeds.elements())))
    city_data.sort(key=lambda x: (-x['count'],x['name']))
    road_data = []
    for name,items in roads.items():
        c_cities=collections.Counter((x.get('cidade') or 'Não informado').strip() for x in items)
        road_data.append(dict(name=name, count=len(items), cities=[dict(name=n,count=k) for n,k in c_cities.most_common()]))
    road_data.sort(key=lambda x:(-x['count'],x['name']))
    obj = dict(schema='ultron-sp-summary-v1', base='Radar no Brasil (CSV público)',
               state='SP', total=len(rows), city_count=len(cities), road_count=len(roads),
               with_speed=sum(v for k,v in speeds.items() if k != 'Não informado'),
               without_speed=speeds['Não informado'], geo_valid=valid,
               speed_distribution=[dict(speed=k,count=v) for k,v in sorted(speeds.items(),key=lambda kv: (kv[0]=='Não informado',int(kv[0]) if kv[0].isdigit() else 0))],
               sources=[dict(name=k,count=v) for k,v in sources.most_common()],
               cities=city_data, roads=road_data,
               sources_urls=['https://www.radarnobrasil.com/fontes-de-dados','https://www.radarnobrasil.com/data/radares.csv','https://www.openstreetmap.org/copyright'],
               note='Contagens informativas; velocidade do equipamento não é limite legal de toda a via. Sem localização individual dos dispositivos.')
    out=ROOT/'data'/'sp_dashboard.json'; out.parent.mkdir(parents=True,exist_ok=True)
    compact=json.dumps(obj,ensure_ascii=False,separators=(',', ':'))
    out.write_text(compact,encoding='utf-8')
    template=ROOT/'index.template.html'
    if template.exists():
        html=template.read_text(encoding='utf-8').replace('__EMBEDDED_DATA__',compact.replace('<',r'\u003c'))
        (ROOT/'index.html').write_text(html,encoding='utf-8')
    return obj

if __name__=='__main__':
    p=pathlib.Path(sys.argv[1] if len(sys.argv)>1 else ROOT/'radares.csv')
    result=generate(p)
    print('SP:',result['total'],'municípios:',result['city_count'],'vias:',result['road_count'],
          'velocidades cadastradas:',result['with_speed'], 'sem velocidade:',result['without_speed'])
