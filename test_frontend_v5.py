import json,unittest
from pathlib import Path
class Frontend(unittest.TestCase):
 def test_map_and_data(self):
  root=Path(__file__).resolve().parent
  html=(root/'index.html').read_text()
  for s in ('public-radars','radar-points','radar-clusters','radar-search','origin','watchPosition'):
   self.assertIn(s,html)
  d=json.loads((root/'data/radares_consolidados.geojson').read_text())
  self.assertGreater(len(d['features']),0)
 def test_workflow(self):
  y=(Path(__file__).resolve().parent/'.github/workflows/atualizar.yml').read_text()
  for s in ('sincronizar_radares.py','importar_bunda.py','consolidar_fontes.py','radares_consolidados.geojson','index.html'):
   self.assertIn(s,y)
