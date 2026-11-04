#!/usr/bin/env python3
"""Painel V5: agregados de fiscalização por cidade, SEM coordenadas ou rota de radares.
Dados públicos da API Bunda de Urso (CC BY 4.0). Código independente.
"""
from __future__ import annotations
import csv
import json
from collections import Counter
from datetime import datetime,timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request,urlopen

ROOT=Path(__file__).resolve().parent
OUTPUT=ROOT/'data/resumo_fontes_sp.json'
API='https://servidor3.lucas.inf.br/openclaw/radar/api.pse'

def fetch_pages(fetch=None,max_pages=100):
    def network(params):
        url=API+'?'+urlencode(params)
        req=Request(url,headers={'Accept':'application/json','User-Agent':'Ultron-V5-Painel-Informativo/1.0'})
        with urlopen(req,timeout=40) as response:
            raw=response.read(15*1024*1024+1)
            if len(raw)>15*1024*1024:raise ValueError('Página excede 15MB')
        return json.loads(raw)
    fetch=fetch or network
    points=[];cursor=None;seen=set();pages=0;coverage=None;source_base=None
    for _ in range(max_pages):
        args={'rota':'/api/v1/radares/busca','uf':'SP','limite':'1000','formato':'json'}
        if cursor:args['cursor']=cursor
        document=fetch(args)
        if document.get('sucesso') is not True:raise ValueError('API não confirmou sucesso')
        result=document.get('resultado') or {}
        chunk=result.get('pontos')
        if not isinstance(chunk,list):raise ValueError('Resposta sem lista de pontos')
        points.extend(chunk);pages+=1
        coverage=document.get('cobertura') or coverage
        source_base=document.get('base') or source_base
        cursor=result.get('proximo_cursor')
        if not cursor:break
        if cursor in seen:raise ValueError('Cursor de paginação repetido')
        seen.add(cursor)
    else:raise ValueError('Número de páginas excedido; sincronização cancelada')
    return points,{'paginas':pages,'completude_confirmada':bool((coverage or {}).get('completude_confirmada')),'snapshot':(source_base or {}).get('snapshot_id')}


def _speed(p):
    values=[]
    for entry in p.get('velocidades_resolvidas') or []:
        if not isinstance(entry,dict) or entry.get('estado')!='sem_conflito' or entry.get('categoria') not in ('geral',None):continue
        value=entry.get('velocidade_kmh')
        if isinstance(value,(int,float)) and 10<=value<=140:values.append(int(value))
    if not values:
        value=p.get('velocidade_geral_kmh')
        if isinstance(value,(int,float)) and 10<=value<=140:values.append(int(value))
    return values[0] if values and len(set(values))==1 else None


def aggregate(points,cet_count=0,source_meta=None):
    source_meta=source_meta or {}
    by_city=Counter();by_speed=Counter();by_quality=Counter();by_provenance=Counter()
    status=Counter();ids=set();without_city=0
    for p in points:
        if not isinstance(p,dict):continue
        ident=str(p.get('id') or '')
        if not ident or ident in ids:continue
        ids.add(ident)
        if p.get('removido_em') or p.get('data_inativacao'):continue
        location=p.get('localizacao') or {}
        if not isinstance(location,dict):location={}
        uf=str(location.get('uf') or p.get('uf') or 'SP').upper()
        if uf!='SP':continue
        city=(str(location.get('municipio') or p.get('municipio') or '').strip() or 'Município não informado')
        if city=='Município não informado':without_city+=1
        by_city[city]+=1
        v=_speed(p)
        if v is not None:by_speed[f'{v} km/h']+=1
        by_quality[str(location.get('qualidade') or 'não informada')]+=1
        status[str(p.get('situacao_operacional') or 'não informada')]+=1
        for src in p.get('fontes') or []:
            if isinstance(src,dict) and src.get('nome'):by_provenance[str(src['nome'])[:100]]+=1
    # Exclusivamente agregados: nenhum identificador, endereço, latitude ou longitude de fiscalização.
    return {'nome':'DETECTOR INFALÍVEL DE RADARES ULTRON MEGA V5',
        'tipo':'resumo_estatistico_sem_posicoes',
        'cet_registros_sem_desativacao':cet_count,
        'bunda_registros_sp':sum(by_city.values()),
        'municipios':[{'nome':k,'registros':v} for k,v in by_city.most_common()],
        'limites_publicados':[{'limite':k,'registros':v} for k,v in sorted(by_speed.items(),key=lambda a:int(a[0].split()[0]))],
        'qualidade_coordenadas':dict(by_quality),
        'situacoes':dict(status),
        'fontes_originais':[{'nome':k,'registros':v} for k,v in by_provenance.most_common()],
        'municipios_nao_identificados':without_city,
        'completude_confirmada':source_meta.get('completude_confirmada') is True,
        'snapshot_origem':source_meta.get('snapshot'),
        'paginas_origem':source_meta.get('paginas'),
        'creditos':{'bunda':'https://github.com/Challado/Bunda-de-Urso','cet':'https://github.com/cetsp-dados/dados-fiscalizacao-eletronica'},
        'observacao':'Resumo informativo; não confirma operação física ou cobertura completa. Respeite a sinalização.',
    }


def cet_count(path):
    if not path.exists():return 0
    with path.open(encoding='utf-8-sig',newline='') as f:return sum(1 for _ in csv.DictReader(f))

def run():
    data,meta=fetch_pages()
    count=cet_count(ROOT/'data/radares_ativos.csv')
    result=aggregate(data,count,meta)
    if result['bunda_registros_sp']<1:raise ValueError('Resposta vazia da API; snapshot anterior preservado')
    OUTPUT.parent.mkdir(parents=True,exist_ok=True)
    encoded=json.dumps(result,ensure_ascii=False,indent=2,sort_keys=True)+'\n'
    if OUTPUT.exists() and OUTPUT.read_text(encoding='utf8')==encoded:
        print('Nenhuma mudança no resumo estatístico');return
    dest=OUTPUT.with_suffix('.tmp');dest.write_text(encoded,encoding='utf8');dest.replace(OUTPUT)
    print('Resumo atualizado:',result['bunda_registros_sp'],'registros SP,',len(result['municipios']),'municípios')
if __name__=='__main__':run()
