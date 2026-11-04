#!/usr/bin/env python3
"""Cliente INDEPENDENTE da API pública Bunda de Urso (CC BY 4.0).

Busca a UF SP com cursor opaco (sem GPS do visitante), guarda apenas pontos
geolocalizados no mapa. Nunca reutiliza código do servidor de terceiros.
Se a fonte falhar, NÃO substitui o último snapshot válido.
"""
from __future__ import annotations
import argparse
import json
import math
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT=Path(__file__).resolve().parent
API='https://servidor3.lucas.inf.br/openclaw/radar/api.pse'
OUT=ROOT/'data/bunda_sp.geojson'
META=ROOT/'data/bunda_status.json'
UF='SP'


def extract_page(document):
    if not isinstance(document,dict) or document.get('sucesso') is not True:
        raise ValueError(f'Resposta da API não confirma sucesso: {str(document)[:200]}')
    result=document.get('resultado')
    if not isinstance(result,dict) or not isinstance(result.get('pontos'),list):
        raise ValueError('API sem resultado.pontos, contrato inesperado')
    cursor=result.get('proximo_cursor')
    if cursor is not None and (not isinstance(cursor,str) or not cursor):
        raise ValueError('Cursor inválido')
    return result['pontos'],cursor


def _http_json(params, retries=2):
    url=API+'?'+urlencode(params)
    for attempt in range(retries+1):
        try:
            req=Request(url,headers={'User-Agent':'Detector-Ultron-V5/1.0 (public-data client; github.com/Challado/Bunda-de-Urso)',
                                     'Accept':'application/json'})
            with urlopen(req,timeout=40) as r:
                if r.status!=200: raise RuntimeError(f'API HTTP {r.status}')
                payload=r.read(15*1024*1024+1)
                if len(payload)>15*1024*1024: raise ValueError('Página da API excedeu 15 MB')
            return json.loads(payload)
        except (URLError,TimeoutError,HTTPError) as err:
            if attempt>=retries or isinstance(err,HTTPError) and err.code not in (429,500,502,503,504):raise
            time.sleep(2*(attempt+1))


def fetch_pages(get_page=_http_json,max_pages=100):
    points=[]; cursor=None; seen=set(); base=None; coverage=None; pages=0
    for _ in range(max_pages):
        args={'rota':'/api/v1/radares/busca','uf':'SP','limite':1000,
              'formato':'json','incluir_operacoes':'false','incluir_trechos':'false'}
        if cursor:args['cursor']=cursor
        page=get_page(args)
        result,cursor=extract_page(page)
        points.extend(result);pages+=1
        base=page.get('base') or base
        coverage=page.get('cobertura') or coverage
        if cursor is None:break
        if cursor in seen:raise RuntimeError('Cursor repetido, download incompleto')
        seen.add(cursor)
    else:raise RuntimeError('Limite de páginas; download incompleto')
    return {'sucesso':True,'resultado':{'pontos':points,'proximo_cursor':None},
            'base':base or {},'cobertura':coverage or {},'paginas':pages}


def _float(value):
    try:
        v=float(value)
        return v if math.isfinite(v) else None
    except (ValueError,TypeError):return None


def _limit(p):
    # Somente velocidade regulamentada RESOLVIDA e não conflitante. Nunca usar valor nominal do medidor.
    resolved=p.get('velocidades_resolvidas') or []
    options=[]
    for r in resolved if isinstance(resolved,list) else []:
        if not isinstance(r,dict) or r.get('estado')!='sem_conflito':continue
        if r.get('categoria') not in (None,'geral'):continue
        v=_float(r.get('velocidade_kmh'))
        if v and 10<=v<=140:options.append(int(v))
    if not options:
        v=_float(p.get('velocidade_geral_kmh'))
        if v and 10<=v<=140:options=[int(v)]
    return str(options[0])+' km/h' if options and len(set(options))==1 else 'Não informado'


def parse_candidates(document):
    pts,cursor=extract_page(document)
    if cursor:raise ValueError('Importação parcial: cursor restante')
    features=[];ids=set();invalid=0;without_gps=0;out_of_state=0
    for p in pts:
        if not isinstance(p,dict):invalid+=1;continue
        ident=str(p.get('id') or '').strip()
        if not ident or ident in ids:continue
        ids.add(ident)
        if p.get('removido_em') or p.get('data_inativacao') or str(p.get('situacao_operacional') or '').casefold() in ('inativo','desativado','removido','suspenso'):
            continue
        loc=p.get('localizacao') or {}
        if not isinstance(loc,dict):without_gps+=1;continue
        lat=_float(loc.get('latitude'));lon=_float(loc.get('longitude'))
        if lat is None or lon is None:without_gps+=1;continue
        uf=str(loc.get('uf') or p.get('uf') or '').upper().strip()
        if (uf and uf!='SP') or not (-26.5<lat<-19.0 and -54.5<lon<-43.5):
            out_of_state+=1;continue
        via=p.get('via') or {}
        endereco=p.get('endereco') or {}
        if not isinstance(via,dict):via={}
        if not isinstance(endereco,dict):endereco={}
        municipality=str(loc.get('municipio') or p.get('municipio') or '').strip()
        road=str(via.get('codigo') or via.get('nome') or p.get('via_codigo') or endereco.get('logradouro') or '').strip()
        km=via.get('km',p.get('km',loc.get('km')))
        km_part=f' · km {km}' if km is not None else ''
        name=(road+km_part).strip() or str(endereco.get('logradouro') or '').strip()
        if municipality:name=(name+' · '+municipality).strip(' ·')
        if not name:name='Ponto cadastrado sem endereço completo'
        raw_sources=p.get('fontes') or []
        original_sources=[str(s.get('nome'))[:120] for s in raw_sources if isinstance(s,dict) and s.get('nome')]
        types=p.get('tipos_radar_presentes') or []
        if not isinstance(types,list):types=[]
        precision=_float(loc.get('precisao_metros'))
        geo_quality=str(loc.get('qualidade') or 'não informada')
        features.append({
          'type':'Feature','id':'urso:'+ident,
          'geometry':{'type':'Point','coordinates':[lon,lat]},
          'properties':{
              'codigo':ident,'id_origem':ident,'local':name[:240],
              'velocidade':_limit(p),'faixa_azul':False,
              'tipo':', '.join(str(x) for x in types)[:100] or 'Não informado',
              'fonte':'Bunda de Urso / Challado','fontes':['Bunda de Urso / Challado'],
              'fontes_originais':original_sources[:8],
              'url_fonte':'https://github.com/Challado/Bunda-de-Urso',
              'status_operacional':str(p.get('situacao_operacional') or 'não confirmado'),
              'confianca':str(p.get('confianca') or 'não avaliada'),
              'verificacao_status':str(p.get('verificacao_status') or 'não informada'),
              'qualidade_gps':geo_quality,'precisao_metros':precision,
              'via_codigo':road,'municipio':municipality,'sentido':', '.join(str(s.get('sentido') or '') for s in (p.get('faixas') or []) if isinstance(s,dict))[:100],
              'ativacao':p.get('data_inicio_operacao') or '',
              'origem':'bunda',
          }
        })
    return {'type':'FeatureCollection','features':features}, {
        'recebidos':len(pts),'geolocalizados_sp':len(features),
        'sem_gps':without_gps,'fora_sp':out_of_state,'invalidos':invalid,
        'paginas':document.get('paginas'),
        'snapshot_id':(document.get('base') or {}).get('snapshot_id'),
        'cobertura_completa_confirmada':(document.get('cobertura') or {}).get('completude_confirmada') is True,
    }


def atomic_json(path,doc):
    path.parent.mkdir(parents=True,exist_ok=True)
    value=json.dumps(doc,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n'
    if path.exists() and path.read_text(encoding='utf-8')==value:return False
    tmp=path.with_suffix(path.suffix+'.tmp')
    tmp.write_text(value,encoding='utf-8')
    os.replace(tmp,path)
    return True


def save(document,output=OUT,meta_path=META):
    coll,counts=parse_candidates(document)
    if not coll['features']:
        raise ValueError('API sem pontos de SP com GPS: snapshot anterior preservado')
    atomic_json(output,coll)
    # Metadados estáveis: sem novo commit em toda execução por causa do relógio
    atomic_json(meta_path,counts)
    return counts


def main():
    cli=argparse.ArgumentParser(description=__doc__)
    group=cli.add_mutually_exclusive_group(required=True)
    group.add_argument('--online',action='store_true',help='Consulta pública com paginação; requer internet')
    group.add_argument('--input',type=Path,help='Exportação JSON completa com resultado.pontos')
    opts=cli.parse_args()
    d=fetch_pages() if opts.online else json.loads(opts.input.read_text(encoding='utf-8'))
    result=save(d)
    print('Bunda de Urso SP: '+json.dumps(result,ensure_ascii=False))

if __name__=='__main__':main()
