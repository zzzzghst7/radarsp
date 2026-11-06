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
  // Navegação voluntária: sem gravação de histórico nem alerta relacionado à fiscalização.
  let activeRoute = null; // geometria e duração retornadas pelo OSRM
  let gpsWatchId = null, lastFix = null, etaTimer = null;
  let offRouteFixes = 0, arrivalFixes = 0, lastRerouteAt = 0;
  const TRACK_ACCURACY_LIMIT = 45; // metros; rejeita posições pouco confiáveis
  const OFF_ROUTE_METERS = 85;
  const REPLAN_COOLDOWN_MS = 60000;
  const trackStart = $('route-track-start');
  const trackStop = $('route-track-stop');
  const trackState = $('route-track-state');
  const etaFloating = $('route-eta-floating');
  const etaFloatingText = $('route-eta-floating-text');

  // Exibe exclusivamente direções e resumo inferior durante a navegação.
  const navShell=$('navigation-shell'), navEnd=$('nav-end');
  const navTurnSymbol=$('nav-turn-symbol'),navTurnDistance=$('nav-turn-distance'),navTurnText=$('nav-turn-text');
  const navTime=$('nav-time'),navArrival=$('nav-arrival'),navDistance=$('nav-distance');
  let navigationActive=false, navMarker=null, lastCameraAt=0;
  let cameraFollowing=true, lastNavPosition=null, recenterButton=null;

  function ensureRecenterButton(){
    if(recenterButton)return;
    recenterButton=document.createElement('button');
    recenterButton.type='button';
    recenterButton.textContent='Voltar à minha posição';
    recenterButton.setAttribute('aria-label','Voltar à minha posição');
    Object.assign(recenterButton.style,{
      position:'absolute', top:'102px', right:'14px', zIndex:'22',
      pointerEvents:'auto', border:'1px solid #8bb9d5', borderRadius:'12px',
      padding:'11px 14px', background:'#10283e', color:'#fff',
      font:'600 14px system-ui', boxShadow:'0 3px 14px rgba(0,0,0,.5)',
      cursor:'pointer'
    });
    recenterButton.hidden=true;
    recenterButton.addEventListener('click',()=>{
      cameraFollowing=true;
      recenterButton.hidden=true;
      if(lastNavPosition || origin || activeRoute?.line?.[0]){
        followNavCamera(lastNavPosition || origin || activeRoute.line[0], null, true);
      }
    });
    navShell.append(recenterButton);
  }

  map.on('movestart',event=>{
    if(!navigationActive || !event?.originalEvent) return;
    cameraFollowing=false;
    if(recenterButton) recenterButton.hidden=false;
  });
  function directionSymbol(step){
    const m=step?.maneuver||{};
    if(m.type==='arrive')return '⚑';
    if(m.type==='roundabout'||m.type==='rotary')return '⟳';
    if(m.modifier==='uturn')return '↶';
    if((m.modifier||'').includes('left'))return '↰';
    if((m.modifier||'').includes('right'))return '↱';
    return '↑';
  }
  function updateNavInstruction(position){
    if(!navigationActive||!activeRoute)return;
    const steps=activeRoute.steps||[];
    const along=Array.isArray(position)?projectOnRoute(position,activeRoute.line).along:0;
    const next=steps.find(({along:at})=>at>along+12)||steps[steps.length-1];
    if(!next){navTurnSymbol.textContent='↑';navTurnDistance.textContent='Siga a rota';navTurnText.textContent='Acompanhe a linha azul';return;}
    navTurnSymbol.textContent=directionSymbol(next.step);
    const dist=Math.max(0,next.along-along);
    navTurnDistance.textContent=next.step.maneuver?.type==='arrive'&&dist<35?'Chegando':distanceText(dist);
    navTurnText.textContent=directionText(next.step);
  }
  function updateNavHud(){
    if(!navigationActive||!activeRoute)return;
    const live=gpsWatchId!==null&&lastFix&&lastFix.accuracy<=TRACK_ACCURACY_LIMIT;
    const seconds=live?lastFix.remainingSeconds:activeRoute.duration;
    const meters=live?lastFix.remainingDistance:activeRoute.distance;
    navTime.textContent=durationText(seconds);
    navDistance.textContent=distanceText(meters);
    navArrival.textContent='Chegada '+arrivalText(seconds);
  }
  function placeNavMarker(position){
    if(!navigationActive||!position)return;
    lastNavPosition = position;
    if(!navMarker){
      const icon=document.createElement('div');icon.className='ultron-nav-marker';
      const arrow=document.createElement('span');arrow.textContent='▲';icon.append(arrow);
      navMarker=new maplibregl.Marker({element:icon,anchor:'center'}).setLngLat(position).addTo(map);
    }else navMarker.setLngLat(position);
  }
  function followNavCamera(position,heading=null,force=false){
    if(!navigationActive||!position||!cameraFollowing)return;
    const now=Date.now();if(!force&&now-lastCameraAt<900)return;
    lastCameraAt=now;
    const camera={center:position,zoom:16.6,pitch:32,padding:{top:135,bottom:175,left:0,right:0},duration:force?750:620};
    if(Number.isFinite(heading)&&heading>=0&&heading<=360)camera.bearing=heading;
    map.easeTo(camera);
  }
   function enterNavigation(){
    if(navigationActive||!activeRoute)return;
    navigationActive=true;
    cameraFollowing=true;
    ensureRecenterButton();
    recenterButton.hidden=true;
    document.body.classList.add('is-navigating');navShell.hidden=false;
    panel.hidden=true;toggle.setAttribute('aria-expanded','false');
    startPin?.getElement()?.style.setProperty('display','none');
    map.resize();
    const position=origin||activeRoute.line[0];
    placeNavMarker(position);updateNavInstruction(position);updateNavHud();
    requestAnimationFrame(()=>{map.resize();followNavCamera(position,null,true);});
    if(gpsWatchId===null && !trackStart.disabled)trackStart.click();
  }
   function exitNavigation(){
    if(!navigationActive)return;
    navigationActive=false;
    cameraFollowing=false;
    if(recenterButton) recenterButton.hidden=true;
    document.body.classList.remove('is-navigating');navShell.hidden=true;
    navMarker?.remove();navMarker=null;
    startPin?.getElement?.()?.style.removeProperty('display');
    $('route-clear').click();
    panel.hidden=false;toggle.setAttribute('aria-expanded','true');
    if($('status')?.textContent==='GPS ativo')$('stop')?.click();
    requestAnimationFrame(()=>{
      map.resize();map.easeTo({pitch:0,bearing:0,padding:{top:0,bottom:0,left:0,right:0},zoom:Math.min(map.getZoom(),14),duration:500});
    });
  }
  navEnd.addEventListener('click',exitNavigation);


  function routeMathDistance(a,b) {
    const lat=(a[1]+b[1])*Math.PI/360;
    const dx=(b[0]-a[0])*111320*Math.cos(lat);
    const dy=(b[1]-a[1])*110540;
    return Math.hypot(dx,dy);
  }
  // Ponto GPS projetado sobre os segmentos da linha azul (não identifica a pista física).
  function projectOnRoute(point, line) {
    let best={distance:Infinity,along:0};
    let running=0;
    for(let i=1;i<line.length;i++) {
      const a=line[i-1],b=line[i];
      const lat=point[1]*Math.PI/180;
      const kx=111320*Math.cos(lat), ky=110540;
      const vx=(b[0]-a[0])*kx,vy=(b[1]-a[1])*ky;
      const wx=(point[0]-a[0])*kx,wy=(point[1]-a[1])*ky;
      const len2=vx*vx+vy*vy;
      if(!len2)continue;
      const t=Math.max(0,Math.min(1,(wx*vx+wy*vy)/len2));
      const d=Math.hypot(wx-t*vx,wy-t*vy);
      const seglen=Math.sqrt(len2);
      if(d<best.distance)best={distance:d,along:running+t*seglen};
      running+=seglen;
    }
    return {...best,total:running};
  }
  function durationText(seconds) {
    const minutes=Math.max(1,Math.ceil(seconds/60));
    return minutes>=60?`${Math.floor(minutes/60)} h ${minutes%60} min`:`${minutes} min`;
  }
  function arrivalText(seconds){
    const when=new Date(Date.now()+Math.max(0,seconds)*1000);
    return when.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  }
  function summaryText(distance,seconds,live=false){
    return `${distanceText(distance)} restantes · ${durationText(seconds)} · chegada prevista ${arrivalText(seconds)}${live?' (GPS)':''} · sem trânsito em tempo real`;
  }
  function updateTrackingButtons(){
    trackStart.disabled=!activeRoute || gpsWatchId!==null;
    trackStop.disabled=gpsWatchId===null;
  }
  function stopTracking(message='Acompanhamento desligado.'){
    if(gpsWatchId!==null && navigator.geolocation) navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId=null;lastFix=null;offRouteFixes=0;arrivalFixes=0;
    window.dispatchEvent(new CustomEvent('ultron:gps-stop',{detail:{source:'route'}}));
    if(etaTimer!==null){clearInterval(etaTimer);etaTimer=null;}
    trackState.textContent=message;
    updateTrackingButtons();
  }
  function updateRouteSummary(){
    if(!activeRoute)return;
    const live=gpsWatchId!==null && lastFix && lastFix.accuracy<=TRACK_ACCURACY_LIMIT;
    const distance=live?lastFix.remainingDistance:activeRoute.distance;
    const seconds=live?lastFix.remainingSeconds:activeRoute.duration;
    summary.textContent=summaryText(distance,seconds,Boolean(live));
    etaFloating.hidden=false;
    etaFloatingText.textContent=`${arrivalText(seconds)} · ${durationText(seconds)} · ${distanceText(distance)}`;
    updateNavHud();
  }

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
    stopTracking();
    activeRoute=null;
    etaFloating.hidden=true;
    updateTrackingButtons();
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
  function showRoute(route, follow=false) {
    const coords=route.geometry?.coordinates;
    if(!Array.isArray(coords)||coords.length<2)throw new Error('Geometria não disponível');
    if(!coords.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)))
      throw new Error('Coordenadas inválidas na rota');
    const steps=route.legs?.flatMap(leg=>leg.steps||[])||[];
    const guidance=steps.filter(s=>s.maneuver?.type!=='depart'&&Array.isArray(s.maneuver?.location))
      .map(s=>({step:s,along:projectOnRoute(s.maneuver.location,coords).along}))
      .sort((a,b)=>a.along-b.along);
    activeRoute={line:coords,distance:route.distance,duration:route.duration,steps:guidance};
    lastFix=null;offRouteFixes=0;arrivalFixes=0;
    addLineSource();
    map.getSource('ultron-route').setData({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:coords}});
    if(!follow){
      const bounds=new maplibregl.LngLatBounds(coords[0],coords[0]);
      for(const p of coords)bounds.extend(p);
      map.fitBounds(bounds,{padding:{top:100,bottom:140,left:55,right:55},maxZoom:15,duration:700});
    }
    instructions.replaceChildren();
    for(const step of steps.slice(0,35)){
      const li=document.createElement('li');
      li.textContent=`${directionText(step)} · ${distanceText(step.distance||0)}`;
      instructions.appendChild(li);
    }
    updateRouteSummary();
    updateTrackingButtons();
    if(navigationActive)updateNavInstruction(origin);
  }

  async function requestRoute(start, reason='manual') {
    if(!start || !destination) return announce('Defina origem e destino primeiro.');
    controller?.abort();
    const current=++serial;
    const req=new AbortController();controller=req;
    const timeout=setTimeout(()=>req.abort(),17000);
    const co=p=>`${p[0].toFixed(6)},${p[1].toFixed(6)}`;
    const url=`https://router.project-osrm.org/route/v1/driving/${co(start)};${co(destination)}?overview=full&geometries=geojson&steps=true`;
    $('route-calc').disabled=true;
    announce(reason==='automatic'?'Desvio confirmado: recalculando trajeto...':'Consultando o serviço de rotas OSRM...');
    try{
      const response=await fetch(url,{signal:req.signal});
      if(!response.ok)throw new Error('HTTP '+response.status);
      const answer=await response.json();
      if(answer.code!=='Ok'||!answer.routes?.length)throw new Error(answer.message||'Rota não encontrada');
      const route=answer.routes[0];
      if(!Number.isFinite(route.distance)||!Number.isFinite(route.duration))throw new Error('Duração inválida');
      if(serial!==current)return;
      showRoute(route,reason==='automatic');
      if(reason==='automatic'){
        origin=start;
        startText.textContent='Sua localização atual (GPS)';
        startPin?.setLngLat(start);
        trackState.textContent='Rota corrigida. Acompanhamento ativo.';
        updateNavInstruction(start);
        followNavCamera(start,null,true);
        announce('Rota recalculada automaticamente; siga a sinalização da via.');
      }else {
        announce('Rota calculada. Navegação em tela cheia iniciada.');
        enterNavigation();
      }
    }catch(err){
      if(serial===current){
        announce(err.name==='AbortError'?'Consulta cancelada ou demorou demais.':'Falha ao calcular rota: '+err.message);
        if(reason==='automatic')trackState.textContent='Não foi possível recalcular. Mantendo última rota; nova tentativa após intervalo.';
      }
    }finally{
      clearTimeout(timeout);
      if(serial===current){controller=null;enableButtons();updateTrackingButtons();}
    }
  }
  $('route-calc').addEventListener('click',()=>requestRoute(origin));

  function receiveGps(position){
    if(gpsWatchId===null||!activeRoute||!destination)return;
    window.dispatchEvent(new CustomEvent('ultron:gps-fix',{detail:{source:'route',position}}));
    const c=position.coords;
    const accuracy=Number(c.accuracy), point=[Number(c.longitude),Number(c.latitude)];
    if(!point.every(Number.isFinite)||!Number.isFinite(accuracy)||accuracy>TRACK_ACCURACY_LIMIT){
      trackState.textContent=`GPS impreciso (${Number.isFinite(accuracy)?Math.round(accuracy):'?'} m). Aguardando posição melhor.`;
      offRouteFixes=0;
      return;
    }
    if(Date.now()-position.timestamp>25000){trackState.textContent='Posição antiga; aguardando GPS atualizado.';return;}
    if(navigationActive){placeNavMarker(point);followNavCamera(point,Number(c.heading));updateNavInstruction(point);}
    const nearEnd=routeMathDistance(point,destination);
    if(nearEnd<40){
      arrivalFixes++;
      if(arrivalFixes>=2){
        summary.textContent='Você chegou perto do destino.';
        stopTracking('Destino alcançado (estimado pelo GPS).');
        if(navigationActive){navTurnDistance.textContent='Chegada';navTurnText.textContent='Destino aproximado alcançado';navTime.textContent='0 min';navDistance.textContent='0 m';}
        announce('Chegada aproximada. Confira o endereço no local.');
        return;
      }
    }else arrivalFixes=0;
    const proj=projectOnRoute(point,activeRoute.line);
    if(proj.total<=0)return;
    const limit=Math.max(OFF_ROUTE_METERS,accuracy*2.5);
    if(proj.distance>limit){
      offRouteFixes++;
      trackState.textContent=`Possível saída da rota (${Math.round(proj.distance)} m). Conferindo GPS: ${Math.min(offRouteFixes,3)}/3.`;
      if(navigationActive && offRouteFixes>=2){navTurnDistance.textContent='Fora da rota';navTurnText.textContent='Conferindo trajeto pelo GPS…';}
      if(offRouteFixes>=3 && controller===null && Date.now()-lastRerouteAt>REPLAN_COOLDOWN_MS){
        offRouteFixes=0;lastRerouteAt=Date.now();
        requestRoute(point,'automatic');
      }
      return;
    }
    offRouteFixes=0;
    const fraction=Math.min(1,Math.max(0,proj.along/proj.total));
    lastFix={accuracy,remainingDistance:activeRoute.distance*(1-fraction),remainingSeconds:activeRoute.duration*(1-fraction)};
    if(navigationActive)updateNavInstruction(point);
    updateRouteSummary();
    trackState.textContent=`Acompanhando GPS · precisão ${Math.round(accuracy)} m · chegada estimada ${arrivalText(lastFix.remainingSeconds)}`;
  }
  trackStart.addEventListener('click',()=>{
    if(!activeRoute||!destination)return announce('Calcule a rota antes de acompanhar.');
    if(gpsWatchId!==null)return;
    if(!window.isSecureContext||!navigator.geolocation){announce('GPS requer HTTPS e permissão de localização.');return;}
    lastRerouteAt=0;offRouteFixes=0;
    trackState.textContent='Solicitando autorização para acompanhar o trajeto...';
    gpsWatchId=navigator.geolocation.watchPosition(receiveGps,err=>{
      trackState.textContent='GPS indisponível: '+err.message;
      if(err.code===1)stopTracking('Permissão de GPS negada. Acompanhamento encerrado.');
    },{enableHighAccuracy:true,maximumAge:1500,timeout:18000});
    etaTimer=setInterval(()=>{
      if(lastFix&&gpsWatchId!==null)updateRouteSummary();
    },30000);
    updateTrackingButtons();
    announce('Acompanhamento iniciado. Mantenha o navegador aberto; não use a tela enquanto dirige.');
  });
  trackStop.addEventListener('click',()=>{
    stopTracking();announce('Acompanhamento por GPS encerrado.');
  });
  // O botão global "Encerrar" também encerra a navegação para não surpreender o usuário.
  $('stop')?.addEventListener('click',()=>stopTracking('GPS encerrado.'));
  window.addEventListener('pagehide',()=>stopTracking('Acompanhamento encerrado.'));
  enableButtons();
  updateTrackingButtons();
}
