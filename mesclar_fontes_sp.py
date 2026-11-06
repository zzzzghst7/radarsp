#!/usr/bin/env python3
"""Mescla base principal do Pardal com registros oficiais de SP.

Objetivo:
- usar o Pardal como base principal;
- adicionar ou atualizar registros oficiais quando houver informação mais recente;
- ignorar duplicatas prováveis apenas quando a coincidência for forte;
- manter a origem e a data dos dados;
- nunca inventar limite de velocidade ausente.

A lógica é conservadora: não somar todos os registros nem fundir pontos com
sentidos pistas diferentes sem confirmação.
"""
from __future__ import annotations

import csv
import json
import math
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


DEFAULT_PARDAL = Path("estados/SP/radares.csv")
DEFAULT_OFICIAL = Path("radares_sp_para_copilot_142kb.csv")
DEFAULT_OUT = Path("data/radares_mistos.geojson")
DEFAULT_REPORT = Path("data/mesclagem_radares_report.json")


def as_float(value: Any) -> float | None:
    if value is None:
        return None
    s = str(value).strip().replace(".", "").replace(",", ".")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_int(value: Any) -> int | None:
    n = as_float(value)
    if n is None:
        return None
    return int(n) if abs(n - round(n)) < 1e-9 else None


def normalize_text(value: Any) -> str:
    if value is None:
        return ""
    return " ".join(str(value).strip().split())


def normalize_road(value: Any) -> str:
    s = normalize_text(value).upper().replace("/", " /")
    s = s.replace("  ", " ")
    return s.strip()


def road_key(value: Any) -> str:
    return re.sub(r"[^A-Z0-9/\s-]", "", normalize_road(value)).strip()


def parse_km(value: Any) -> float | None:
    n = as_float(value)
    if n is None:
        return None
    return float(n)


def parse_sense_tokens(value: Any) -> set[str]:
    raw = normalize_text(value)
    if not raw:
        return set()
    tokens: set[str] = set()
    for part in re.split(r"[,;/]", raw):
        token = re.sub(r"[^A-Z0-9-]", "", part.upper())
        if token:
            tokens.add(token)
    if not tokens:
        for token in re.findall(r"[A-Z]+-?[0-9]*", raw.upper()):
            tokens.add(token)
    return tokens


def standardize_sense(value: Any) -> str:
    toks = sorted(parse_sense_tokens(value))
    return ",".join(toks)


def parse_limit(value: Any) -> int | None:
    n = as_float(value)
    if n is None:
        return None
    if 10 <= n <= 220:
        return int(round(n))
    return None


def parse_date(value: Any) -> str:
    s = normalize_text(value)
    if not s:
        return ""
    return s


def harvesine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6371000.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    )
    return 2 * radius * math.asin(min(1.0, math.sqrt(a)))


def get_record_priority(record: dict[str, Any]) -> int:
    return 2 if record.get("source_rank", 0) >= 2 else 1


def duplicate_conflict(record_a: dict[str, Any], record_b: dict[str, Any]) -> tuple[bool, str]:
    """Retorna (eh_duplicata, motivo)."""
    a = record_a
    b = record_b

    lat_a = a.get("latitude")
    lon_a = a.get("longitude")
    lat_b = b.get("latitude")
    lon_b = b.get("longitude")

    if lat_a is not None and lon_a is not None and lat_b is not None and lon_b is not None:
        dist = harvesine_meters(float(lat_a), float(lon_a), float(lat_b), float(lon_b))
        if dist <= 12:
            if a.get("road") and b.get("road"):
                if road_key(a["road"]) and road_key(b["road"]) and road_key(a["road"]) != road_key(b["road"]):
                    return False, "mesma coordenada, rodovias diferentes"
            if a.get("km") is not None and b.get("km") is not None:
                if abs(float(a["km"]) - float(b["km"])) > 0.75:
                    return False, "mesma coordenada, km não compatível"
            if a.get("sentido") and b.get("sentido"):
                sa = parse_sense_tokens(a["sentido"])
                sb = parse_sense_tokens(b["sentido"])
                if sa and sb and not (sa & sb):
                    return False, "sentidos incompatíveis"
            return True, "coordenada muito próxima"

    road_a = road_key(a.get("road"))
    road_b = road_key(b.get("road"))
    km_a = a.get("km")
    km_b = b.get("km")
    if road_a and road_b and road_a == road_b and km_a is not None and km_b is not None:
        if abs(float(km_a) - float(km_b)) <= 0.75:
            sa = parse_sense_tokens(a.get("sentido"))
            sb = parse_sense_tokens(b.get("sentido"))
            if sa and sb and not (sa & sb):
                return False, "mesmo trecho com sentidos conflitantes"
            return True, "mesma rodovia/quilômetro"

    if road_a and road_b and road_a == road_b and km_a is None and km_b is None:
        return True, "mesma rodovia sem quilômetro"

    return False, "sem combinação suficiente para deduplicar"


def merge_record(existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    merged = {**existing}
    merged["source_names"] = sorted(set(existing.get("source_names", []) + incoming.get("source_names", [])))
    merged["sources"] = sorted(set(existing.get("sources", []) + incoming.get("sources", [])))
    merged["source_rank"] = max(existing.get("source_rank", 0), incoming.get("source_rank", 0))
    merged["updated_at"] = max(existing.get("updated_at", ""), incoming.get("updated_at", ""))

    for key in [
        "latitude",
        "longitude",
        "road",
        "municipio",
        "tipo",
        "status",
        "sentido",
        "km",
        "site_id",
        "data_fonte",
        "inicio_operacao",
    ]:
        if incoming.get(key) not in (None, "") and (
            existing.get(key) in (None, "") or (
                str(existing.get(key)).strip() == "" and str(incoming.get(key)).strip() != ""
            )
        ):
            merged[key] = incoming.get(key)

    if incoming.get("velocidade") is not None and (
        existing.get("velocidade") is None or existing.get("velocidade") == ""
    ):
        merged["velocidade"] = incoming.get("velocidade")

    if incoming.get("velocidade") is not None and existing.get("velocidade") is not None:
        if int(existing["velocidade"]) == int(incoming["velocidade"]):
            merged["velocidade"] = existing["velocidade"]
        elif incoming.get("source_rank", 0) >= existing.get("source_rank", 0):
            merged["velocidade"] = incoming["velocidade"]

    if incoming.get("source") and incoming.get("source") not in merged.get("sources", []):
        merged["sources"].append(incoming.get("source"))

    return merged


def canonicalize_pardal_row(row: dict[str, Any]) -> dict[str, Any] | None:
    lat = as_float(row.get("lat"))
    lon = as_float(row.get("lng"))
    if lat is None or lon is None:
        return None
    kind = normalize_text(row.get("kind"))
    limit = parse_limit(row.get("limit_kmh"))
    activo = str(row.get("active") or "").strip()
    road = normalize_road(row.get("rodovia") or row.get("via") or row.get("road") or "")
    km = parse_km(row.get("km"))
    source_name = normalize_text(row.get("source")) or "Pardal"

    return {
        "latitude": lat,
        "longitude": lon,
        "road": road or "",
        "km": km,
        "municipio": normalize_text(row.get("municipio") or row.get("city") or ""),
        "tipo": kind or normalize_text(row.get("tipo")),
        "status": "ativo" if activo in ("1", "true", "True", "ativo") else "inativo",
        "sentido": normalize_text(row.get("direction_deg") or row.get("sentido") or ""),
        "velocidade": limit,
        "source": source_name,
        "source_names": [source_name],
        "sources": [source_name],
        "source_rank": 1,
        "site_id": normalize_text(row.get("id")) or f"pardal:{lat},{lon}",
        "data_fonte": parse_date(row.get("inicio_operacao") or row.get("data")),
        "inicio_operacao": parse_date(row.get("inicio_operacao") or row.get("data")),
        "updated_at": parse_date(row.get("updated_at") or row.get("data")),
        "origem": "pardal",
    }


def canonicalize_official_row(row: dict[str, Any], source_hint: str = "DER-SP") -> dict[str, Any] | None:
    lat = as_float(row.get("latitude"))
    lon = as_float(row.get("longitude"))
    if lat is None or lon is None:
        lat = as_float(row.get("lat"))
        lon = as_float(row.get("lng"))
    if lat is None or lon is None:
        return None

    source_name = normalize_text(row.get("fonte") or row.get("source") or source_hint) or source_hint
    road = normalize_road(row.get("rodovia") or row.get("road") or row.get("via") or row.get("rodovia_"))
    municipio = normalize_text(row.get("municipio") or row.get("city") or row.get("municipio_origem"))
    km = parse_km(row.get("km") or row.get("quilometro") or row.get("km_rodovia"))
    limite_l = parse_limit(row.get("limite_leves_kmh") or row.get("limite_kmh") or row.get("limite_geral_kmh"))
    limite_p = parse_limit(row.get("limite_pesados_kmh") or row.get("limite_pesados") or row.get("limite_pesado_kmh"))
    velocidade = limite_l if limite_l is not None else limite_p
    sentido = normalize_text(row.get("sentido_faixas") or row.get("sentido") or row.get("pista") or row.get("direcao"))
    tipo = normalize_text(row.get("tipo") or row.get("kind") or row.get("classificacao"))
    status = normalize_text(row.get("status") or row.get("situacao") or "Nao informado")
    data_fonte = parse_date(row.get("inicio_operacao") or row.get("data_atualizacao") or row.get("updated_at") or row.get("data"))

    return {
        "latitude": lat,
        "longitude": lon,
        "road": road,
        "km": km,
        "municipio": municipio,
        "tipo": tipo,
        "status": status.lower() if status else "nao informado",
        "sentido": standardize_sense(sentido),
        "velocidade": velocidade,
        "source": source_name,
        "source_names": [source_name],
        "sources": [source_name],
        "source_rank": 2,
        "site_id": normalize_text(row.get("id") or row.get("codigo") or row.get("identificador")),
        "data_fonte": data_fonte,
        "inicio_operacao": parse_date(row.get("inicio_operacao") or row.get("data_inicio_operacao")),
        "updated_at": parse_date(row.get("data_atualizacao") or row.get("updated_at")),
        "origem": "oficial",
    }


def read_csv_records(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        rows = []
        for raw in reader:
            rows.append(raw)
    return rows


def enrich_pardal(path: Path) -> list[dict[str, Any]]:
    itens: list[dict[str, Any]] = []
    for row in read_csv_records(path):
        rec = canonicalize_pardal_row(row)
        if rec is not None:
            itens.append(rec)
    return itens


def enrich_official(path: Path) -> list[dict[str, Any]]:
    itens: list[dict[str, Any]] = []
    for row in read_csv_records(path):
        rec = canonicalize_official_row(row)
        if rec is not None:
            itens.append(rec)
    return itens


def merge_sources(pardal_records: Iterable[dict[str, Any]], official_records: Iterable[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    merged: list[dict[str, Any]] = []
    for rec in pardal_records:
        merged.append(dict(rec))

    summary = {"added": 0, "updated": 0, "discarded": 0, "review": 0}

    for incoming in official_records:
        matches: list[tuple[int, dict[str, Any], str]] = []
        for idx, current in enumerate(merged):
            duplicated, motivo = duplicate_conflict(current, incoming)
            if duplicated:
                matches.append((idx, current, motivo))

        if not matches:
            merged.append(dict(incoming))
            summary["added"] += 1
            continue

        # Mais de um ponto parecido: não fundir automaticamente.
        if len(matches) > 1:
            merged.append(dict(incoming))
            summary["review"] += 1
            continue

        idx, existing, motivo = matches[0]
        existing_rank = existing.get("source_rank", 0)
        incoming_rank = incoming.get("source_rank", 0)

        if incoming_rank > existing_rank:
            merged[idx] = merge_record(existing, incoming)
            summary["updated"] += 1
        else:
            # Mesmo ponto, mas o registro atual já tem a fonte mais confiável.
            summary["discarded"] += 1

    return merged, summary


def build_geojson(records: Iterable[dict[str, Any]]) -> dict[str, Any]:
    features = []
    for rec in records:
        lon = rec.get("longitude")
        lat = rec.get("latitude")
        if lon is None or lat is None:
            continue
        props = {
            "codigo": rec.get("site_id") or "",
            "local": rec.get("municipio") or rec.get("road") or "Ponto cadastrado",
            "municipio": rec.get("municipio") or "",
            "rodovia": rec.get("road") or "",
            "quilometro": rec.get("km"),
            "velocidade": rec.get("velocidade"),
            "tipo": rec.get("tipo") or "",
            "sentido": rec.get("sentido") or "",
            "fonte": ", ".join(rec.get("sources", [])) or rec.get("source") or "Pardal",
            "origem": rec.get("origem") or "misturada",
            "status": rec.get("status") or "",
            "fontes": rec.get("source_names", rec.get("sources", [])),
            "data_fonte": rec.get("data_fonte") or rec.get("inicio_operacao") or "",
            "updated_at": rec.get("updated_at") or "",
        }
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [float(lon), float(lat)]},
            "properties": props,
        })

    return {"type": "FeatureCollection", "features": features}


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def merge_files(pardal_path: Path = DEFAULT_PARDAL, official_path: Path = DEFAULT_OFICIAL, out_geojson: Path = DEFAULT_OUT, report_path: Path = DEFAULT_REPORT) -> dict[str, Any]:
    pardal = enrich_pardal(pardal_path)
    oficiais = enrich_official(official_path)
    merged, summary = merge_sources(pardal, oficiais)
    geojson = build_geojson(merged)
    report = {
        "gerado_em_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "base_principal": "Pardal / Murkiriel",
        "fonte_oficial": str(official_path),
        "summary": summary,
        "total_final": len(merged),
        "registros_pardal": len(pardal),
        "registros_oficiais": len(oficiais),
        "nota": "Não foram inventados limites de velocidade ausentes. Registros conflitantes foram separados para revisão.",
    }
    write_json(report_path, report)
    write_json(out_geojson, geojson)
    return report


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pardal", type=Path, default=DEFAULT_PARDAL, help="CSV do Pardal SP")
    parser.add_argument("--oficial", type=Path, default=DEFAULT_OFICIAL, help="CSV oficial do DER-SP/ANTT")
    parser.add_argument("--geojson", type=Path, default=DEFAULT_OUT, help="Arquivo GeoJSON de saída")
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT, help="JSON com relatório de mesclagem")
    args = parser.parse_args()

    report = merge_files(args.pardal, args.oficial, args.geojson, args.report)
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
