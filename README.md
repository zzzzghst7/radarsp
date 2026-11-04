# DETECTOR INFALÍVEL DE RADARES ULTRON MEGA V5 — mapa restaurado

Esta edição recupera os marcadores dos **879 registros CET-SP sem data de desativação** da base inicial, mantendo a aparência escura da V5 e o GPS voluntário. Os pontos são informativos: **não há alertas de aproximação, evasão nem promessa de funcionamento em tempo real**. Números mudam com as sincronizações.

## Como atualizar no GitHub (sem instalar ferramentas)

1. **Antes de qualquer alteração, preserve sua versão atual** (GitHub mantém commits anteriores).
2. Extraia o ZIP completo. No repositório, substitua `index.html` e envie os scripts `sincronizar_radares.py`, `gerar_geojson.py`, `importar_bunda.py`, `consolidar_fontes.py` para a raiz. Envie também `data/radares_ativos.geojson`, `data/radares_consolidados.geojson`, `data/resumo.json`, `data/consolidado_status.json` para a pasta `data/`. Garanta que o HTML está na raiz.
3. No editor do GitHub, substitua o conteúdo de `.github/workflows/atualizar.yml` pelo do arquivo incluído no ZIP. É o **único workflow** de deploy. Isso evita conflitos com a publicação anterior.
4. Em Settings → Pages deixe Source = **GitHub Actions**. Em Actions, selecione **Ultron V5 - Atualizar mapa e fontes** → Run workflow. A publicação acontece no mesmo endereço do site.
5. Se a API de Challado estiver indisponível, o workflow mostra aviso e publica os dados CET já válidos. A integração será feita automaticamente em consultas futuras, se houver registros geolocalizados de SP, sem criar falsos dados.

**Para testar local:** `python -m http.server 8000`; depois `http://localhost:8000`.

**Testes específicos desta V5:** `python -m unittest -v test_frontend_v5 test_importar_bunda test_consolidar_fontes test_geojson test_sincronizador`. O workflow executa somente esta suíte para evitar que testes legados da v0.3/v0.4 falhem por esperarem o HTML antigo.

O mapa tem marcadores agrupados (clique para expandir), filtros de fonte, pesquisa por local, detalhes do cadastro e opção de GPS. O botão GPS usa apenas a localização do navegador; o projeto não calcula ou alerta sobre radares próximos durante deslocamento.

**Créditos:** CET-SP (https://github.com/cetsp-dados/dados-fiscalizacao-eletronica), Bunda de Urso / Challado (https://github.com/Challado/Bunda-de-Urso), MapLibre GL JS, OpenFreeMap e OpenStreetMap.

**Limitações:** A CET informa cadastros, que não confirmam funcionamento físico. Bunda de Urso pode ter dados incompletos ou coordenadas estimadas. Sempre prevalecem os limites oficiais sinalizados. API Bunda: https://servidor3.lucas.inf.br/openclaw/radar/api.pse.

**Atenção ao GitHub:** arquivos de versões antigas podem continuar no repositório, mas não serão publicados por este workflow. Verifique que o arquivo `.github/workflows/atualizar.yml` foi realmente substituído. O arquivo HTML deve ficar na raiz e o diretório `data` preservado.
