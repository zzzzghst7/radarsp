import importlib.util
import json
import pathlib
import tempfile
import unittest

RAIZ = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("atualizador", RAIZ / "tools" / "atualizar_radares_osm_antt.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

OSM_FAKE = {"elements": [
    {"type": "node", "id": 1, "lat": -23.5505, "lon": -46.6333, "tags": {"highway": "speed_camera", "maxspeed": "50", "name": "Av. Teste"}},
    {"type": "node", "id": 2, "lat": -23.6000, "lon": -46.7000, "tags": {"highway": "speed_camera", "maxspeed": "60 km/h"}},
    {"type": "node", "id": 3, "lat": -23.7000, "lon": -46.7000, "tags": {"highway": "speed_camera", "maxspeed": "signals"}},
    {"type": "node", "id": 4, "lat": -12.0, "lon": -46.7, "tags": {"highway": "speed_camera"}},  # fora de SP
    {"type": "way", "id": 5, "tags": {}},
]}

# separador ';', vírgula decimal, acentos e colunas como no dicionário da ANTT
ANTT_CSV = (
    "concessionaria;ano_do_pnv_snv;tipo_de_radar;rodovia;uf;km_m;Municipio;tipo_de_pista;sentido;situacao;"
    "data_da_inativacao;latitude;longitude;velocidade_leve;velocidade_pesado\n"
    "X;2024;controlador;SP-270;SP;12,5;Taboão da Serra;Principal;Crescente;Ativo;;-23,6200;-46,7500;80;60\n"
    "X;2024;redutor;SP-270;SP;13;Taboão da Serra;Principal;Crescente;Ativo;;-23,6300;-46,7600;40;40\n"
    "X;2024;controlador;SP-270;SP;14;Cotia;Principal;Crescente;Inativo;2025-01-01;-23,6400;-46,7700;80;60\n"
    "X;2024;controlador;BR-116;PR;10;Curitiba;Principal;Crescente;Ativo;;-25,4;-49,2;80;60\n"
).encode("latin-1")


def baixador_ok(url, dados=None, **kw):
    if "overpass" in url:
        return json.dumps(OSM_FAKE).encode()
    if "package_show" in url:
        return json.dumps({"result": {"resources": [
            {"format": "CSV", "url": "https://x/antiga.csv", "last_modified": "2024-01-01"},
            {"format": "CSV", "url": "https://x/nova.csv", "last_modified": "2026-03-28"},
            {"format": "PDF", "url": "https://x/doc.pdf", "last_modified": "2026-04-01"},
        ]}}).encode()
    if url.endswith("nova.csv"):
        return ANTT_CSV
    raise AssertionError("URL inesperada " + url)


def local_fake(pasta):
    fc = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "id": "cet1", "geometry": {"type": "Point", "coordinates": [-46.6333, -23.5505]},
         "properties": {"fonte": "CET-SP", "fontes": ["CET-SP"], "tipo": "FIXO", "velocidade": "50 km/h",
                        "local": "AV TESTE, 100", "municipio": None, "sentido": None}},
        {"type": "Feature", "id": "b1", "geometry": {"type": "Point", "coordinates": [-48.0, -22.0]},
         "properties": {"fonte": "Bunda de Urso / Challado", "fontes": ["Bunda de Urso / Challado"],
                        "tipo": "fixo", "velocidade": "60 km/h", "local": "km 5 · Ex", "municipio": "Ex"}},
        {"type": "Feature", "id": "ruim", "geometry": {"type": "Point", "coordinates": [0, 0]}, "properties": {}},
    ]}
    (pasta / "radares_consolidados.geojson").write_text(json.dumps(fc), encoding="utf-8")


class Utilidades(unittest.TestCase):
    def test_velocidade(self):
        self.assertEqual(mod.parse_velocidade("60 km/h"), 60)
        self.assertEqual(mod.parse_velocidade("50"), 50)
        self.assertIsNone(mod.parse_velocidade("signals"))
        self.assertIsNone(mod.parse_velocidade("none"))
        self.assertIsNone(mod.parse_velocidade(None))
        self.assertIsNone(mod.parse_velocidade("999"))

    def test_tipo(self):
        self.assertEqual(mod.classificar_tipo("redutor"), "lombada")
        self.assertEqual(mod.classificar_tipo("Lombada Eletrônica"), "lombada")
        self.assertEqual(mod.classificar_tipo("controlador"), "fixo")
        self.assertEqual(mod.classificar_tipo("FIXO"), "fixo")
        self.assertEqual(mod.classificar_tipo(None), "desconhecido")

    def test_distancia(self):
        self.assertLess(mod.distancia_m(-23.55, -46.63, -23.55, -46.63), 0.01)
        self.assertAlmostEqual(mod.distancia_m(-23.55, -46.63, -23.55, -46.629), 102, delta=3)


class Fontes(unittest.TestCase):
    def test_osm_filtra_fora_de_sp_e_nao_inventa_velocidade(self):
        pts = mod.buscar_osm(baixador_ok)
        self.assertEqual(len(pts), 3)
        self.assertEqual([p["properties"]["velocidade"] for p in pts], [50, 60, None])
        self.assertEqual(pts[0]["properties"]["local"], "Av. Teste")

    def test_osm_usa_espelho_quando_o_primeiro_falha(self):
        chamadas = []

        def baixar(url, dados=None, **kw):
            chamadas.append(url)
            if "overpass-api.de" in url:
                raise RuntimeError("fora do ar")
            return json.dumps(OSM_FAKE).encode()
        self.assertEqual(len(mod.buscar_osm(baixar)), 3)
        self.assertEqual(len(chamadas), 2)

    def test_antt_usa_csv_mais_novo_e_descarta_inativo_e_outro_estado(self):
        pts = mod.buscar_antt(baixador_ok)
        self.assertEqual(len(pts), 2)
        fixo, lombada = pts
        self.assertEqual(fixo["properties"]["tipo"], "fixo")
        self.assertEqual(fixo["properties"]["velocidade"], 80)
        self.assertEqual(fixo["properties"]["local"], "SP-270 km 12.5")
        self.assertEqual(fixo["geometry"]["coordinates"], [-46.75, -23.62])  # vírgula decimal tratada
        self.assertEqual(lombada["properties"]["tipo"], "lombada")
        self.assertEqual(fixo["properties"]["cidade"], "Taboão da Serra")  # acento latin-1 preservado


class Fusao(unittest.TestCase):
    def test_pipeline_completo(self):
        with tempfile.TemporaryDirectory() as d:
            pasta = pathlib.Path(d)
            local_fake(pasta)
            st = mod.gerar(baixar=baixador_ok, pasta=pasta)
            fc = json.loads((pasta / "radares_mapa.geojson").read_text(encoding="utf-8"))
            ids = [f["id"] for f in fc["features"]]
            # base local: 2 válidos (o ponto 0,0 cai fora); ANTT +2; OSM +2 (o #1 duplica o CET)
            self.assertEqual(st["base_local_pontos"], 2)
            self.assertEqual(st["total"], 6)
            self.assertEqual(len(ids), len(set(ids)))
            cet = next(f for f in fc["features"] if f["id"] == "cet1")
            self.assertEqual(cet["properties"]["fontes"], ["CET-SP", "OpenStreetMap"])  # confirmado por 2 fontes
            self.assertEqual(st["confirmados_por_mais_de_uma_fonte"], 1)
            self.assertEqual(st["novos_por_fonte"], {"ANTT": 2, "OpenStreetMap": 2})
            self.assertIn("OpenStreetMap contributors", fc["metadata"]["atribuicao"])
            for f in fc["features"]:
                lon, lat = f["geometry"]["coordinates"]
                self.assertTrue(mod.dentro_de_sp(lat, lon))
                self.assertIn(f["properties"]["tipo"], {"fixo", "lombada", "desconhecido"})

    def test_velocidades_diferentes_no_mesmo_ponto_sao_equipamentos_distintos(self):
        a = mod.feature("a", -46.6, -23.5, velocidade=50, fontes=["CET-SP"], fonte="CET-SP")
        b = mod.feature("b", -46.6, -23.5, velocidade=60, fontes=["OpenStreetMap"], fonte="OpenStreetMap")
        pts, novos, conf = mod.fundir([a], [b])
        self.assertEqual((len(pts), conf), (2, 0))

    def test_dentro_do_raio_funde_e_fora_do_raio_nao(self):
        a = mod.feature("a", -46.6000, -23.5, velocidade=None, fontes=["CET-SP"], fonte="CET-SP")
        perto = mod.feature("p", -46.6001, -23.5, velocidade=50, fontes=["OpenStreetMap"], fonte="OpenStreetMap")  # ~10 m
        longe = mod.feature("l", -46.6010, -23.5, velocidade=50, fontes=["OpenStreetMap"], fonte="OpenStreetMap")  # ~100 m
        pts, _, conf = mod.fundir([a], [perto, longe])
        self.assertEqual((len(pts), conf), (2, 1))
        self.assertEqual(a["properties"]["velocidade"], 50)  # campo vazio completado pela outra fonte

    def test_fonte_fora_do_ar_nao_derruba_o_resultado(self):
        def baixar(url, dados=None, **kw):
            raise RuntimeError("sem internet")
        with tempfile.TemporaryDirectory() as d:
            pasta = pathlib.Path(d)
            local_fake(pasta)
            st = mod.gerar(baixar=baixar, pasta=pasta)
            self.assertEqual(st["total"], 2)
            self.assertFalse(st["osm"]["ok"])
            self.assertFalse(st["antt"]["ok"])
            self.assertTrue((pasta / "radares_mapa.geojson").exists())

    def test_offline_nao_chama_a_rede(self):
        def baixar(*a, **k):
            raise AssertionError("não deveria acessar a rede")
        with tempfile.TemporaryDirectory() as d:
            pasta = pathlib.Path(d)
            local_fake(pasta)
            st = mod.gerar(offline=True, baixar=baixar, pasta=pasta)
            self.assertEqual((st["total"], st["modo"]), (2, "offline"))


if __name__ == "__main__":
    unittest.main()
