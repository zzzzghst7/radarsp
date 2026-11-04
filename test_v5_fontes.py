import unittest
from atualizar_fontes import aggregate,fetch_pages

P={'id':'P-13','localizacao':{'uf':'SP','municipio':'Campinas','latitude':-22.9,'longitude':-47.1},'velocidades_resolvidas':[{'categoria':'geral','velocidade_kmh':60,'estado':'sem_conflito'}]}
class TestFontes(unittest.TestCase):
    def test_resumo_sem_localizacao_exata(self):
        d=aggregate([P],879)
        self.assertEqual(d['bunda_registros_sp'],1)
        self.assertEqual(d['municipios'][0]['nome'],'Campinas')
        raw=str(d).lower()
        self.assertNotIn('latitude',raw)
        self.assertNotIn('longitude',raw)
        self.assertNotIn('p-13',raw)
        self.assertNotIn('-47.1',raw)
    def test_cursor(self):
        history=[]
        def fake(params):
            history.append(params.copy())
            return {'sucesso':True,'resultado':{'pontos':[P],'proximo_cursor':'k2' if not params.get('cursor') else None}}
        result,meta=fetch_pages(fetch=fake)
        self.assertEqual(len(result),2)
        self.assertEqual(meta['paginas'],2)
        self.assertEqual(history[0]['uf'],'SP')
        self.assertEqual(history[1]['cursor'],'k2')
if __name__=='__main__':unittest.main()
