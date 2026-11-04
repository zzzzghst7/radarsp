# DETECTOR INFALÍVEL DE RADARES ULTRON MEGA V5

**Protótipo de painel estatístico de segurança viária (sem detector de fiscalização em rota).**

O nome é propositalmente humorístico: não há garantia de abrangência total. Esta V5 não identifica ou avisa sobre radares à frente ou ultrapassados. Ela mostra um mapa-base de São Paulo, a localização voluntária do usuário, estatísticas por município, alguns limites regulamentados informados na base e origem das informações.

## Fontes e créditos

- **Bunda de Urso / Challado**, API pública (`/api/v1/radares/busca?uf=SP`), dados sob CC BY 4.0, sujeitos à origem e às condições de cada fonte: https://github.com/Challado/Bunda-de-Urso
- **CET-SP**: https://github.com/cetsp-dados/dados-fiscalizacao-eletronica
- **MapLibre GL JS**: https://maplibre.org
- **OpenFreeMap**: https://openfreemap.org

Código escrito de forma independente; não clona o sistema de terceiros.

## O que muda em relação ao v0.4

A página passa a mostrar os registros de SP agregados por município. O sincronizador busca a fonte com paginação completa, valida o envelope JSON e salva **apenas contagens, categorias e metadados de cobertura**. Não salva nem publica as coordenadas, os IDs dos equipamentos ou os pontos individuais da API Bunda de Urso. Se a API falhar ou voltar vazia, preserva a última base válida. As informações do GPS permanecem no navegador e não são enviadas à API do projeto.

A amostra inicial tem CET=879 e Bunda=0; **zero significa ainda não sincronizado, não ausência de radares**. A API não pôde ser consultada em tempo real neste ambiente. Depois de configurar e executar o workflow, os dados da fonte externa serão populados caso ela esteja disponível.

## Atualizando o seu GitHub Pages sem terminal

1. No repositório `radarsp` abra `Code → Add file → Upload files`. Envie os arquivos `index.html`, `atualizar_fontes.py`, `test_v5_fontes.py` e `data/resumo_fontes_sp.json`. O `index.html` deve ficar na raiz e `data/` na pasta `data`.
2. Abra o workflow que você já tem em `.github/workflows/atualizar.yml`. Clique no lápis e **substitua todo o conteúdo** pelo conteúdo do arquivo com o mesmo caminho que está dentro deste ZIP. Confirme o commit. Para contornar o aviso “file is hidden”, crie/edite a pasta pelo editor web, não pelo seletor de uploads.
3. Em `Settings → Pages`, confira `Source: GitHub Actions`.
4. Abra `Actions → V5 - Resumo seguro de fiscalizacao SP → Run workflow` e execute na branch `main`.
5. Quando o workflow publicar o site, abra o mesmo link GitHub Pages. Às vezes é preciso recarregar sem cache para ver o HTML novo.

**Atenção:** o novo workflow substitui a publicação anterior. Não instale um segundo workflow de publicação simultâneo, pois ele pode sobrescrever o site. Seu antigo workflow `atualizar.yml` será substituído, portanto não precisa de `PUBLICAR_SITE=sim`.

A execução será agendada todos os dias por volta de 06h17 (São Paulo), com eventual atraso de execução do GitHub Actions.

## Testar no Windows

```bash
python -m http.server 8000
```

Abrir `http://localhost:8000`. Para validar os testes, execute `python -m unittest discover -p "test_v5_*.py" -v`. Para obter os dados agregados do Bunda de Urso, `python atualizar_fontes.py` (exige internet).

O navegador exige HTTPS (ou localhost) para autorizar o GPS. O mapa requer internet para os mapas-base. Não interaja com a tela enquanto dirige. O cadastro não substitui sinalização e regras de trânsito.
