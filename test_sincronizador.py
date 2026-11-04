"""Testes locais: python -m unittest -v"""
from __future__ import annotations

from contextlib import redirect_stdout
import csv
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import sincronizar_radares as etl


def registro(codigo: str, desativacao: str = '') -> dict[str, str]:
    r = dict.fromkeys(etl.COLUNAS, '')
    r.update({
        'CÓDIGO LOCAL': codigo,
        'ATIVAÇÃO': '2025-01-02',
        'DESATIVAÇÃO': desativacao,
        'NÚMERO DE SÉRIE': f'ABC-{codigo}',
        'DESCRIÇÃO DO LOCAL': 'RUA TESTE, PRÓXIMO À PRAÇA',
        'LATITUDE': '-23.5500',
        'LONGITUDE': '-46.6333',
        'TIPO': 'FIXO',
        'VELOCIDADE': '50 km/h',
    })
    return r


class TestarSincronizador(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.patch = patch.object(etl, 'PASTA', Path(self.tmp.name))
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.minimo = patch.object(etl, 'TOTAL_MINIMO', 1)
        self.minimo.start()
        self.addCleanup(self.minimo.stop)

    def executar(self, dados):
        with redirect_stdout(io.StringIO()):
            etl.sincronizar(etl.csv_serializado(dados))

    def test_filtra_desativados_preservando_base_completa(self):
        self.executar([registro('a'), registro('b', '2025-07-01')])
        ativos = etl.interpretar((etl.PASTA / 'radares_ativos.csv').read_text(), validar=False)
        self.assertEqual([r['CÓDIGO LOCAL'] for r in ativos], ['a'])
        self.assertEqual(len(etl.interpretar((etl.PASTA / 'base_completa.csv').read_text(), validar=False)), 2)
        resumo = json.loads((etl.PASTA / 'resumo.json').read_text())
        self.assertEqual((resumo['sem_desativacao'], resumo['com_desativacao']), (1, 1))
        geojson = json.loads((etl.PASTA / 'radares_ativos.geojson').read_text(encoding='utf-8'))
        self.assertEqual(len(geojson['features']), 1)

    def test_mudanca_de_status_registra_evento(self):
        self.executar([registro(str(i)) for i in range(5)])
        self.executar([registro(str(i), '2026-01-01' if i == 0 else '') for i in range(5)])
        with (etl.PASTA / 'historico_eventos.csv').open(encoding='utf-8') as arq:
            eventos=list(csv.DictReader(arq))
        self.assertEqual([evento['evento'] for evento in eventos], ['DESATIVADO'])
        self.assertEqual(eventos[0]['codigo_local'], '0')

    def test_mesma_versao_nao_substitui(self):
        dados=[registro('a')]
        self.executar(dados)
        caminho=etl.PASTA / 'resumo.json'
        antes=caminho.read_bytes()
        with redirect_stdout(io.StringIO()) as saida:
            etl.sincronizar(etl.csv_serializado(dados))
        self.assertEqual(antes,caminho.read_bytes())
        self.assertIn('SEM MUDANÇAS',saida.getvalue())

    def test_csv_truncado_e_rejeitado_e_base_anterior_e_preservada(self):
        dados=[registro('a'),registro('b'),registro('c'),registro('d')]
        self.executar(dados)
        caminho=etl.PASTA / 'base_completa.csv'
        antes=caminho.read_bytes()
        with self.assertRaisesRegex(ValueError, 'Queda >30%'):
            self.executar([registro('a')])
        self.assertEqual(caminho.read_bytes(), antes)

    def test_datas_invalidas_rejeitadas(self):
        dados=[registro('a')]
        dados[0]['ATIVAÇÃO']='01/01/2025'
        with self.assertRaisesRegex(ValueError,'dado inválido'):
            self.executar(dados)
        self.assertFalse((etl.PASTA / 'base_completa.csv').exists())

    def test_identidade_diferencia_mesmo_codigo_com_equipamento_diferente(self):
        r1,r2=registro('abc'),registro('abc')
        r2['NÚMERO DE SÉRIE']='OUTRO'
        self.assertNotEqual(etl.identidade(r1),etl.identidade(r2))


if __name__ == '__main__':
    unittest.main()
