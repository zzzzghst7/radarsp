"""Contrato de paginação e dados do Bunda de Urso sem acessar a rede."""
from pathlib import Path
import json,tempfile,unittest
from importar_bunda import extract_page,parse_candidates,save,fetch_pages

SAMPLE={'id':'P-1','localizacao':{'latitude':-23.55,'longitude':-46.63,'uf':'SP','municipio':'São Paulo','qualidade':'oficial'},'via':{'codigo':'SP-330','km':25.2},'velocidades_resolvidas':[{'categoria':'geral','velocidade_kmh':80,'estado':'sem_conflito'}], 'fontes':[{'nome':'DER-SP - Radares estaduais'}]}
class TestBunda(unittest.TestCase):
  def setUp(self):self.page={'sucesso':True,'resultado':{'pontos':[SAMPLE],'proximo_cursor':None}}
  def test_envelope(self):
    p,c=extract_page(self.page)
    self.assertEqual(len(p),1);self.assertIsNone(c)
  def test_transformar(self):
    f,counts=parse_candidates(self.page)
    self.assertEqual(len(f['features']),1)
    props=f['features'][0]['properties']
    self.assertEqual(props['fonte'],'Bunda de Urso / Challado')
    self.assertEqual(props['velocidade'],'80 km/h')
    self.assertEqual(props['fontes_originais'],['DER-SP - Radares estaduais'])
    self.assertEqual(counts['geolocalizados_sp'],1)
  def test_pagination_cursor(self):
    calls=[]
    def fake(params):
      calls.append(params.copy());d=dict(self.page);d['resultado']={'pontos':[SAMPLE],'proximo_cursor':'abc' if not params.get('cursor') else None};return d
    d=fetch_pages(get_page=fake)
    self.assertEqual(len(d['resultado']['pontos']),2)
    self.assertEqual(d['paginas'],2)
    self.assertEqual(calls[0]['rota'],'/api/v1/radares/busca')
    self.assertEqual(calls[1]['cursor'],'abc')
  def test_sem_dado_nao_substitui(self):
    with tempfile.TemporaryDirectory() as td:
      path=Path(td)/'arquivo.geojson';stat=Path(td)/'status.json'
      save(self.page,path,stat)
      old=path.read_bytes()
      with self.assertRaises(ValueError):save({'sucesso':True,'resultado':{'pontos':[],'proximo_cursor':None}},path,stat)
      self.assertEqual(path.read_bytes(),old)
  def test_rejeita_inativos_e_sem_coordenada(self):
    old={**SAMPLE,'id':'P-2','data_inativacao':'2026-01-01'}
    missing={**SAMPLE,'id':'P-3','localizacao':{'uf':'SP'}}
    foreign={**SAMPLE,'id':'P-4','localizacao':{'latitude':-22.0,'longitude':-46.0,'uf':'MG'}}
    d={'sucesso':True,'resultado':{'pontos':[SAMPLE,old,missing,foreign],'proximo_cursor':None}}
    result,c=parse_candidates(d)
    self.assertEqual(len(result['features']),1);self.assertEqual(c['sem_gps'],1)
  def test_nao_aceitar_exportacao_parcial(self):
    d={**self.page,'resultado':{**self.page['resultado'],'proximo_cursor':'continue'}}
    with self.assertRaises(ValueError):parse_candidates(d)
if __name__=='__main__':unittest.main()
