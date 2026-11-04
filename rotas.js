// Ultron V5 — Planejador de rotas experimental (MapLibre + OSRM).
// Somente o clique explícito em "Calcular rota" consulta o OSRM.
// Não monitora a viagem, não rastreia fiscalização e não gera alertas de radar.
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
  let mode = null, origin = null, destination = null;
  let startPin = null, endPin = null;
  let controller = null, serial = 0;

  function announce(message) { status.textContent = message; }
  function pointString(point) { return point ? `${point[1].toFixed(5)}, ${point[0].toFixed(5)}` : 'Não escolhido'; }
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

  function updatePoint(which, coords) {
    if (!Array.isArray(coords) || coords.length !== 2 || !coords.every(Number.isFinite)) return;
    if (which === 'start') {
      origin = coords;
      if (!startPin) startPin = new maplibregl.Marker({color:'#18ad86'}).setLngLat(coords).addTo(map);
      else startPin.setLngLat(coords);
      startText.textContent = pointString(coords);
    } else {
      destination = coords;
      if (!endPin) endPin = new maplibregl.Marker({color:'#ee7654'}).setLngLat(coords).addTo(map);
      else endPin.setLngLat(coords);
      endText.textContent = pointString(coords);
    }
    enableButtons();
    summary.textContent = 'Origem e destino definidos. Calcule a rota para visualizar o trajeto.';
  }
  function selection(which) {
    mode = which;
    panel.hidden = false;
    toggle.setAttribute('aria-expanded','true');
    announce(`Toque no mapa para marcar ${which === 'start' ? 'a origem' : 'o destino'}.`);
    map.getCanvas().style.cursor = 'crosshair';
  }
  map.on('click', e => {
    if (!mode) return;
    updatePoint(mode,[e.lngLat.lng,e.lngLat.lat]);
    mode = null;
    map.getCanvas().style.cursor = '';
    announce('Ponto marcado. Escolha o outro ponto ou toque em Calcular rota.');
  });
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded',String(!panel.hidden));
    if(panel.hidden){mode=null;map.getCanvas().style.cursor='';}
  });
  close.addEventListener('click', () => {
    panel.hidden = true; mode = null; map.getCanvas().style.cursor='';
    toggle.setAttribute('aria-expanded','false');
  });
  $('route-start').addEventListener('click', () => selection('start'));
  $('route-end').addEventListener('click', () => selection('end'));
  $('route-gps').addEventListener('click', () => {
    if (!window.isSecureContext || !navigator.geolocation) {
      announce('Para usar o GPS, abra o site por HTTPS e autorize a localização.'); return;
    }
    announce('Solicitando posição atual...');
    navigator.geolocation.getCurrentPosition(position => {
      updatePoint('start',[position.coords.longitude,position.coords.latitude]);
      announce('Origem definida pelo GPS (precisão estimada: '+Math.round(position.coords.accuracy)+' m).');
    },err => announce('Não foi possível obter o GPS: '+err.message),
    {enableHighAccuracy:true,maximumAge:15000,timeout:16000});
  });
  $('route-clear').addEventListener('click', () => {
    serial++;
    controller?.abort(); controller=null;
    if (startPin) startPin.remove();
    if (endPin) endPin.remove();
    startPin=null; endPin=null; origin=null; destination=null; mode=null;
    startText.textContent='Não escolhida'; endText.textContent='Não escolhido';
    map.getCanvas().style.cursor='';
    if(map.getSource('ultron-route')) map.getSource('ultron-route').setData(empty);
    summary.textContent='Nenhuma rota calculada.';
    instructions.replaceChildren();
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
