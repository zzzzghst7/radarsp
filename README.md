# RadarSP v0.3 — Localização opcional e modo simulação

Protótipo com **MapLibre GL JS + MapLibre/OpenFreeMap**, base CET-SP e GPS por permissão. Sem custo de API de mapas no protótipo; o mapa de fundo e as bibliotecas são carregados pela internet.

## Novidades da v0.3

- Botão **Ativar GPS**: pede permissão *somente ao ser clicado* e acompanha a posição através da `Geolocation API` do navegador.
- Marcador azul, círculo de **precisão aproximada**, indicação de rumo (quando disponível) e horário da última atualização.
- Botões **Centralizar** (volta a seguir após mexer no mapa) e **Encerrar** (remove marcador e interrompe o acompanhamento).
- **Simular trajeto**: desloca um marcador amarelo por uma linha **fictícia** perto da Avenida Paulista; pausar, continuar e reiniciar. Não usa localização real.
- Os **879 registros** de radar da base inicial continuam no mapa com clustering, filtros e popups.
- Preservados `sincronizar_radares.py`, `gerar_geojson.py` e a rotina `.github/workflows/atualizar.yml`. A atualização diária é configurada quando o projeto estiver em um repositório GitHub seu.

**Ainda não implementado:** roteamento, map matching, reconhecimento de pista, status de *radar à frente / já passou*, alertas em tempo real, navegação em segundo plano. Esses itens requerem etapas posteriores e validação da confiabilidade.

## Executar no Windows (PC)

1. Extraia este ZIP.
2. Abra o CMD dentro da pasta `RadarSP` (onde está `index.html`).
3. Execute:

```bat
python -m http.server 8000
```

4. Entre em **http://localhost:8000**. O `localhost` é aceito como origem segura nos navegadores modernos, então o botão **Ativar GPS** pode funcionar se você conceder permissão. Um PC sem receptor GPS costuma retornar localização aproximada ou indisponível. **Simular trajeto** funciona sem permissão de localização.

A biblioteca MapLibre e o mapa-base exigem internet. **Não** abra `index.html` diretamente usando `file://`.

## Testar no celular

Para que o navegador solicite a localização real no celular, publique via **HTTPS**. É possível usar **GitHub Pages** (configuração abaixo). **http://IP-DO-PC:8000**, aberto pelo celular, geralmente **não** permite geolocalização por não ser contexto seguro. Não é necessário comprar ou instalar WSL.

No celular: abra o endereço HTTPS do seu projeto, toque **Ativar GPS**, aceite a permissão do navegador e veja o ponto azul. Ao arrastar o mapa, o acompanhamento automático para; toque **Centralizar** para retomar. **Encerrar** desliga o monitoramento. Mantenha a tela ativa durante os testes: navegadores móveis podem pausar GPS em segundo plano.

Se o navegador negar acesso, confira permissões do site e de localização do aparelho. O RadarSP não solicita localização automaticamente.

## Publicar no GitHub Pages e ativar atualização diária

1. Envie a pasta do projeto para um repositório GitHub seu.
2. Em **Settings → Actions → General → Workflow permissions**, conceda permissão de escrita ao workflow, quando permitido.
3. Em **Settings → Pages → Build and deployment**, selecione **GitHub Actions**.
4. Em **Settings → Secrets and variables → Actions → Variables**, crie `PUBLICAR_SITE=sim`.
5. Em **Actions → Atualizar base pública CET-SP**, use **Run workflow** para publicar a primeira versão e executar a sincronização. O cron incluído procura novos dados diariamente às **06h17, horário de São Paulo**. O GitHub pode atrasar execuções e aplicar limites.

Para atualizar manualmente a base dos radares:

```bat
python sincronizar_radares.py
```

## Testes

```bat
python -m unittest -v
```

Para testar somente os cálculos geográficos (opcional: Node.js):

```bat
node test_localizacao.mjs
```

A interface roda em navegador sem Node.js.

## Privacidade e limitações

A posição informada ao navegador não é armazenada pelo RadarSP e não é enviada ao seu próprio backend nesta versão. O mapa-base carrega arquivos de terceiros (OpenFreeMap/CDN), como num mapa web normal. O botão **Encerrar** chama `clearWatch`, remove os elementos de localização e interrompe a atualização no aplicativo. O próprio navegador/sistema controla permissões e disponibilidade do GPS.

**Não interaja com a interface enquanto dirige.** GPS e coordenadas da base pública têm incertezas; nenhum dado do mapa deve substituir a sinalização da rua. Registros com campo `DESATIVAÇÃO` vazio são **candidatos** a ativos, sem comprovação de funcionamento físico em tempo real.

## Fontes

- CET-SP: https://github.com/cetsp-dados/dados-fiscalizacao-eletronica
- MapLibre GL JS: https://github.com/maplibre/maplibre-gl-js
- OpenFreeMap: https://openfreemap.org
- Geolocation API: https://developer.mozilla.org/en-US/docs/Web/API/Geolocation/watchPosition
