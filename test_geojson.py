"""Testes do arquivo publicado para o mapa."""
from __future__ import annotations
import csv
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import gerar_geojson as geo


class TestarGeojson(unittest.TestCase):
    def test_pontos_e_registros_sem_desativacao(self):
        with TemporaryDirectory() as temp:
            entrada = Path(temp) / 'base.csv'
            saida = Path(temp) / 'mapa.geojson'
            with entrada.open('w', encoding='utf-8', newline='') as arquivo:
                w=csv.DictWriter(arquivo,fieldnames=[
                    'CÓDIGO LOCAL','ATIVAÇÃO','DESATIVAÇÃO','NÚMERO DE SÉRIE',
                    'DESCRIÇÃO DO LOCAL','LATITUDE','LONGITUDE','VELOCIDADE','FISCALIZA FAIXA AZUL','TIPO'
                ])
                w.writeheader()
                w.writerow({'CÓDIGO LOCAL':'A','ATIVAÇÃO':'2025-01-01','DESATIVAÇÃO':'',
                     'NÚMERO DE SÉRIE':'R123','DESCRIÇÃO DO LOCAL':'RUA TESTE','LATITUDE':'-23.55',
                     'LONGITUDE':'-46.63','VELOCIDADE':'60/50 km/h','FISCALIZA FAIXA AZUL':'Sim','TIPO':'FIXO'})
                w.writerow({'CÓDIGO LOCAL':'B','ATIVAÇÃO':'2025-01-01','DESATIVAÇÃO':'2025-05-01',
                     'NÚMERO DE SÉRIE':'R124','DESCRIÇÃO DO LOCAL':'RUA INATIVA','LATITUDE':'-23.56',
                     'LONGITUDE':'-46.64','VELOCIDADE':'50 km/h','FISCALIZA FAIXA AZUL':'Não','TIPO':'FIXO'})
            count=geo.gerar(entrada,saida)
            self.assertEqual(count,1)
            doc=json.loads(saida.read_text(encoding='utf-8'))
            self.assertEqual(doc['features'][0]['geometry']['coordinates'],[-46.63,-23.55])
            self.assertEqual(doc['features'][0]['properties']['velocidade'],'60/50 km/h')
            self.assertTrue(doc['features'][0]['properties']['faixa_azul'])
            first=saida.read_bytes()
            geo.gerar(entrada,saida)
            self.assertEqual(first,saida.read_bytes())

    def test_recusa_coordenada_aleatoria(self):
        with TemporaryDirectory() as temp:
            a=Path(temp)/'base.csv'; b=Path(temp)/'saida.geojson'
            a.write_text('LATITUDE,LONGITUDE,DESATIVAÇÃO\n0,0,\n',encoding='utf8')
            with self.assertRaisesRegex(ValueError,'fora de São Paulo'):
                geo.gerar(a,b)
            self.assertFalse(b.exists())
