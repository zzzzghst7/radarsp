#!/usr/bin/env python3
"""Gera data/radares_mapa.geojson: radares individuais de SP para o mapa.

Fontes (as mesmas que o site Radar no Brasil declara em /fontes-de-dados):
  * OpenStreetMap (Overpass API), tag highway=speed_camera  -> ODbL
  * ANTT, dados abertos, radares em rodovias concedidas      -> CC-BY
  * Base local já existente no repositório (CET-SP + Bunda de Urso),
    lida de data/radares_consolidados.geojson

Uso:
  python tools/atualizar_radares_osm_antt.py            # baixa OSM + ANTT e funde
  python tools/atualizar_radares_osm_antt.py --offline  # só reprocessa a base local

Se uma fonte estiver fora do ar, o script avisa, registra o erro em
data/radares_mapa_status.json e segue com o que tiver. Nunca inventa pontos.
Dados derivados do OpenStreetMap exigem atribuição (© OpenStreetMap contributors, ODbL).
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import math
import pathlib
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
LOCAL_BASES = ("radares_consolidados.geojson", "radares_ativos.geojson")
SAIDA = DATA / "radares_mapa.geojson"
STATUS = DATA / "radares_mapa_status.json"

# Caixa que envolve o estado de SP (sul, oeste, norte, leste) e filtro de sanidade.
SUL, OESTE, NORTE, LESTE = -25.35, -53.15, -19.75, -44.10

OVERPASS_URLS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
OVERPASS_QUERY = """
[out:json][timeout:180];
area["ISO3166-2"="BR-SP"][admin_level=4]->.sp;
(
  node["highway"="speed_camera"](area.sp);
  node["enforcement"="maxspeed"](area.sp);
);
out body qt;
""".strip()
ANTT_PACKAGE = "https://dados.antt.gov.br/api/3/action/package_show?id=radar"
USER_AGENT = "radarsp/1.0 (+https://github.com/zzzzghst7/radarsp)"
RAIO_DUPLICADO_M = 25.0


# --------------------------------------------------------------------------- utilidades
def norm(texto) -> str:
    s = unicodedata.normalize("NFD", str(texto or ""))
    return "".join(c for c in s if unicodedata.category(c) != "Mn").lower().strip()


def dentro_de_sp(lat, lon) -> bool:
    return (
        lat is not None and lon is not None
        and math.isfinite(lat) and math.isfinite(lon)
        and SUL <= lat <= NORTE and OESTE <= lon <= LESTE
    )


def para_float(valor):
    """Aceita '-23,55', ' -23.55 ', None. Devolve float ou None."""
    if valor is None:
        return None
    try:
        return float(str(valor).strip().replace(",", "."))
    except ValueError:
        return None


def parse_velocidade(valor):
    """'60', '60 km/h', 60.0 -> 60. Descarta 'none', 'signals', 0 e valores absurdos."""
    m = re.search(r"\d{2,3}", str(valor if valor is not None else ""))
    if not m:
        return None
    n = int(m.group(0))
    return n if 10 <= n <= 130 else None


def classificar_tipo(*textos) -> str:
    """fixo | lombada | desconhecido. Heurística declarada, sem inventar certeza."""
    s = norm(" ".join(str(t or "") for t in textos))
    if re.search(r"lomb|redutor|barreira eletronica", s):
        return "lombada"
    if re.search(r"fix|control|speed_camera|radar|maxspeed", s):
        return "fixo"
    return "desconhecido"


def distancia_m(lat1, lon1, lat2, lon2) -> float:
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def http_get(url: str, dados: bytes | None = None, timeout: int = 200, tentativas: int = 3) -> bytes:
    ultimo = None
    for i in range(tentativas):
        try:
            req = urllib.request.Request(url, data=dados, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            ultimo = exc
            if i + 1 < tentativas:
                time.sleep(4 * (i + 1))
    raise RuntimeError(f"falha ao baixar {url}: {ultimo}")


def feature(fid, lon, lat, **props):
    props.setdefault("tipo", "desconhecido")
    props.setdefault("velocidade", None)
    return {
        "type": "Feature",
        "id": fid,
        "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
        "properties": props,
    }


# --------------------------------------------------------------------------- base local
def carregar_base_local(pasta: pathlib.Path = DATA):
    """Lê o consolidado (CET + Bunda) e normaliza para o esquema do mapa."""
    for nome in LOCAL_BASES:
        caminho = pasta / nome
        if not caminho.exists():
            continue
        bruto = json.loads(caminho.read_text(encoding="utf-8"))
        saida = []
        for f in bruto.get("features", []):
            try:
                lon, lat = f["geometry"]["coordinates"][:2]
            except (KeyError, TypeError, ValueError):
                continue
            if not dentro_de_sp(lat, lon):
                continue
            p = f.get("properties") or {}
            fontes = p.get("fontes") or ([p["fonte"]] if p.get("fonte") else [])
            saida.append(feature(
                str(f.get("id") or f"local:{len(saida)}"), lon, lat,
                tipo=classificar_tipo(p.get("tipo")),
                velocidade=parse_velocidade(p.get("velocidade")),
                local=(p.get("local") or "").strip() or None,
                cidade=(p.get("municipio") or "").strip() or None,
                sentido=(p.get("sentido") or "").strip() or None,
                fonte=fontes[0] if fontes else "Base local",
                fontes=list(dict.fromkeys(fontes)),
            ))
        return saida, nome
    return [], None


# --------------------------------------------------------------------------- OpenStreetMap
def osm_para_features(elementos):
    saida = []
    for el in elementos:
        if el.get("type") != "node":
            continue
        lat, lon = el.get("lat"), el.get("lon")
        if not dentro_de_sp(lat, lon):
            continue
        t = el.get("tags") or {}
        local = t.get("name") or t.get("ref") or t.get("description")
        saida.append(feature(
            f"osm:{el['id']}", lon, lat,
            tipo=classificar_tipo(t.get("name"), t.get("description"), t.get("note"),
                                  "lombada" if t.get("traffic_calming") else ""),
            velocidade=parse_velocidade(t.get("maxspeed")),
            local=(local or "").strip() or None,
            cidade=(t.get("addr:city") or "").strip() or None,
            sentido=(t.get("direction") or t.get("camera:direction") or "").strip() or None,
            fonte="OpenStreetMap",
            fontes=["OpenStreetMap"],
        ))
    return saida


def buscar_osm(baixar=http_get):
    corpo = urllib.parse.urlencode({"data": OVERPASS_QUERY}).encode()
    erros = []
    for url in OVERPASS_URLS:
        try:
            dados = json.loads(baixar(url, corpo))
            return osm_para_features(dados.get("elements", []))
        except Exception as exc:  # noqa: BLE001 - tenta o espelho seguinte
            erros.append(str(exc))
    raise RuntimeError("; ".join(erros))


# --------------------------------------------------------------------------- ANTT
def decodificar_csv(bruto: bytes):
    for enc in ("utf-8-sig", "latin-1"):
        try:
            texto = bruto.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    amostra = texto[:4096]
    delim = ";" if amostra.count(";") > amostra.count(",") else ","
    return list(csv.DictReader(io.StringIO(texto), delimiter=delim))


def antt_para_features(linhas):
    saida = []
    for i, r in enumerate(linhas):
        r = {norm(k).replace(" ", "_"): (v or "").strip() for k, v in r.items() if k}
        if r.get("uf", "").upper() != "SP":
            continue
        situacao = norm(r.get("situacao"))
        if r.get("data_da_inativacao") or "inativ" in situacao or "desativ" in situacao:
            continue
        lat, lon = para_float(r.get("latitude")), para_float(r.get("longitude"))
        if not dentro_de_sp(lat, lon):
            continue
        km = para_float(r.get("km_m"))
        rodovia = r.get("rodovia", "")
        # a coluna chama km_m, mas costuma vir em km; só mostramos quando é plausível
        km_txt = f"km {km:g}" if km is not None and 0 <= km < 1500 else ""
        local = " ".join(x for x in (rodovia, km_txt) if x) or None
        saida.append(feature(
            f"antt:{i}", lon, lat,
            tipo=classificar_tipo(r.get("tipo_de_radar")),
            velocidade=parse_velocidade(r.get("velocidade_leve")),
            velocidade_pesado=parse_velocidade(r.get("velocidade_pesado")),
            local=local,
            cidade=r.get("municipio") or None,
            sentido=r.get("sentido") or None,
            fonte="ANTT",
            fontes=["ANTT"],
        ))
    return saida


def buscar_antt(baixar=http_get):
    pacote = json.loads(baixar(ANTT_PACKAGE))
    recursos = [r for r in pacote["result"]["resources"] if str(r.get("format", "")).lower() == "csv"]
    recursos.sort(key=lambda r: r.get("last_modified") or r.get("created") or "", reverse=True)
    for rec in recursos:
        linhas = decodificar_csv(baixar(rec["url"]))
        if linhas and {"tipo_de_radar", "latitude"} <= {norm(k).replace(" ", "_") for k in linhas[0]}:
            return antt_para_features(linhas)
    raise RuntimeError("nenhum CSV de radares com latitude encontrado no dataset da ANTT")


# --------------------------------------------------------------------------- fusão
class IndiceEspacial:
    """Grade de ~55 m para achar vizinhos sem comparar todos contra todos."""
    CELULA = 0.0005

    def __init__(self):
        self.celulas = {}

    def _chave(self, lat, lon):
        return int(math.floor(lat / self.CELULA)), int(math.floor(lon / self.CELULA))

    def adicionar(self, f):
        lon, lat = f["geometry"]["coordinates"]
        self.celulas.setdefault(self._chave(lat, lon), []).append(f)

    def vizinho_duplicado(self, f, raio=RAIO_DUPLICADO_M):
        lon, lat = f["geometry"]["coordinates"]
        ci, cj = self._chave(lat, lon)
        vel = f["properties"].get("velocidade")
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for g in self.celulas.get((ci + di, cj + dj), ()):
                    glon, glat = g["geometry"]["coordinates"]
                    if distancia_m(lat, lon, glat, glon) > raio:
                        continue
                    gvel = g["properties"].get("velocidade")
                    # velocidades diferentes no mesmo ponto = equipamentos distintos (sentidos opostos)
                    if vel is not None and gvel is not None and vel != gvel:
                        continue
                    return g
        return None


def fundir(base, *conjuntos):
    """Mantém a base e acrescenta pontos novos; confirma duplicados somando a fonte."""
    indice = IndiceEspacial()
    resultado = []
    for f in base:
        indice.adicionar(f)
        resultado.append(f)
    novos = {}
    confirmados = 0
    for conjunto in conjuntos:
        for f in conjunto:
            existente = indice.vizinho_duplicado(f)
            if existente is None:
                indice.adicionar(f)
                resultado.append(f)
                novos[f["properties"]["fonte"]] = novos.get(f["properties"]["fonte"], 0) + 1
                continue
            confirmados += 1
            p, q = existente["properties"], f["properties"]
            for fonte in q["fontes"]:
                if fonte not in p["fontes"]:
                    p["fontes"].append(fonte)
            for campo in ("velocidade", "local", "cidade", "sentido"):
                if not p.get(campo) and q.get(campo):
                    p[campo] = q[campo]
            if p.get("tipo") == "desconhecido" and q.get("tipo") != "desconhecido":
                p["tipo"] = q["tipo"]
    return resultado, novos, confirmados


# --------------------------------------------------------------------------- principal
def gerar(offline=False, baixar=http_get, pasta: pathlib.Path = DATA, agora=None):
    agora = agora or dt.datetime.now(dt.timezone.utc)
    base, origem_base = carregar_base_local(pasta)
    status = {
        "gerado_em_utc": agora.replace(microsecond=0).isoformat(),
        "base_local": origem_base, "base_local_pontos": len(base),
        "osm": {"ok": None, "pontos": 0, "erro": None},
        "antt": {"ok": None, "pontos": 0, "erro": None},
    }
    antt = osm = []
    if not offline:
        for nome, buscar in (("antt", buscar_antt), ("osm", buscar_osm)):
            try:
                pts = buscar(baixar)
                status[nome].update(ok=True, pontos=len(pts))
                if nome == "antt":
                    antt = pts
                else:
                    osm = pts
            except Exception as exc:  # noqa: BLE001 - uma fonte fora do ar não derruba as outras
                status[nome].update(ok=False, erro=str(exc)[:300])
                print(f"AVISO: fonte {nome.upper()} indisponível: {exc}", file=sys.stderr)
    # prioridade: base local (CET/Bunda) > ANTT (km e sentido) > OSM
    pontos, novos, confirmados = fundir(base, antt, osm)
    status.update(total=len(pontos), novos_por_fonte=novos, confirmados_por_mais_de_uma_fonte=confirmados,
                  modo="offline" if offline else "online")
    fc = {
        "type": "FeatureCollection",
        "metadata": {
            "atribuicao": "© OpenStreetMap contributors (ODbL); ANTT (CC-BY); CET-SP; Bunda de Urso / Challado",
            "aviso": "Cadastros públicos, sem confirmação física de funcionamento. Vale a sinalização da via.",
            "gerado_em_utc": status["gerado_em_utc"],
        },
        "features": pontos,
    }
    pasta.mkdir(parents=True, exist_ok=True)
    (pasta / SAIDA.name).write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (pasta / STATUS.name).write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")
    return status


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--offline", action="store_true", help="não acessa a internet; só reprocessa a base local")
    args = ap.parse_args(argv)
    st = gerar(offline=args.offline)
    print(json.dumps(st, ensure_ascii=False, indent=2))
    if st["total"] == 0:
        print("ERRO: nenhum ponto gerado.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
