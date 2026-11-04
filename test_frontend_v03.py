"""Verificações estáticas da distribuição web v0.3."""
from pathlib import Path
import json, re, unittest

ROOT=Path(__file__).parent
class TestFrontend(unittest.TestCase):
    def test_arquivos_base_prontos(self):
        base=json.loads((ROOT/'data/radares_ativos.geojson').read_text(encoding='utf8'))
        self.assertEqual(base['type'],'FeatureCollection')
        self.assertEqual(len(base['features']),879)
        self.assertTrue(all(f['geometry']['type']=='Point' for f in base['features']))

    def test_html_controles_gps_simulacao(self):
        html=(ROOT/'index.html').read_text(encoding='utf8')
        self.assertIn("from './localizacao.js'",html)
        for element in ['gps-start','demo-start','gps-follow','gps-stop','demo-pause','demo-reset','gps-accuracy','gps-heading']:
            self.assertRegex(html,rf'id="{element}"')
        self.assertIn('watchPosition(',html)
        self.assertIn('clearWatch(',html)
        self.assertIn('window.isSecureContext',html)
        self.assertIn('.gps-hud [hidden]{display:none!important}',html)

    def test_publicacao_inclui_modulo_de_gps(self):
        workflow=(ROOT/'.github/workflows/atualizar.yml').read_text(encoding='utf8')
        self.assertIn('cp index.html localizacao.js trajetoria.js ajuste_via.js tabela.html publicar/', workflow)
        self.assertTrue((ROOT/'localizacao.js').is_file())

if __name__ == '__main__': unittest.main()
