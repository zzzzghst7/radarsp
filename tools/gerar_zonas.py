"""Gera mapa de CONCENTRACAO regional a partir de radares.csv.

Não publica coordenadas individuais de fiscalização nem alerta o motorista.
Cada célula representa uma área aproximada de 5 km × 5 km em Web Mercator.
Uso: python tools/gerar_zonas.py radares.csv data/sp_zonas.geojson
"""
import csv
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

R = 6378137.0
GRID_M = 5000

def mercator(latitude, longitude):
    x = R * math.radians(longitude)
    y = R * math.log(math.tan(math.pi/4 + math.radians(latitude)/2))
    return x, y

def unmercator(x, y):
    longitude = math.degrees(x/R)
    latitude = math.degrees(2*math.atan(math.exp(y/R))-math.pi/2)
    return longitude, latitude

def make(csv_path, output):
    buckets = defaultdict(lambda: {'n':0,'cities':Counter(),'roads':Counter()})
    valid=0
    with open(csv_path, encoding='utf-8-sig', newline='') as fh:
        for row in csv.DictReader(fh):
            if row.get('estado', '').strip().upper() != 'SP':
                continue
            try:
                latitude=float(row['latitude'].replace(',','.'))
                longitude=float(row['longitude'].replace(',','.'))
            except (TypeError,KeyError,ValueError):
                continue
            if not (-25.5 <= latitude <= -19.5 and -53.5 <= longitude <= -44.0):
                continue
            x,y=mercator(latitude,longitude)
            ix,iy=math.floor(x/GRID_M),math.floor(y/GRID_M)
            bucket=buckets[(ix,iy)]
            bucket['n']+=1
            bucket['cities'][row.get('cidade','').strip() or 'Não informado']+=1
            bucket['roads'][row.get('rodovia','').strip() or 'Não informada']+=1
            valid+=1
    features=[]
    for (ix,iy),b in sorted(buckets.items()):
        lon,lat=unmercator((ix+0.5)*GRID_M,(iy+0.5)*GRID_M)
        features.append({'type':'Feature','geometry':{'type':'Point','coordinates':[round(lon,5),round(lat,5)]},
                         'properties':{'count':b['n'],'cities':dict(b['cities']), 'roads':dict(b['roads']),
                                       'main_city':b['cities'].most_common(1)[0][0], 'area_km':5}})
    out={'type':'FeatureCollection','metadata':{'state':'SP','representation':'grade regional aproximada, NÃO localização individual de fiscalização',
             'grid_m':GRID_M,'source':'Radar no Brasil — CSV fornecido pelo usuário', 'records':valid,
             'note':'As coordenadas originais não são publicadas neste derivado.'},'features':features}
    Path(output).parent.mkdir(parents=True,exist_ok=True)
    Path(output).write_text(json.dumps(out,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    print('SP rows',valid,'zones',len(features),'sum',sum(z['properties']['count'] for z in features))

if __name__=='__main__':
    make(sys.argv[1],sys.argv[2])
