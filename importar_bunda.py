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


def fetch_pages(get_page=_http_json, max_pages=100):
    """Baixa todas as páginas, imprimindo progresso visível no GitHub Actions.

    A quantidade total de páginas é *estimada* a partir de total_pontos,
    quando esse campo estiver disponível na API; o cursor é a fonte de verdade
    para determinar quando o download terminou.
    """
    page_limit = 1000
    points = []
    cursor = None
    seen = set()
    base = None
    coverage = None
    pages = 0
    total_reported = None
    started = time.monotonic()

    print('[Urso SP] Iniciando importação (1000 registros por página).', flush=True)
    for page_number in range(1, max_pages + 1):
        args = {
            'rota': '/api/v1/radares/busca', 'uf': 'SP',
            'limite': page_limit, 'formato': 'json',
            'incluir_operacoes': 'false', 'incluir_trechos': 'false',
        }
        if cursor:
            args['cursor'] = cursor

        print(f'[Urso SP] Solicitando página {page_number}...', flush=True)
        page = get_page(args)
        result, next_cursor = extract_page(page)
        points.extend(result)
        pages += 1
        base = page.get('base') or base
        coverage = page.get('cobertura') or coverage

        # A API informa total_pontos dentro de resultado. Se o campo não vier,
        # apenas mostramos as páginas baixadas, sem inventar total ou percentual.
        declared = page.get('resultado', {}).get('total_pontos')
        if isinstance(declared, int) and not isinstance(declared, bool) and declared >= 0:
            total_reported = declared
        elif isinstance(declared, str) and declared.isdecimal():
            total_reported = int(declared)
