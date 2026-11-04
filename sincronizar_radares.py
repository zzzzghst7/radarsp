#!/usr/bin/env python3
"""Sincronização segura do CSV público CET-SP.

Executa UMA consulta por chamada. O agendamento fica com o GitHub Actions.
Python >= 3.10; sem dependências externas.
"""
from __future__ import annotations

import argparse
from collections import Counter
import csv
from datetime import date, datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import time
from urllib.request import Request, urlopen

ORIGEM = (
    "https://raw.githubusercontent.com/cetsp-dados/"
    "dados-fiscalizacao-eletronica/main/Base_Locais_Fiscalizados.csv"
)
COLUNAS = [
    "CÓDIGO LOCAL", "ATIVAÇÃO", "DESATIVAÇÃO", "NÚMERO DE SÉRIE",
    "DESCRIÇÃO DO LOCAL", "LATITUDE", "LONGITUDE", "FAIXAS",
    "TIPO", "METROLÓGICO", "VELOCIDADE", "FISCALIZA FAIXA AZUL",
    "CAPTURA", "REDUTOR", "ENQUADRAMENTO",
]
PASTA = Path(__file__).resolve().parent / "data"
TOTAL_MINIMO = 500


def baixar_origem() -> str:
    requisicao = Request(
        ORIGEM,
        headers={"User-Agent": "RadarSP-OpenData-ETL/0.1", "Accept": "text/csv"},
    )
    ultimo_erro: Exception | None = None
    for tentativa in range(3):
        try:
            with urlopen(requisicao, timeout=25) as resposta:
                return resposta.read().decode("utf-8-sig")
        except Exception as erro:
            ultimo_erro = erro
            if tentativa < 2:
                time.sleep(2 ** tentativa)
    raise RuntimeError("Falha no download; base antiga mantida.") from ultimo_erro


def interpretar(texto: str, validar: bool = True) -> list[dict[str, str]]:
    reader = csv.DictReader(io.StringIO(texto.lstrip("\ufeff")))
    if not reader.fieldnames:
        raise ValueError("CSV sem cabeçalho")
    headers = [h.strip().lstrip("\ufeff") for h in reader.fieldnames]
    faltam = set(COLUNAS) - set(headers)
    if faltam:
        raise ValueError(f"CSV mudou de formato; faltam colunas: {sorted(faltam)}")
    if None in reader.fieldnames:
        raise ValueError("Cabeçalho inválido")
    resultado = []
    for numero, registro in enumerate(reader, start=2):
        if None in registro:
            raise ValueError(f"Linha {numero} possui mais campos que o cabeçalho")
        item = {c: (registro.get(c) or "").strip() for c in COLUNAS}
        if not any(item.values()):
            continue
        if validar:
            if not item["CÓDIGO LOCAL"] or not item["ATIVAÇÃO"]:
                raise ValueError(f"Linha {numero}: código/ativação ausentes")
            try:
                data_ativacao = date.fromisoformat(item["ATIVAÇÃO"])
                data_desativacao = (
                    date.fromisoformat(item["DESATIVAÇÃO"])
                    if item["DESATIVAÇÃO"] else None
                )
                lat = float(item["LATITUDE"].replace(",", "."))
                lon = float(item["LONGITUDE"].replace(",", "."))
                if not (-25 <= lat <= -22 and -48 <= lon <= -45):
                    raise ValueError("coordenadas fora da área esperada")
                # A própria fonte possui datas invertidas em algumas linhas.
                # Não descartamos o registro: registramos anomalia no resumo.
            except (ValueError, TypeError) as erro:
                raise ValueError(f"Linha {numero}: dado inválido ({erro})") from erro
        resultado.append(item)
    if validar and len(resultado) < TOTAL_MINIMO:
        raise ValueError(
            f"A base retornou apenas {len(resultado)} registros; "
            "não será aceita automaticamente."
        )
    return sorted(
        resultado,
        key=lambda x: (
            x["CÓDIGO LOCAL"], x["ATIVAÇÃO"], x["NÚMERO DE SÉRIE"],
            x["DESCRIÇÃO DO LOCAL"], x["LATITUDE"], x["LONGITUDE"],
            x["DESATIVAÇÃO"],
        ),
    )


def csv_serializado(registros: list[dict[str, str]]) -> str:
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=COLUNAS, lineterminator="\n")
    writer.writeheader()
    writer.writerows(registros)
    return buffer.getvalue()


def hash_registros(registros: list[dict[str, str]]) -> str:
    return hashlib.sha256(csv_serializado(registros).encode("utf-8")).hexdigest()


def identidade(registro: dict[str, str]) -> str:
    """O código do local se repete. Ignoramos apenas DESATIVAÇÃO na identidade."""
    campos = [registro[coluna] for coluna in COLUNAS if coluna != "DESATIVAÇÃO"]
    return hashlib.sha256(
        json.dumps(campos, ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:20]


def resumir_alteracoes(
    anterior: list[dict[str, str]], atual: list[dict[str, str]], quando: str
) -> tuple[list[dict[str, str]], dict[str, int]]:
    anteriores_ativos = [r for r in anterior if not r["DESATIVAÇÃO"]]
    atuais_ativos = [r for r in atual if not r["DESATIVAÇÃO"]]

    ids_ant = Counter(identidade(r) for r in anteriores_ativos)
    ids_atu = Counter(identidade(r) for r in atuais_ativos)
    ids_des = Counter(identidade(r) for r in atual if r["DESATIVAÇÃO"])
    ids_hist = Counter(identidade(r) for r in anterior if r["DESATIVAÇÃO"])

    eventos = []
    contagem = Counter()

    def adicionar(tipo: str, r: dict[str, str]) -> None:
        contagem[tipo] += 1
        eventos.append({
            "verificado_em_utc": quando,
            "evento": tipo,
            "codigo_local": r["CÓDIGO LOCAL"],
            "ativacao": r["ATIVAÇÃO"],
            "desativacao": r["DESATIVAÇÃO"],
            "descricao_local": r["DESCRIÇÃO DO LOCAL"],
            "identidade": identidade(r),
        })

    novos = ids_atu - ids_ant
    for item in atuais_ativos:
        chave = identidade(item)
        if novos[chave] > 0:
            novos[chave] -= 1
            adicionar(
                "REATIVADO_OU_ALTERADO" if ids_hist[chave] else "NOVO_OU_ALTERADO",
                item,
            )

    removidos = ids_ant - ids_atu
    for item in anteriores_ativos:
        chave = identidade(item)
        if removidos[chave] > 0:
            removidos[chave] -= 1
            adicionar(
                "DESATIVADO" if ids_des[chave] else "REMOVIDO_OU_ALTERADO",
                item,
            )
    return eventos, dict(contagem)


def gravar_atomico(caminho: Path, conteudo: str) -> None:
    temporario = caminho.with_suffix(caminho.suffix + ".tmp")
    temporario.write_text(conteudo, encoding="utf-8", newline="")
    os.replace(temporario, caminho)


def sincronizar(texto: str, origem_entrada: str = "csv_remoto") -> None:
    PASTA.mkdir(parents=True, exist_ok=True)
    atuais = interpretar(texto, validar=True)
    caminho_completo = PASTA / "base_completa.csv"
    caminho_ativos = PASTA / "radares_ativos.csv"
    caminho_resumo = PASTA / "resumo.json"
    caminho_eventos = PASTA / "historico_eventos.csv"
    anteriores = (
        interpretar(caminho_completo.read_text(encoding="utf-8"), validar=False)
        if caminho_completo.exists() else []
    )

    hash_novo = hash_registros(atuais)
    if anteriores and hash_registros(anteriores) == hash_novo:
        print(f"SEM MUDANÇAS | Registros: {len(atuais)} | Nenhum arquivo regravado")
        from gerar_geojson import gerar
        gerar(entrada=caminho_ativos, saida=PASTA / "radares_ativos.geojson")
        return

    ativos = [r for r in atuais if not r["DESATIVAÇÃO"]]
    inativos = len(atuais) - len(ativos)
    datas_invertidas = sum(
        bool(r["DESATIVAÇÃO"]) and r["DESATIVAÇÃO"] < r["ATIVAÇÃO"]
        for r in atuais
    )
    if not ativos:
        raise ValueError("Nenhum registro ativo; atualização bloqueada")
    if anteriores:
        ativos_anteriores = sum(not r["DESATIVAÇÃO"] for r in anteriores)
        if len(atuais) < len(anteriores) * .70:
            raise ValueError("Queda >30% no tamanho da base; verificar manualmente")
        if len(ativos) < ativos_anteriores * .70:
            raise ValueError("Queda >30% nos ativos; verificar manualmente")

    agora = datetime.now(timezone.utc).isoformat(timespec="seconds")
    eventos, quantidades = (
        resumir_alteracoes(anteriores, atuais, agora) if anteriores else ([], {})
    )

    # Validação completa antes de substituir a versão anterior.
    texto_completo = csv_serializado(atuais)
    texto_ativos = csv_serializado(ativos)
    resumo = {
        "fonte": ORIGEM,
        "origem_entrada": origem_entrada,
        "processado_em_utc": agora,
        "verificado_em_utc": agora,
        "hash_base": hash_novo,
        "total_registros": len(atuais),
        "sem_desativacao": len(ativos),
        "com_desativacao": inativos,
        "anomalias_datas_invertidas": datas_invertidas,
        "alteracoes_desde_ultima_versao": quantidades,
        "criterio_ativo": "campo DESATIVAÇÃO vazio",
        "observacao": (
            "Registros baseados em dados públicos; status físico dos equipamentos "
            "não é confirmado em tempo real."
        ),
    }

    gravar_atomico(caminho_completo, texto_completo)
    gravar_atomico(caminho_ativos, texto_ativos)
    gravar_atomico(caminho_resumo, json.dumps(
        resumo, ensure_ascii=False, indent=2
    ) + "\n")

    if eventos:
        campos = list(eventos[0])
        buf = io.StringIO(newline="")
        escritor = csv.DictWriter(buf, fieldnames=campos, lineterminator="\n")
        if not caminho_eventos.exists():
            escritor.writeheader()
        escritor.writerows(eventos)
        with caminho_eventos.open("a", encoding="utf-8", newline="") as arquivo:
            arquivo.write(buf.getvalue())

    print(
        f"ATUALIZADO | Total: {len(atuais)} | "
        f"Sem desativação: {len(ativos)} | Com desativação: {inativos}"
    )
    print(f"Alterações: {quantidades}")
    if datas_invertidas:
        print(f"AVISO: {datas_invertidas} registros com datas invertidas na fonte")

    from gerar_geojson import gerar
    gerar(entrada=caminho_ativos, saida=PASTA / "radares_ativos.geojson")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--input", type=Path, help="CSV local para teste; padrão: baixar do GitHub"
    )
    args = parser.parse_args()
    texto = (
        args.input.read_text(encoding="utf-8-sig") if args.input else baixar_origem()
    )
    sincronizar(texto, origem_entrada="arquivo_local" if args.input else "csv_remoto")


if __name__ == "__main__":
    main()
