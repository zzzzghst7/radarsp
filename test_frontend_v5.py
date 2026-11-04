"""Testes da interface V5 sem depender de artefatos gerados no GitHub."""
import json
import tempfile
import unittest
from pathlib import Path

from consolidar_fontes import build


class Frontend(unittest.TestCase):
    def test_map_and_data(self):
        root = Path(__file__).resolve().parent
        html = (root / 'index.html').read_text(encoding='utf-8')
        for part in ('public-radars', 'radar-points', 'radar-clusters',
                     'radar-search', 'origin', 'watchPosition'):
            self.assertIn(part, html)

        # A consolidação é uma ETAPA POSTERIOR aos testes no workflow.
        # Testar em diretório temporário evita depender de um arquivo já publicado.
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / 'radares_consolidados.geojson'
            status = Path(temp) / 'consolidado_status.json'
            stats = build(
                cet_path=root / 'data' / 'radares_ativos.geojson',
                bunda_path=Path(temp) / 'bunda_ausente.geojson',
                out_path=out,
                status_path=status,
            )
            data = json.loads(out.read_text(encoding='utf-8'))
            self.assertEqual(data['type'], 'FeatureCollection')
            self.assertGreater(len(data['features']), 0)
            self.assertEqual(len(data['features']), stats['pontos_no_mapa'])

    def test_workflow(self):
        root = Path(__file__).resolve().parent
        workflow = (root / '.github' / 'workflows' / 'atualizar.yml').read_text(encoding='utf-8')
        for name in ('sincronizar_radares.py', 'importar_bunda.py',
                     'consolidar_fontes.py', 'radares_consolidados.geojson',
                     'index.html'):
            self.assertIn(name, workflow)


if __name__ == '__main__':
    unittest.main()
