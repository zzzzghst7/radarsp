// Ultron V5 — Rotas com busca por nomes de lugares e endereços (MapLibre + Photon + OSRM).
// Photon: autocompletar moderado; para produção em escala, usar provedor com SLA.
// Alertas locais de radares cadastrados; não consulta posição do usuário na API de dados.
export function iniciarRotas(map, maplibregl) {
  const radarAlerts = iniciarAlertasRadares();
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
  const searchDelay = {start:null,end:null};
  const AUTOCOMPLETE_DELAY_MS = 750;
  const MIN_QUERY_LENGTH = 3;
  // Navegação voluntária com avisos locais, sem gravação de histórico.
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
  // Modo temporário e isolado: nenhum watchPosition é iniciado na simulação.
  let simulationRunning=false, simulationClock=null, simulationTimer=null, simulationTickAt=0;
  const simChoice=document.createElement('input');simChoice.type='checkbox';simChoice.id='radar-simulation';
  const simLabel=document.createElement('label');simLabel.className='sim-choice';
  simLabel.append(simChoice,document.createTextNode(' Testar rota em simulação (sem GPS real)'));
  const simHint=document.createElement('p');simHint.textContent='Para testar de casa, marque esta opção e escolha origem e destino por endereço. Os radares continuam sendo os da base publicada.';
  panel.insertBefore(simLabel,$('route-calc').parentElement);simLabel.after(simHint);
  const simStyle=document.createElement('style');simStyle.textContent=`
    .sim-choice{display:flex;gap:8px;align-items:center;padding:12px;background:#493714;border:1px solid #d8aa48;border-radius:10px;font:600 13px system-ui;color:#fff0bd}
    .sim-choice input{width:20px;height:20px;flex:none}
    #simulation-controls[hidden]{display:none!important}
    #simulation-controls{position:absolute;z-index:24;left:12px;right:12px;top:calc(163px + env(safe-area-inset-top));max-width:420px;margin:auto;border:1px solid #efbf5b;border-radius:14px;background:#392b0ff5;color:#fff1c4;padding:10px;pointer-events:auto;font:12px system-ui;box-shadow:0 5px 20px #0008}
    #simulation-controls strong{display:block;font-size:13px;letter-spacing:.04em}
    #simulation-controls .sim-progress{display:block;margin:5px 0;font-variant-numeric:tabular-nums}
    #simulation-controls .sim-buttons{display:flex;flex-wrap:wrap;gap:6px}
    #simulation-controls button,#simulation-controls select{min-height:38px;background:#634917;border:1px solid #b28f46;border-radius:7px;color:#fff;padding:6px 8px;font:600 12px system-ui}
    #simulation-controls button:disabled{opacity:.5}
    @media(max-height:500px){#simulation-controls{top:8px;left:8px;right:auto;width:230px;padding:8px}body.is-simulating .nav-top{left:auto;right:8px;width:calc(100% - 265px);min-height:70px;padding:10px}body.is-simulating #radar-alert{bottom:120px}}
  `;document.head.append(simStyle);
  const simPanel=document.createElement('section');simPanel.id='simulation-controls';simPanel.hidden=true;simPanel.setAttribute('aria-label','Controles de simulação');
  const simTitle=document.createElement('strong');simTitle.textContent='SIMULAÇÃO · POSIÇÃO FICTÍCIA';
  const simProgress=document.createElement('span');simProgress.className='sim-progress';
  const simButtons=document.createElement('div');simButtons.className='sim-buttons';
  function simButton(text,action){const b=document.createElement('button');b.type='button';b.textContent=text;b.addEventListener('click',action);simButtons.append(b);return b;}
  const simPause=simButton('Pausar',()=>{if(simulationClock){simulationClock.paused=!simulationClock.paused;simulationTickAt=Date.now();simPause.textContent=simulationClock.paused?'Continuar':'Pausar';}});
  const simAdvance=simButton('+500 m',()=>{if(simulationClock){simulationClock.seek(simulationClock.along+500);radarAlerts.resetPosition();lastFix=null;offRouteFixes=0;arrivalFixes=0;emitSimulation();}});
  simButton('Reiniciar',()=>{if(activeRoute)startSimulation();});
  const simRate=document.createElement('select');simRate.setAttribute('aria-label','Velocidade de reprodução');
  for(const rate of [1,2,3]){const o=document.createElement('option');o.value=String(rate);o.textContent=rate+'×';simRate.append(o);}simButtons.append(simRate);
  simRate.addEventListener('change',()=>{if(simulationClock)simulationClock.rate=Number(simRate.value);});
  const simSpeed=document.createElement('select');simSpeed.setAttribute('aria-label','Velocidade simulada em quilômetros por hora');
  for(const speed of [30,50,60,80,100]){const o=document.createElement('option');o.value=String(speed);o.textContent=speed+' km/h';o.selected=speed===60;simSpeed.append(o);}simButtons.append(simSpeed);
  simSpeed.addEventListener('change',()=>{if(simulationClock)simulationClock.kmh=Number(simSpeed.value);});
  simPanel.append(simTitle,simProgress,simButtons);navShell.append(simPanel);
  function emitSimulation(){
    if(!simulationRunning||!simulationClock)return;
    const position=simulationClock.position(Date.now());
    simProgress.textContent=`${Math.round(simulationClock.along)} / ${Math.round(simulationClock.total)} m · ${simulationClock.kmh} km/h · reprodução ${simulationClock.rate}×`;
    receiveGps(position);
    if(simulationClock&&simulationClock.along>=simulationClock.total){stopTracking('Simulação concluída.');simProgress.textContent='Fim da simulação. Reinicie ou encerre a navegação.';}
  }
  function startSimulation(){
    if(!activeRoute)return;
    // Desliga também eventual GPS ativado na tela inicial, antes de emitir posições fictícias.
    $('stop')?.click();
    stopTracking();
    simulationClock=new RoutePlayback(activeRoute.line,{kmh:Number(simSpeed.value)||60,rate:Number(simRate.value)||1});
    simulationRunning=true;simulationTickAt=Date.now();lastCameraAt=0;
    document.body.classList.add('is-simulating');simPanel.hidden=false;simPause.disabled=false;simAdvance.disabled=false;simPause.textContent='Pausar';
    radarAlerts.resetPosition();radarAlerts.start();
    emitSimulation();
    simulationTimer=setInterval(()=>{
      if(!simulationRunning)return;
      const now=Date.now();simulationClock.tick(now-simulationTickAt);simulationTickAt=now;emitSimulation();
    },1000);
    updateTrackingButtons();announce('Simulação ativa. Nenhuma posição GPS real é usada.');
  }

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
    const live=(gpsWatchId!==null||simulationRunning)&&lastFix&&lastFix.accuracy<=TRACK_ACCURACY_LIMIT;
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
    simPanel.hidden=true;document.body.classList.remove('is-simulating');
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
    trackStart.disabled=!activeRoute || gpsWatchId!==null || simulationRunning;
    trackStop.disabled=gpsWatchId===null && !simulationRunning;
  }
  function stopTracking(message='Acompanhamento desligado.'){
    if(simulationTimer!==null)clearInterval(simulationTimer);
    simulationTimer=null;simulationRunning=false;simulationClock=null;
    simPause.disabled=true;simAdvance.disabled=true;
    if(!simPanel.hidden)simProgress.textContent='Simulação encerrada. Reinicie ou encerre a navegação.';
    radarAlerts.stop();
    if(gpsWatchId!==null && navigator.geolocation) navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId=null;lastFix=null;offRouteFixes=0;arrivalFixes=0;
    window.dispatchEvent(new CustomEvent('ultron:gps-stop',{detail:{source:'route'}}));
    if(etaTimer!==null){clearInterval(etaTimer);etaTimer=null;}
    trackState.textContent=message;
    updateTrackingButtons();
  }
  function updateRouteSummary(){
    if(!activeRoute)return;
    const live=(gpsWatchId!==null||simulationRunning) && lastFix && lastFix.accuracy<=TRACK_ACCURACY_LIMIT;
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
    simPanel.hidden=true;document.body.classList.remove('is-simulating');
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
  // Photon encontra estabelecimentos, instituições, bairros, ruas e endereços.
  // Usa apenas conteúdo textual da API (textContent), evitando interpretar HTML de resultados.
  function labelPlace(feature) {
    const p = feature.properties || {};
    const street = [p.street,p.housenumber].filter(Boolean).join(', ');
    const name = String(p.name || street || p.city || p.district || 'Local').trim();
    const region = [street !== name ? street : null, p.district, p.city, p.state]
      .filter(Boolean).join(' · ');
    return {name,region,label: [name,region].filter(Boolean).join(' — ')};
  }
  function showSearchMessage(container,message) {
    const el=document.createElement('div'); el.className='route-empty';
    el.textContent=message; container.replaceChildren(el); container.hidden=false;
  }
  function addSearchCredit(container) {
    const footer=document.createElement('small');
    footer.style.cssText='display:block;padding:7px 10px;font-size:11px;opacity:.75';
    const link=document.createElement('a');
    link.href='https://www.openstreetmap.org/copyright';
    link.target='_blank'; link.rel='noopener noreferrer';
    link.textContent='© colaboradores do OpenStreetMap';
    footer.append('Resultados: Photon · ',link); container.append(footer);
  }
  async function searchAddress(which,automatic=false) {
    clearTimeout(searchDelay[which]); searchDelay[which]=null;
    const input=$(`route-${which}-input`),q=input.value.trim();
    if (q.length<MIN_QUERY_LENGTH) {
      if(!automatic)announce('Digite pelo menos 3 caracteres de um lugar ou endereço.');
      return;
    }
    const current=++searchSerial;
    searchController?.abort();
    const request=new AbortController(); searchController=request;
    const container=$(`route-${which}-results`),button=$(`route-${which}-search`);
    clearMatches(which); button.disabled=true;
    showSearchMessage(container,'Buscando lugares...');
    try {
      // Prioriza a região visualizada sem enviar a localização GPS com precisão exata.
      const c=which==='end' && origin ? {lng:origin[0],lat:origin[1]} : map.getCenter();
      const lat=Number(Number(c.lat).toFixed(2));
      const lon=Number(Number(c.lng).toFixed(2));
      const cacheKey=[q.toLocaleLowerCase('pt-BR'),lat,lon].join('|');
      let matches=addressCache.get(cacheKey);
      if (!matches) {
        // API pública: não mais que uma busca remota a cada 1,1 segundo por aba.
        const delay=Math.max(0,1100-(Date.now()-lastGeocodeRequestAt));
        if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
        if(current!==searchSerial || request.signal.aborted)return;
        const params=new URLSearchParams({q,limit:'8',lang:'pt',countrycode:'BR',lat:String(lat),lon:String(lon)});
        lastGeocodeRequestAt=Date.now();
        const timeout=setTimeout(()=>request.abort(),14000);
        let response;
        try {
          response=await fetch('https://photon.komoot.io/api/?'+params.toString(),{
            signal:request.signal,headers:{Accept:'application/json'}
          });
        } finally {clearTimeout(timeout);}
        if(!response.ok)throw new Error(response.status===429 ?
          'Muitas buscas. Tente novamente em instantes.' : `Serviço de lugares indisponível (HTTP ${response.status}).`);
        const data=await response.json();
        if(!Array.isArray(data.features))throw new Error('Resposta inesperada do serviço de lugares.');
        matches=data.features;
        if(addressCache.size>=80)addressCache.delete(addressCache.keys().next().value);
        addressCache.set(cacheKey,matches);
      }
      if(current!==searchSerial || request.signal.aborted)return;
      const valid=matches.filter(f=>f?.geometry?.type==='Point' &&
        Array.isArray(f.geometry.coordinates) && f.geometry.coordinates.length>=2 &&
        f.geometry.coordinates.slice(0,2).every(Number.isFinite) &&
        Math.abs(f.geometry.coordinates[0])<=180 && Math.abs(f.geometry.coordinates[1])<=90);
      container.replaceChildren();
      if(!valid.length){
        showSearchMessage(container,'Nenhum lugar encontrado. Tente o nome antigo, bairro ou cidade; nem todos os estabelecimentos estão no OpenStreetMap.');
        announce('Nenhum lugar encontrado.'); return;
      }
      for(const feature of valid){
        const place=labelPlace(feature),[lng,lat]=feature.geometry.coordinates;
        const option=document.createElement('button');option.type='button';
        option.className='route-place-option';
        option.style.cssText='display:block;width:100%;text-align:left;white-space:normal;padding:10px 12px;cursor:pointer';
        const title=document.createElement('strong');title.textContent=place.name;
        const subtitle=document.createElement('span');subtitle.textContent=place.region;
        subtitle.style.cssText='display:block;font-size:12px;font-weight:400;opacity:.75;margin-top:4px';
        option.append(title,subtitle);
        option.addEventListener('click',()=>{
          input.value=place.name;
          updatePoint(which,[lng,lat],place.label);
        });
        container.append(option);
      }
      addSearchCredit(container);container.hidden=false;
      if(!automatic)announce(`${valid.length} lugares encontrados. Escolha o correto para confirmar.`);
    }catch(err){
      if(current!==searchSerial)return;
      if(err.name!=='AbortError'){
        showSearchMessage(container,'Não foi possível consultar lugares agora. Tente novamente.');
        announce('Falha na busca: '+err.message);
      }
    }finally{
      if(current===searchSerial){button.disabled=false;searchController=null;}
    }
  }

  for(const which of ['start','end']){
    const input=$(`route-${which}-input`);
    input.placeholder=which==='end'?'Destino: mercado, faculdade, parque, endereço...':'Origem: lugar, endereço ou GPS';
    input.setAttribute('autocomplete','off');
    $(`route-${which}-search`).addEventListener('click',()=>searchAddress(which));
    input.addEventListener('keydown',ev=>{
      if(ev.key==='Enter'){ev.preventDefault();searchAddress(which);}
    });
    input.addEventListener('input',()=>{
      clearTimeout(searchDelay[which]);
      invalidateAddress(which);
      if(input.value.trim().length>=MIN_QUERY_LENGTH){
        searchDelay[which]=setTimeout(()=>searchAddress(which,true),AUTOCOMPLETE_DELAY_MS);
      }
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
    for(const which of ['start','end'])clearTimeout(searchDelay[which]);
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
    radarAlerts.setRoute(coords);
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
    if((gpsWatchId===null&&!simulationRunning)||!activeRoute||!destination)return;
    radarAlerts.update(position);
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
    if(simulationRunning)return;
    if(simChoice.checked){startSimulation();return;}
    if(gpsWatchId!==null)return;
    if(!window.isSecureContext||!navigator.geolocation){announce('GPS requer HTTPS e permissão de localização.');return;}
    lastRerouteAt=0;offRouteFixes=0;
    radarAlerts.start();
    trackState.textContent='Solicitando autorização para acompanhar o trajeto...';
    gpsWatchId=navigator.geolocation.watchPosition(receiveGps,err=>{
      radarAlerts.unavailable();
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

// Motor independente da câmera. Distâncias em metros ao longo da rota OSRM.
const RADAR_CORRIDOR=22, GPS_CORRIDOR=35, RADAR_LOOKAHEAD=1000;
const validCoord=p=>Array.isArray(p)&&p.length>=2&&p.slice(0,2).every(Number.isFinite)&&Math.abs(p[0])<=180&&Math.abs(p[1])<=90;
const angleDifference=(a,b)=>Math.abs(((a-b+540)%360)-180);
function localVector(a,b){return [(b[0]-a[0])*111320*Math.cos((a[1]+b[1])*Math.PI/360),(b[1]-a[1])*110540];}
function pointDistance(a,b){return Math.hypot(...localVector(a,b));}
function compassHeading(a,b){const [x,y]=localVector(a,b);return (Math.atan2(x,y)*180/Math.PI+360)%360;}
function radarHeading(p){
  const raw=p.sentido_graus ?? p.azimute;
  if(typeof raw==='number'&&Number.isFinite(raw)&&raw>=0&&raw<360)return raw;
  const names={norte:0,nordeste:45,leste:90,sudeste:135,sul:180,sudoeste:225,oeste:270,noroeste:315};
  return names[String(p.sentido||'').trim().toLowerCase()] ?? null;
}
export function limiteRadar(value){
  const match=typeof value==='number'?String(value).match(/^\d+$/):String(value||'').trim().match(/^(\d+)\s*(?:km\/?h)?$/i);
  const n=match?Number(match[1]||match[0]):NaN;
  return Number.isFinite(n)&&n>=10&&n<=140?n:null;
}
function segmentsOf(line){
  let running=0;
  return line.slice(1).map((b,i)=>{
    const a=line[i], length=pointDistance(a,b);
    const s={a,b,length,along:running,heading:compassHeading(a,b)};running+=length;return s;
  }).filter(s=>s.length>.01);
}
function projectSegment(point,s){
  const [vx,vy]=localVector(s.a,s.b),[wx,wy]=localVector(s.a,point);
  const t=Math.max(0,Math.min(1,(wx*vx+wy*vy)/(vx*vx+vy*vy)));
  return {distance:Math.hypot(wx-t*vx,wy-t*vy),along:s.along+t*s.length,heading:s.heading};
}
export class RadarRouteEngine {
  constructor(features=[]){this.features=features;this.segments=[];this.candidates=[];this.previous=null;this.lastTarget=null;}
  setFeatures(features){this.features=features;this.indexRadars();}
  setRoute(line){
    this.segments=Array.isArray(line)&&line.length>1&&line.every(validCoord)?segmentsOf(line):[];
    this.previous=null;this.lastTarget=null;this.indexRadars();
  }
  indexRadars(){
    this.candidates=[];
    if(!this.segments.length)return;
    for(const f of this.features){
      const coord=f?.geometry?.coordinates,p=f?.properties||{};
      if(f?.geometry?.type!=='Point'||!validCoord(coord))continue;
      if(p.desativacao||p.removido_em||/^(inativo|desativado|removido|suspenso)$/i.test(p.status_operacional||''))continue;
      const uncertainty=p.precisao_metros;
      if(typeof uncertainty==='number'&&uncertainty>RADAR_CORRIDOR)continue;
      if(/estimad|candidat|aproximad/i.test(p.qualidade_gps||''))continue;
      const direction=radarHeading(p), speed=limiteRadar(p.velocidade);
      const occurrences=[];
      for(const s of this.segments){
        // Quick bounding box before projecting; no GPS is sent anywhere.
        if(coord[0]<Math.min(s.a[0],s.b[0])-.0004||coord[0]>Math.max(s.a[0],s.b[0])+.0004||coord[1]<Math.min(s.a[1],s.b[1])-.0003||coord[1]>Math.max(s.a[1],s.b[1])+.0003)continue;
        if(direction!==null&&angleDifference(direction,s.heading)>65)continue;
        const hit=projectSegment(coord,s);
        if(hit.distance>RADAR_CORRIDOR)continue;
        const adjacent=occurrences.find(x=>Math.abs(x.along-hit.along)<45);
        if(adjacent){if(hit.distance<adjacent.distance)Object.assign(adjacent,hit);}else occurrences.push(hit);
      }
      for(const hit of occurrences){
        const key=`${coord[0].toFixed(5)},${coord[1].toFixed(5)}:${Math.round(hit.heading/45)}`;
        this.candidates.push({...hit,feature:f,key,speed,directionKnown:direction!==null});
      }
    }
    this.candidates.sort((a,b)=>a.along-b.along);
  }
  resetPosition(){this.previous=null;this.lastTarget=null;}
  update(position,now=Date.now()){
    const c=position?.coords,t=position?.timestamp;
    if(!c||!Number.isFinite(t)||now-t>10000||t>now+2000)return {state:'stale'};
    const point=[c.longitude,c.latitude],accuracy=c.accuracy;
    if(!validCoord(point)||!Number.isFinite(accuracy)||accuracy<0||accuracy>GPS_CORRIDOR)return {state:'accuracy'};
    if(!this.segments.length)return {state:'no-route'};
    let previous=this.previous;
    if(previous&&t<=previous.t)return {state:'old'};
    if(previous&&t-previous.t>15000)previous=null;
    const travelled=previous?pointDistance(previous.point,point):0;
    if(previous&&travelled>Math.max(100,(t-previous.t)/1000*85))return {state:'jump'};
    let heading=typeof c.heading==='number'&&Number.isFinite(c.heading)&&c.heading>=0&&c.heading<360&&!(typeof c.speed==='number'&&c.speed<2)?c.heading:null;
    if(heading===null&&previous&&travelled>Math.max(10,accuracy,previous.accuracy))heading=compassHeading(previous.point,point);
    const hits=this.segments.map(s=>projectSegment(point,s)).filter(h=>h.distance<=GPS_CORRIDOR&&
      (heading===null||angleDifference(heading,h.heading)<=75)&&
      (!previous||(h.along>=previous.along-40&&h.along<=previous.along+travelled+100)));
    hits.sort((a,b)=>a.distance-b.distance);
    if(!hits.length)return {state:'off-route'};
    const best=hits[0];
    // At overlapping stretches, do not guess a distant lap of the route.
    if(hits.some(h=>Math.abs(h.along-best.along)>120&&h.distance<=best.distance+3)&&!previous)return {state:'ambiguous'};
    this.previous={point,t,accuracy,along:best.along};
    const next=this.candidates.find(r=>r.along-best.along>=-15&&r.along-best.along<=RADAR_LOOKAHEAD);
    const passed=this.lastTarget&&this.lastTarget.along-best.along < -20;
    if(next){
      this.lastTarget=next;
      const distance=Math.max(0,next.along-best.along);
      const speed=typeof c.speed==='number'&&Number.isFinite(c.speed)&&c.speed>=0?c.speed:0;
      return {state:'radar',...next,meters:distance,announce:distance<=Math.max(350,Math.min(850,speed*20))};
    }
    if(passed){this.lastTarget=null;return {state:'passed'};}
    return {state:'none'};
  }
}

export function iniciarAlertasRadares(){
  const engine=new RadarRouteEngine();
  const box=document.createElement('section');box.id='radar-alert';box.hidden=true;
  box.setAttribute('aria-label','Aviso de radar cadastrado');
  const style=document.createElement('style');
  style.textContent=`
    #radar-alert[hidden],#radar-alert .radar-limit[hidden]{display:none!important}
    #radar-alert{position:absolute;z-index:23;right:12px;bottom:calc(133px + env(safe-area-inset-bottom));width:min(310px,calc(100% - 120px));border:1px solid #d3a35f;border-radius:17px;background:rgba(19,26,37,.97);color:#fff;padding:12px;box-shadow:0 6px 24px #0008;font:13px system-ui;pointer-events:auto}
    #radar-alert .radar-row{display:flex;align-items:center;gap:10px}
    #radar-alert .radar-copy{min-width:0;flex:1}#radar-alert strong{display:block;font-size:18px;line-height:1.2}
    #radar-alert .radar-limit{border:4px solid #e74848;border-radius:50%;width:59px;height:59px;flex:0 0 59px;background:white;color:#152030;display:grid;place-content:center;text-align:center;font-size:23px;font-weight:850;line-height:1}
    #radar-alert .radar-limit small{font-size:9px;font-weight:600;margin-top:3px}
    #radar-alert p{margin:5px 0 0;color:#cbd5e1;font-size:11px;line-height:1.35}
    #radar-alert .radar-source{font-size:10px;color:#a9bacd}
    #radar-alert button{min-height:38px;margin-top:8px;border:1px solid #65788c;border-radius:8px;background:#25374c;color:#fff;padding:6px 10px;font:600 11px system-ui;cursor:pointer}
    #radar-alert button:focus-visible{outline:3px solid #fff}
    @media(max-height:500px){#radar-alert{bottom:calc(115px + env(safe-area-inset-bottom));padding:8px;width:260px}#radar-alert .radar-source{display:none}}
  `;
  document.head.append(style);
  const row=document.createElement('div');row.className='radar-row';
  const copy=document.createElement('div');copy.className='radar-copy';
  const title=document.createElement('strong');title.setAttribute('role','status');title.setAttribute('aria-live','polite');
  const detail=document.createElement('p');
  const limit=document.createElement('div');limit.className='radar-limit';
  const number=document.createElement('span'),unit=document.createElement('small');unit.textContent='km/h';limit.append(number,unit);
  copy.append(title,detail);row.append(copy,limit);
  const source=document.createElement('p');source.className='radar-source';
  const sound=document.createElement('button');sound.type='button';sound.textContent='Ativar aviso por voz';sound.setAttribute('aria-pressed','false');
  box.append(row,source,sound);document.querySelector('.maparea').append(box);
  let active=false,loaded=false,loadError=false,lastFix=null,soundOn=false,passedUntil=0,spoken=new Map(),lastSpoken=0,lastRender='';
  const speechAvailable='speechSynthesis' in window&&'SpeechSynthesisUtterance' in window;
  sound.disabled=!speechAvailable;if(!speechAvailable)sound.textContent='Voz indisponível';
  function cancelVoice(){if(soundOn&&speechAvailable)window.speechSynthesis.cancel();}
  function say(text){
    if(!soundOn||!speechAvailable||document.hidden)return;
    const message=new SpeechSynthesisUtterance(text);message.lang='pt-BR';message.rate=1;
    window.speechSynthesis.cancel();window.speechSynthesis.speak(message);
  }
  sound.addEventListener('click',()=>{
    if(soundOn)cancelVoice();soundOn=!soundOn;
    sound.textContent=soundOn?'Silenciar voz':'Ativar aviso por voz';sound.setAttribute('aria-pressed',String(soundOn));
    if(soundOn){say('Avisos de radar ativados.');lastSpoken=Date.now();}
  });
  function render(result){
    if(!active){box.hidden=true;return;}
    box.hidden=false;
    if(!loaded)result={state:loadError?'data-error':'loading'};
    const messages={loading:'Carregando radares…','data-error':'Base de radares indisponível',waiting:'Aguardando GPS',stale:'GPS sem sinal recente',accuracy:'GPS impreciso',jump:'Conferindo posição GPS','off-route':'Fora da rota calculada',ambiguous:'Conferindo trecho da rota','no-route':'Calcule uma rota',none:'Sem radar cadastrado próximo',passed:'Radar ultrapassado'};
    if(result.state==='old')return;
    if(result.state==='passed')passedUntil=Date.now()+2500;
    if(result.state==='none'&&Date.now()<passedUntil)result={state:'passed'};
    const isRadar=result.state==='radar';
    const distance=isRadar?Math.max(0,Math.ceil(result.meters/10)*10):0;
    const heading=isRadar?(distance<=10?'Radar próximo':`Radar em ${distance} m`):(messages[result.state]||'Aguardando GPS');
    const signature=[result.state,result.key,distance,result.speed].join('|');
    if(signature!==lastRender){
      lastRender=signature;title.textContent=heading;limit.hidden=!isRadar;
      number.textContent=result.speed===null?'—':String(result.speed??'—');
      limit.setAttribute('aria-label',result.speed===null?'Limite não informado':`Limite cadastrado: ${result.speed} quilômetros por hora`);
      detail.textContent=isRadar?(result.speed===null?'Limite não informado':`Velocidade máxima cadastrada: ${result.speed} km/h`):
        result.state==='none'?'Nenhum ponto elegível nos próximos 1.000 m. Cobertura incompleta.':
        result.state==='data-error'?'Não foi possível carregar os dados. Reabra a página para tentar novamente.':
        result.state==='passed'?'Seguindo para o próximo ponto.':'O aviso será atualizado com uma posição confiável na rota.';
      source.textContent=isRadar?`${result.feature.properties.fonte||'Cadastro público'}${result.directionKnown?'':' · Sentido não confirmado'}`:'Dados: CET-SP · Bunda de Urso / Challado';
    }
    if(!isRadar){cancelVoice();return;}
    const now=Date.now();
    if(soundOn&&result.announce&&now-(spoken.get(result.key)||0)>120000&&now-lastSpoken>7000&&!document.hidden){
      say(`Radar em ${distance} metros. ${result.speed===null?'Limite não informado.':`Velocidade máxima cadastrada, ${result.speed} quilômetros por hora.`}`);
      spoken.set(result.key,now);lastSpoken=now;
    }
  }
  async function load(){
    for(const url of ['data/radares_consolidados.geojson','data/radares_ativos.geojson']){
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
      try{
        const response=await fetch(url,{cache:'no-store',signal:controller.signal});
        if(!response.ok)throw new Error('HTTP '+response.status);
        const data=await response.json();
        if(data.type!=='FeatureCollection'||!Array.isArray(data.features)||!data.features.length)throw new Error('Base inválida');
        engine.setFeatures(data.features);loaded=true;
        engine.resetPosition();render(lastFix?engine.update(lastFix):{state:'waiting'});return;
      }catch(e){/* Try the CET fallback, without inventing points. */}finally{clearTimeout(timer);}
    }
    loadError=true;render({state:'data-error'});
  }
  load();
  const timer=setInterval(()=>{
    if(active&&lastFix&&Date.now()-lastFix.timestamp>10000){engine.resetPosition();render({state:'stale'});}
  },1500);
  return {
    setRoute(line){engine.setRoute(line);passedUntil=0;lastRender='';render({state:'waiting'});},
    start(){active=true;lastFix=null;engine.resetPosition();render({state:'waiting'});},
    stop(){active=false;lastFix=null;engine.resetPosition();cancelVoice();box.hidden=true;},
    unavailable(){render({state:'stale'});},
    resetPosition(){engine.resetPosition();lastFix=null;spoken.clear();passedUntil=0;lastRender='';},
    update(position){if(!active)return;const result=engine.update(position);if(result.state!=='old')lastFix=position;render(result);}
  };
}

// Reprodução temporária. A taxa acelera o percurso; coords.speed mantém a velocidade escolhida.
export class RoutePlayback {
  constructor(line,{kmh=60,rate=1}={}){
    if(!Array.isArray(line)||line.length<2||!line.every(validCoord))throw new Error('Rota inválida para simulação');
    this.segments=segmentsOf(line);this.total=this.segments.reduce((sum,s)=>sum+s.length,0);
    if(!this.total)throw new Error('Rota sem extensão');
    this.along=0;this.kmh=kmh;this.rate=rate;this.paused=false;
  }
  tick(ms){if(!this.paused)this.seek(this.along+Math.max(0,Math.min(2000,ms))/1000*this.kmh/3.6*this.rate);}
  seek(meters){this.along=Math.max(0,Math.min(this.total,meters));}
  position(timestamp){
    const s=this.segments.find(s=>s.along+s.length>=this.along)||this.segments.at(-1);
    const t=Math.max(0,Math.min(1,(this.along-s.along)/s.length));
    return {timestamp,coords:{longitude:s.a[0]+(s.b[0]-s.a[0])*t,latitude:s.a[1]+(s.b[1]-s.a[1])*t,accuracy:3,heading:s.heading,speed:this.paused?0:this.kmh/3.6}};
  }
}
