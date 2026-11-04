// Ultron V5 — Planejador de rotas com busca textual de endereço (MapLibre + Nominatim + OSRM).
// Nominatim: somente consultas iniciadas pelo usuário, no máximo 1 por segundo por navegador.
// Não faz autocomplete remoto, monitoramento de fiscalização ou alertas de radares.
export function iniciarRotas(map, maplibregl) {
  const $ = id => document.getElementById(id);
  const panel = $('route-panel');
  const toggle = $('route-toggle');
  const close = $('route-close');
  const status = $('route-status');
  const summary = $('route-summary');
  const instructions = $('route-steps');
  const startText = $('route-start-label');
  const endText = $('route-end-label');
  const empty = {type:'Feature', properties:{}, geometry:{type:'LineString', coordinates:[]}};
  let origin = null, destination = null;
  let startPin = null, endPin = null;
  let controller = null, serial = 0;
  let searchController = null, searchSerial = 0, lastGeocodeRequestAt = 0;
  const addressCache = new Map();

  function announce(message) { status.textContent = message; }
  function enableButtons() { $('route-calc').disabled = !(origin && destination); }
  function addLineSource() {
    if (map.getSource('ultron-route')) return;
    map.addSource('ultron-route', {type:'geojson', data:empty});
    const layer = {id:'ultron-route',type:'line',source:'ultron-route',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#278ff2','line-width':['interpolate',['linear'],['zoom'],6,4,15,8],'line-opacity':0.92}};
    const before = map.getLayer('radar-clusters') ? 'radar-clusters' : undefined;
    map.addLayer(layer, before);
  }
  if (map.loaded()) addLineSource();
  else map.once('load',addLineSource);

  function resetDrawnRoute() {
    serial++;
    controller?.abort(); controller = null;
    if (map.getSource('ultron-route')) map.getSource('ultron-route').setData(empty);
    summary.textContent = 'Nenhuma rota calculada.';
    instructions.replaceChildren();
  }
  function clearMatches(which) {
    const container = $(`route-${which}-results`);
    container.replaceChildren();
    container.hidden = true;
  }
  function invalidateAddress(which) {
    searchSerial++;
    searchController?.abort(); searchController = null;
    for (const field of ['start','end']) $(`route-${field}-search`).disabled = false;
    clearMatches(which);
    if (which === 'start') { origin = null; startText.textContent = 'Não escolhida'; startPin?.remove(); startPin = null; }
    else { destination = null; endText.textContent = 'Não escolhido'; endPin?.remove(); endPin = null; }
    resetDrawnRoute();
    enableButtons();
  }
  function updatePoint(which, coords, label, fromGps = false) {
    if (!Array.isArray(coords) || coords.length !== 2 || !coords.every(Number.isFinite)) return;
    resetDrawnRoute();
    const text = label || `${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}`;
    if (which === 'start') {
      origin = coords;
      if (!startPin) startPin = new maplibregl.Marker({color:'#18ad86'}).setLngLat(coords).addTo(map);
      else startPin.setLngLat(coords);
      startText.textContent = text;
    } else {
      destination = coords;
      if (!endPin) endPin = new maplibregl.Marker({color:'#ee7654'}).setLngLat(coords).addTo(map);
      else endPin.setLngLat(coords);
      endText.textContent = text;
    }
    if (fromGps) $('route-start-input').value = '';
    clearMatches(which);
    enableButtons();
    map.easeTo({center:coords, zoom:Math.max(map.getZoom(),13),duration:500});
    announce(`${which === 'start'?'Origem':'Destino'} confirmado. ${origin && destination?'Pronto para calcular a rota.':'Defina o outro endereço.'}`);
  }
  async function searchAddress(which) {
    const input = $(`route-${which}-input`);
    const q = input.value.trim();
    if (q.length < 3) return announce('Digite pelo menos 3 caracteres do endereço, com cidade ou bairro.');
    const current = ++searchSerial;
    searchController?.abort();
    for (const field of ['start','end']) $(`route-${field}-search`).disabled = false;
    const request = new AbortController(); searchController = request;
    clearMatches(which);
    const container = $(`route-${which}-results`);
    const button = $(`route-${which}-search`);
    button.disabled = true;
    announce(`Buscando ${which === 'start' ? 'origem' : 'destino'}: ${q}...`);
    try {
      const cacheKey = q.toLocaleLowerCase('pt-BR');
      let places = addressCache.get(cacheKey);
      if (!places) {
        // Uso público moderado: sem busca a cada tecla e, por navegador, <= 1 requisição/s.
        const delay = Math.max(0, 1100 - (Date.now() - lastGeocodeRequestAt));
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        if (current !== searchSerial || request.signal.aborted) return;
        const params = new URLSearchParams({q,format:'jsonv2',addressdetails:'1',limit:'5',countrycodes:'br',viewbox:'-53.5,-19.6,-44.0,-25.7','accept-language':'pt-BR'});
        lastGeocodeRequestAt = Date.now();
        const timeout = setTimeout(() => request.abort(), 14000);
        let response;
        try { response = await fetch('https://nominatim.openstreetmap.org/search?' + params.toString(), {signal:request.signal}); }
        finally {clearTimeout(timeout);}
        if (!response.ok) throw new Error(response.status === 429 ? 'Serviço de endereços ocupado. Tente novamente em alguns segundos.' : `Serviço de endereços indisponível (HTTP ${response.status}).`);
        places = await response.json();
        if (!Array.isArray(places)) throw new Error('Resposta inesperada do serviço de endereços.');
        addressCache.set(cacheKey, places);
      }
      if (current !== searchSerial) return;
      const valid = places.filter(x => Number.isFinite(Number(x.lon)) && Number.isFinite(Number(x.lat)) && x.display_name);
      if (!valid.length) {
        const msg = document.createElement('div'); msg.className = 'route-empty';
        msg.textContent = 'Nenhum resultado. Tente incluir número, bairro, cidade e SP.';
        container.append(msg); container.hidden = false;
        announce('Endereço não encontrado.'); return;
      }
      for (const place of valid) {
        const option = document.createElement('button'); option.type = 'button';
        option.textContent = place.display_name;
        option.addEventListener('click', () => {
          // Seleção explícita evita calcular rota para endereço ambíguo.
          updatePoint(which, [Number(place.lon), Number(place.lat)], place.display_name);
        });
        container.append(option);
      }
      container.hidden = false;
      announce(`Encontrados ${valid.length} resultados. Toque no endereço correto para confirmar.`);
    } catch (err) {
      if (current !== searchSerial) return;
      announce(err.name === 'AbortError' ? 'Busca cancelada ou demorou demais.' : `Erro na busca: ${err.message}`);
    } finally {
      if (current === searchSerial) { button.disabled = false; searchController = null; }
    }
  }

  for (const which of ['start','end']) {
    $(`route-${which}-search`).addEventListener('click', () => searchAddress(which));
    $(`route-${which}-input`).addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); searchAddress(which); }
    });
    $(`route-${which}-input`).addEventListener('input', () => {
      invalidateAddress(which);
    });
  }
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded',String(!panel.hidden));
  });
  close.addEventListener('click', () => {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded','false');
  });
  $('route-gps').addEventListener('click', () => {
    if (!window.isSecureContext || !navigator.geolocation) {
      announce('Para usar o GPS, abra o site por HTTPS e autorize a localização.'); return;
    }
    announce('Solicitando posição atual...');
    navigator.geolocation.getCurrentPosition(position => {
      invalidateAddress('start');
      updatePoint('start',[position.coords.longitude,position.coords.latitude], 'Minha localização (GPS)',true);
      announce('Origem definida pelo GPS (precisão estimada: '+Math.round(position.coords.accuracy)+' m).');
    },err => announce('Não foi possível obter o GPS: '+err.message),
    {enableHighAccuracy:true,maximumAge:15000,timeout:16000});
  });
  $('route-clear').addEventListener('click', () => {
    searchSerial++;
    searchController?.abort(); searchController = null;
    resetDrawnRoute();
    startPin?.remove(); endPin?.remove();
    startPin=null; endPin=null; origin=null; destination=null;
    for (const which of ['start','end']) { $(`route-${which}-input`).value = ''; clearMatches(which); $(`route-${which}-search`).disabled=false; }
    startText.textContent='Não escolhida'; endText.textContent='Não escolhido';
    announce('Rota limpa.'); enableButtons();
  });
  function distanceText(m) {return m >= 1000 ? (m/1000).toFixed(1).replace('.',',')+' km' : Math.round(m)+' m';}
  const direction = {left:'à esquerda',right:'à direita','slight left':'suavemente à esquerda','slight right':'suavemente à direita','sharp left':'acentuadamente à esquerda','sharp right':'acentuadamente à direita',straight:'em frente',uturn:'em retorno'};
  function directionText(step) {
    const move = step.maneuver || {};
    const road = step.name ? ` na ${step.name}` : '';
    if (move.type === 'depart') return `Saia${road}`;
    if (move.type === 'arrive') return 'Chegada ao destino';
    if (move.type === 'roundabout' || move.type === 'rotary') return `Entre na rotatória${road}`;
    if (move.type === 'merge') return `Entre na via${road}`;
    if (move.type === 'on ramp') return `Acesse a entrada${road}`;
    if (move.type === 'off ramp') return `Pegue a saída${road}`;
    if (move.type === 'turn' || move.type === 'end of road' || move.type === 'fork') return `Vire ${direction[move.modifier] || 'conforme a via'}${road}`;
    return `Continue${road}`;
  }
  $('route-calc').addEventListener('click', async () => {
    if (!origin || !destination) return announce('Defina origem e destino primeiro.');
    if (controller) controller.abort();
    const current = ++serial;
    const req = new AbortController(); controller = req;
    const timeout = setTimeout(()=>req.abort(),17000);
    const co = p => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
    const url = `https://router.project-osrm.org/route/v1/driving/${co(origin)};${co(destination)}?overview=full&geometries=geojson&steps=true`;
    $('route-calc').disabled = true;
    announce('Consultando o serviço de rotas OSRM...');
    try {
      const response = await fetch(url,{signal:req.signal});
      if(!response.ok) throw new Error('HTTP '+response.status);
      const answer = await response.json();
      if(answer.code!=='Ok' || !answer.routes?.length) throw new Error(answer.message || 'Rota não encontrada');
      const route = answer.routes[0];
      const coords = route.geometry?.coordinates;
      if(!Array.isArray(coords) || coords.length < 2) throw new Error('Geometria não disponível');
      if (serial !== current) return;
      addLineSource();
      map.getSource('ultron-route').setData({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:coords}});
      const bounds = new maplibregl.LngLatBounds(coords[0],coords[0]);
      for(const p of coords) bounds.extend(p);
      map.fitBounds(bounds,{padding:{top:100,bottom:140,left:55,right:55},maxZoom:15,duration:700});
      const minutes = Math.max(1,Math.round(route.duration/60));
      const eta = minutes>=60 ? `${Math.floor(minutes/60)} h ${minutes%60} min` : `${minutes} min`;
      summary.textContent=`${distanceText(route.distance)} · estimativa ${eta} (sem trânsito em tempo real)`;
      instructions.replaceChildren();
      const steps = route.legs?.flatMap(leg=>leg.steps||[]) || [];
      for(const step of steps.slice(0,35)) {
        const li=document.createElement('li');
        li.textContent=`${directionText(step)} · ${distanceText(step.distance||0)}`;
        instructions.appendChild(li);
      }
      announce('Rota calculada. Confira o trajeto antes de sair.');
    } catch(err) {
      if(serial===current) announce(err.name==='AbortError'?'Consulta cancelada ou demorou demais. Tente novamente.':'Não foi possível calcular: '+err.message);
    } finally {
      clearTimeout(timeout);
      if(serial===current){controller=null;enableButtons();}
    }
  });
  enableButtons();
}
