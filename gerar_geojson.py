#!/usr/bin/env python3
"""Converte a saída filtrada do sincronizador CET-SP em GeoJSON para MapLibre.

Não consulta a rede; usa exclusivamente data/radares_ativos.csv.
Python 3.10+, sem dependências externas.
"""
from __future__ import annotations
import csv
from hashlib import sha256
import json
import os
from pathlib import Path

DIR = Path(__file__).resolve().parent / "data"
ENTRADA = DIR / "radares_ativos.csv"
SAIDA = DIR / "radares_ativos.geojson"


def gerar(entrada: Path = ENTRADA, saida: Path = SAIDA) -> int:
    with entrada.open(encoding="utf-8-sig", newline="") as f:
        linhas = list(csv.DictReader(f))

    features = []
    for n, r in enumerate(linhas, start=2):
        if (r.get("DESATIVAÇÃO") or "").strip():
            # Defesa contra um CSV filtrado de forma incorreta.
            continue
        try:
            longitude = float((r.get("LONGITUDE") or "").replace(",", "."))
            latitude = float((r.get("LATITUDE") or "").replace(",", "."))
        except ValueError as exc:
            raise ValueError(f"Coordenadas inválidas na linha {n}") from exc
        if not (-47.3 < longitude < -46.0 and -24.2 < latitude < -23.1):
            raise ValueError(f"Coordenadas fora de São Paulo, linha {n}: {longitude}, {latitude}")
        ident = "|".join([
            r.get("CÓDIGO LOCAL", ""), r.get("ATIVAÇÃO", ""),
            r.get("NÚMERO DE SÉRIE", ""), r.get("LATITUDE", ""),
            r.get("LONGITUDE", "")
        ])
        features.append({
            "type": "Feature",
            "id": sha256(ident.encode("utf-8")).hexdigest()[:16],
            "geometry": {"type": "Point", "coordinates": [longitude, latitude]},
            "properties": {
                "codigo": r.get("CÓDIGO LOCAL", ""),
                "local": r.get("DESCRIÇÃO DO LOCAL", ""),
                "velocidade": r.get("VELOCIDADE", ""),
                "faixa_azul": r.get("FISCALIZA FAIXA AZUL", "").strip().casefold() == "sim",
                "tipo": r.get("TIPO", ""),
                "faixas": r.get("FAIXAS", ""),
                "ativacao": r.get("ATIVAÇÃO", ""),
                "serie": r.get("NÚMERO DE SÉRIE", ""),
                "enquadramento": r.get("ENQUADRAMENTO", ""),
            },
        })

    documento = {"type": "FeatureCollection", "features": features}
    saida.parent.mkdir(parents=True, exist_ok=True)
    conteudo = json.dumps(documento, ensure_ascii=False, separators=(",", ":")) + "\n"
    if not saida.exists() or saida.read_text(encoding="utf-8") != conteudo:
        temporario = saida.with_suffix(".geojson.tmp")
        temporario.write_text(conteudo, encoding="utf-8", newline="")
        os.replace(temporario, saida)
    print(f"GEOJSON | {len(features)} pontos | {saida}")
    return len(features)


if __name__ == "__main__":
    gerar()
