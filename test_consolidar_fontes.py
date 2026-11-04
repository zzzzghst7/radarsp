import unittest
from consolidar_fontes import merge

def feature(lon,lat,vel='50 km/h',src='cet'):
    return {'type':'Feature','geometry':{'type':'Point','coordinates':[lon,lat]},'properties':{'codigo':'A','local':'Teste','velocidade':vel,'origem':src,'fontes':['Bunda de Urso / Challado'] if src=='bunda' else ['CET-SP'],'id_origem':'P-X'}}
class TestMerge(unittest.TestCase):
    def test_duplicata_quase_coincidente(self):
        a={'type':'FeatureCollection','features':[feature(-46.63,-23.55)]}
        b={'type':'FeatureCollection','features':[feature(-46.63000001,-23.55000001,src='bunda')]}
        out,n=merge(a,b)
        self.assertEqual(n,1);self.assertEqual(len(out['features']),1)
        self.assertEqual(len(out['features'][0]['properties']['fontes']),2)
    def test_nao_mesclar_velocidades_conflitantes(self):
        a={'type':'FeatureCollection','features':[feature(-46.63,-23.55)]}
        b={'type':'FeatureCollection','features':[feature(-46.63,-23.55,vel='80 km/h',src='bunda')]}
        out,n=merge(a,b)
        self.assertEqual(n,0);self.assertEqual(len(out['features']),2)
    def test_nao_mesclar_sentidos_opostos(self):
        a=feature(-46.63,-23.55);a['properties']['sentido']='crescente'
        b=feature(-46.63,-23.55,src='bunda');b['properties']['sentido']='decrescente'
        out,n=merge({'features':[a]},{'features':[b]})
        self.assertEqual(len(out['features']),2)
if __name__=='__main__':unittest.main()
