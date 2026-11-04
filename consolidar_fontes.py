#!/usr/bin/env python3
"""Consolidação prudente CET + Bunda de Urso para o mapa de educação viária.

Uma coincidência de coordenadas não prova mesma pista, então só agrupa quando
quase coincidentes, limite compatível e sem sentidos explicitamente opostos.
Retém identificadores e fontes originais. Nenhuma localização de usuário envolvida.
"""
from __future__ import annotations
import json,math
from pathlib import Path
from importar_bunda import atomic_json
ROOT=Path(__file__).resolve().parent
CET=ROOT/'data/radares_ativos.geojson'
BUNDA=ROOT/'data/bunda_sp.geojson'
OUTPUT=ROOT/'data/radares_consolidados.geojson'
STATUS=ROOT/'data/consolidado_status.json'

def distance_m(a,b):
    # Haversine em WGS84
    x,y=a;v,w=b
    r=6371000;dlat=math.radians(w-y);dlon=math.radians(v-x)
    q=math.sin(dlat/2)**2+math.cos(math.radians(y))*math.cos(math.radians(w))*math.sin(dlon/2)**2
    return 2*r*math.asin(min(1,math.sqrt(q)))

def speed_number(v):
    import re
    m=re.fullmatch(r'(\d+) km/h',str(v or ''))
    return int(m.group(1)) if m else None

def eligible(a,b):
    x=a['properties'];y=b['properties']
    da=speed_number(x.get('velocidade')); db=speed_number(y.get('velocidade'))
    if da is not None and db is not None and da!=db:return False
    s1=str(x.get('sentido') or '').strip().casefold()
    s2=str(y.get('sentido') or '').strip().casefold()
    if s1 and s2 and s1!=s2:return False
    return distance_m(a['geometry']['coordinates'],b['geometry']['coordinates'])<=8

def _readgeo(path,required):
    if not path.exists():
        if required:raise FileNotFoundError(path)
        return {'type':'FeatureCollection','features':[]}
    d=json.loads(path.read_text(encoding='utf-8'))
    if d.get('type')!='FeatureCollection' or not isinstance(d.get('features'),list):raise ValueError(f'GeoJSON inválido: {path}')
    return d

def merge(cet,bunda):
    merged=[];grid={};joined=0
    for original in cet['features']:
        p=json.loads(json.dumps(original))
        props=p.setdefault('properties',{})
        props.update({'fonte':'CET-SP','fontes':['CET-SP'],'origem':'cet','qualidade_gps':'CET-SP', 'confianca':'cadastro CET (sem confirmação física)'})
        merged.append(p)
        lon,lat=p['geometry']['coordinates'];key=(round(lon,4),round(lat,4))
        grid.setdefault(key,[]).append(len(merged)-1)
    for other in bunda['features']:
        c=other['geometry']['coordinates'];k=(round(c[0],4),round(c[1],4))
        # Buscar em grid vizinha, pois arredondamento pode ficar em lados diferentes.
        possible=[]
        for dx in (-.0001,0,.0001):
            for dy in (-.0001,0,.0001):
                possible.extend(grid.get((round(k[0]+dx,4),round(k[1]+dy,4)),[]))
        candidates=[i for i in possible if eligible(merged[i],other)]
        if len(candidates)==1:
            p=merged[candidates[0]]['properties'];bp=other['properties']
            if 'Bunda de Urso / Challado' not in p['fontes']:p['fontes'].append('Bunda de Urso / Challado')
            p['id_origem_bunda']=bp.get('id_origem');p['fontes_originais']=bp.get('fontes_originais',[])
            joined+=1
        else:
            merged.append(other)
    return {'type':'FeatureCollection','features':merged},joined

def build(cet_path=CET,bunda_path=BUNDA,out_path=OUTPUT,status_path=STATUS):
    cet=_readgeo(cet_path,True);bunda=_readgeo(bunda_path,False)
    combined,joined=merge(cet,bunda)
    if not combined['features']:raise ValueError('Nenhum dado: não publicar GeoJSON vazio')
    stats={'cet':len(cet['features']),'bunda_sp_com_gps':len(bunda['features']),
           'deduplicados_probaveis':joined,'pontos_no_mapa':len(combined['features']),
           'bunda_disponivel':bunda_path.exists(),
           'metodo':'mesma coordenada até 8 m, limite compatível e sentido não conflitante'}
    atomic_json(out_path,combined);atomic_json(status_path,stats)
    return stats

if __name__=='__main__':print(json.dumps(build(),ensure_ascii=False))
