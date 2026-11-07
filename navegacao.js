/* ULTRON SP V10 — navegação e velocímetro da via, sem alertas vinculados à fiscalização.
   Geocodificação: Photon (busca explícita), fallback Nominatim sob demanda.
   Rotas: OSRM público para demonstração. Para produção, contratar backend com SLA.
*/
'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { map: null, lib: null, origin: null, dest: null, routes: [], selectedRoute: 0,
                  choosing: null, markers: [], gpsMarker: null, watchId: null, busy: false,
                  requests: {origin: 0, dest: 0}, gpsPosition: null, gpsPrev: null,
                  speedKmh: null, gpsAvailability: 'pending', followMap: false,
                  speedLimit: null, requestingTracking: false,
                  sim: {active:false,playing:false,speed:60,rate:30,progress:0,coordinates:[],cumulative:[],total:0,
                        marker:null,position:null,follow:true,raf:null,lastFrame:null,lastPaint:0} };
  const formatKm = m => (m >= 10000 ? (m/1000).toLocaleString('pt-BR',{maximumFractionDigits:0}) : (m/1000).toLocaleString('pt-BR',{maximumFractionDigits:1})) + ' km';
  const formatDur = secs => { let n = Math.max(1,Math.round(secs/60)); const h=Math.floor(n/60); n %= 60; return h ? `${h} h${n ? ` ${n} min` : ''}` : `${n} min`; };
  const escapeValue = (str) => String(str??'');
  const short = (str, max=55) => String(str??'').length>max ? String(str).slice(0,max-1)+'…' : String(str??'');
  const pause = ms => new Promise(resolve => setTimeout(resolve,ms));

  function status(text, kind='info') {
    const el=$('nav-status'); el.textContent=text; el.dataset.kind=kind;
  }
  function buttonState(){
    $('nav-route').disabled=!(state.origin&&state.dest)||state.busy;
    $('nav-clear').disabled=!(state.origin||state.dest||state.routes.length);
  }
  function setEndpoint(which, coords, label){
    if(!Array.isArray(coords)||coords.length<2||!coords.every(Number.isFinite))return;
    state[which]={coords:[Number(coords[0]),Number(coords[1])],label:escapeValue(label)};
    $('nav-'+which).value=label;
    $('nav-'+which+'-results').replaceChildren();
    $('nav-'+which+'-results').hidden=true;
    clearRoute();
    buttonState();
    drawMarkers();
    if(state.map)state.map.flyTo({center:coords,zoom:Math.max(11,state.map.getZoom()),essential:true});
    status((which==='origin'?'Origem':'Destino')+' definido. '+(state.origin&&state.dest?'Pronto para calcular o trajeto.':'Defina o outro ponto.'));
    if(state.origin&&state.dest&&!state.busy)queueMicrotask(()=>{if(state.origin&&state.dest&&!state.busy)route();});
  }
  function resetEndpoint(which){
    if(state[which]){state[which]=null;clearRoute();drawMarkers();}
    buttonState();
  }
  function clearRoute(){
    stopSimulation();
    state.routes=[];state.selectedRoute=0;leaveRouteView();
    $('nav-result').hidden=true;
    if(state.map&&state.map.getSource('ultron-nav-route'))state.map.getSource('ultron-nav-route').setData(emptyFeature());
  }
  const emptyFeature=()=>({type:'FeatureCollection',features:[]});
  function makePin(color, text){const el=document.createElement('div');el.className='nav-map-pin';el.style.setProperty('--pin-color',color);el.textContent=text;return el;}
  function drawMarkers(){
    for(const m of state.markers)m.remove();state.markers=[];
    if(!state.map||!state.lib)return;
    for(const [which,color,text] of [['origin','#6de1ce','A'],['dest','#ffce86','B']]){
      const p=state[which];if(!p)continue;
      state.markers.push(new state.lib.Marker({element:makePin(color,text),anchor:'center'}).setLngLat(p.coords).addTo(state.map));
    }
  }
  function formatPhoton(feature){
    const p=feature.properties||{}, c=feature.geometry?.coordinates;
    if(!Array.isArray(c)||!Number.isFinite(c[0])||!Number.isFinite(c[1]))return null;
    const parts=[p.name, p.street, p.housenumber, p.district, p.city, p.state].filter(Boolean);
    const label=[...new Set(parts)].join(', ') || `${c[1].toFixed(5)}, ${c[0].toFixed(5)}`;
    return {coords:c,label};
  }
  function formatNominatim(item){
    const lon=Number(item.lon),lat=Number(item.lat);
    return Number.isFinite(lon)&&Number.isFinite(lat)?{coords:[lon,lat],label:String(item.display_name||`${lat}, ${lon}`)}:null;
  }
  const abortAfter=(timeout=11000)=>AbortSignal.timeout?AbortSignal.timeout(timeout):undefined;
  async function queryPhoton(q,near){
    const params = new URLSearchParams({q,limit:'8',countrycode:'BR'});
    if(near){params.set('lat',String(near[1]));params.set('lon',String(near[0]));}
    const r=await fetch('https://photon.komoot.io/api/?'+params.toString(),{signal:abortAfter()});
    if(!r.ok)throw Error('Photon: HTTP '+r.status);
    const payload=await r.json();return (payload.features||[]).map(formatPhoton).filter(Boolean);
  }
  async function queryNominatim(q){
    const params=new URLSearchParams({q,format:'jsonv2',countrycodes:'br',limit:'8',addressdetails:'1'});
    const r=await fetch('https://nominatim.openstreetmap.org/search?'+params.toString(),{signal:abortAfter()});
    if(!r.ok)throw Error('Nominatim: HTTP '+r.status);
    return (await r.json()).map(formatNominatim).filter(Boolean);
  }
  function searchResults(which,results,query,includeFallback){
    const box=$('nav-'+which+'-results');box.replaceChildren();box.hidden=false;
    if(!results.length){const p=document.createElement('p');p.className='nav-search-note';p.textContent='Nenhum lugar encontrado. Tente rua + cidade ou marque diretamente no mapa.';box.append(p);}
    for(const r of results){
      const btn=document.createElement('button');btn.className='nav-search-item';btn.type='button';
      const label=document.createElement('span');label.textContent=short(r.label,115);btn.append(label);
      btn.addEventListener('click',()=>setEndpoint(which,r.coords,r.label));box.append(btn);
    }
    if(includeFallback){
      const other=document.createElement('button');other.type='button';other.className='nav-search-more';other.textContent='Tentar outra busca (OpenStreetMap)';
      other.addEventListener('click',async()=>{
        other.disabled=true;other.textContent='Consultando alternativa…';
        try{const extra=await queryNominatim(query);searchResults(which,extra,query,false);
          if(!extra.length)status('Busca alternativa também não encontrou o lugar. Use a seleção no mapa.','warning');
        }catch(err){status('Outra busca indisponível: '+err.message,'error');other.disabled=false;other.textContent='Tentar novamente';}
      });box.append(other);
    }
  }
  function parseCoordinates(q){
    const match=q.trim().match(/^(-?\d{1,2}(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)$/);
    if(!match)return null;
    const lat=Number(match[1].replace(',','.')),lon=Number(match[2].replace(',','.'));
    if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)return null;
    return [lon,lat];
  }
  async function search(which){
    const input=$('nav-'+which),query=input.value.trim();
    if(query.length<3){status('Digite pelo menos 3 caracteres para pesquisar.','warning');return;}
    const coords=parseCoordinates(query);
    if(coords){setEndpoint(which,coords,`${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}`);return;}
    resetEndpoint(which);
    const id=++state.requests[which];
    const box=$('nav-'+which+'-results');box.hidden=false;box.textContent='Pesquisando lugares…';
    status('Buscando '+(which==='origin'?'origem':'destino')+'…');
    // Prioriza localizações próximas ao ponto de partida, ou ao centro do mapa.
    const bias=which==='dest'&&state.origin?state.origin.coords:state.map?.getCenter()?.toArray()||[-46.63,-23.55];
    try{
      const res=await queryPhoton(query,bias);
      if(id!==state.requests[which])return;
      searchResults(which,res,query,true);
      status(res.length?`Encontrei ${res.length} resultado(s). Escolha um lugar na lista.`:'Não encontrei esse nome. Tente a busca alternativa ou escolha no mapa.',res.length?'info':'warning');
    }catch(err){
      if(id!==state.requests[which])return;
      box.replaceChildren();
      const p=document.createElement('p');p.className='nav-search-note';p.textContent='O serviço principal está indisponível.';box.append(p);
      const b=document.createElement('button');b.type='button';b.className='nav-search-more';b.textContent='Buscar com OpenStreetMap';
      b.addEventListener('click',async()=>{b.disabled=true;try{searchResults(which,await queryNominatim(query),query,false);status('Busca alternativa concluída.');}catch(error){b.disabled=false;status('Falha nas duas buscas: '+error.message,'error');}});
      box.append(b);status('Busca principal falhou: '+err.message,'warning');
    }
  }
  async function gpsOrigin(){
    if(!navigator.geolocation){status('Este navegador não oferece geolocalização.','error');return;}
    status('Solicitando sua localização ao navegador…');
    $('nav-gps').disabled=true;
    navigator.geolocation.getCurrentPosition(pos=>{
      $('nav-gps').disabled=false;
      setEndpoint('origin',[pos.coords.longitude,pos.coords.latitude],'Minha localização');
      status('Localização definida. Só será usada para o cálculo se você pedir uma rota.');
    },err=>{ $('nav-gps').disabled=false;status('Não foi possível obter GPS: '+err.message,'warning');},
    {enableHighAccuracy:true,timeout:12000,maximumAge:12000});
  }
  function setMapSelection(which){
    if(!state.map){status('O mapa ainda não está disponível.','warning');return;}
    state.choosing=which;
    window.__ultronNavMapSelection=true;
    state.map.getCanvas().style.cursor='crosshair';
    status(`Clique no mapa para marcar ${which==='origin'?'a origem':'o destino'}. Toque novamente no botão para cancelar.`);
    $('nav-origin-pick').classList.toggle('active',which==='origin');
    $('nav-dest-pick').classList.toggle('active',which==='dest');
  }
  function stopMapSelection(){state.choosing=null;window.__ultronNavMapSelection=false;
    if(state.map)state.map.getCanvas().style.cursor='';
    $('nav-origin-pick').classList.remove('active');$('nav-dest-pick').classList.remove('active');}

  function maneuverText(s){
    const m=s.maneuver||{},type=m.type||'',dir=m.modifier||'',road=(s.name||'').trim();
    let msg='';
    if(type==='depart')msg='Siga pela via';
    else if(type==='arrive')return 'Chegada ao destino';
    else if(type==='roundabout'||type==='rotary')msg='Entre na rotatória';
    else if(type==='merge')msg='Entre na via';
    else if(type==='on ramp')msg='Pegue o acesso';
    else if(type==='off ramp')msg='Saia pelo acesso';
    else if(type==='fork')msg='Mantenha-se '+(dir.includes('left')?'à esquerda':dir.includes('right')?'à direita':'na via');
    else if(type==='end of road')msg='No fim da via, '+(dir.includes('left')?'vire à esquerda':dir.includes('right')?'vire à direita':'prossiga');
    else if(type==='turn')msg=dir.includes('left')?'Vire à esquerda':dir.includes('right')?'Vire à direita':dir.includes('uturn')?'Faça o retorno':'Siga em frente';
    else if(type==='continue'||type==='new name')msg=dir.includes('left')?'Continue à esquerda':dir.includes('right')?'Continue à direita':'Continue em frente';
    else msg='Prossiga';
    return road?`${msg} — ${road}`:msg;
  }
  function renderInstructions(route){
    const list=$('nav-steps');list.replaceChildren();
    let count=0;
    for(const leg of route.legs||[]){for(const step of leg.steps||[]){
      if(step.maneuver?.type==='notification')continue;
      const row=document.createElement('li');row.className='nav-step';
      const dist=document.createElement('span');dist.className='nav-step-distance';dist.textContent=step.maneuver?.type==='arrive'?'Fim':step.distance>=1000?formatKm(step.distance):`${Math.round(step.distance)} m`;
      const desc=document.createElement('span');desc.textContent=maneuverText(step);
      row.append(dist,desc);list.append(row);count++;
    }}
    if(!count){const el=document.createElement('li');el.textContent='Instruções detalhadas indisponíveis para este trajeto.';list.append(el);}
  }
  function routeFeature(route){return {type:'Feature',geometry:route.geometry,properties:{}};}
  function showRoute(index){
    stopSimulation();
    state.selectedRoute=index;
    const route=state.routes[index];if(!route)return;
    $('nav-result').hidden=false;
    $('nav-distance').textContent=formatKm(route.distance);
    $('nav-duration').textContent=formatDur(route.duration);
    $('nav-alt-list').replaceChildren();
    if(state.routes.length>1)for(let i=0;i<state.routes.length;i++){
      const r=state.routes[i],b=document.createElement('button');b.type='button';
      b.className='nav-alt'+(index===i?' active':'');
      b.textContent=`Rota ${i+1} · ${formatKm(r.distance)} · ${formatDur(r.duration)}`;
      b.addEventListener('click',()=>showRoute(i));$('nav-alt-list').append(b);
    }
    renderInstructions(route);
    if(state.map){
      const s=state.map.getSource('ultron-nav-route');if(s)s.setData({type:'FeatureCollection',features:[routeFeature(route)]});

    }
    status('Trajeto calculado. Tempo aproximado sem trânsito em tempo real.');
    enterRouteView();
  }
  async function route(){
    if(!state.origin||!state.dest){status('Escolha origem e destino antes de calcular.','warning');return;}
    if(state.busy)return;
    state.busy=true;buttonState();$('nav-route').textContent='Calculando…';status('Consultando o roteador OSRM…');
    const p=state.origin.coords,d=state.dest.coords;
    try{
      const params=new URLSearchParams({overview:'full',geometries:'geojson',steps:'true',alternatives:'true'});
      const url=`https://router.project-osrm.org/route/v1/driving/${p.join(',')};${d.join(',')}?${params}`;
      const r=await fetch(url,{signal:abortAfter(18000)});if(!r.ok)throw Error('Roteamento: HTTP '+r.status);
      const data=await r.json();
      if(data.code!=='Ok'||!data.routes?.length)throw Error(data.message||'Não existe um trajeto rodoviário entre os pontos informados.');
      state.routes=data.routes.filter(r=>r.geometry?.type==='LineString'&&r.geometry?.coordinates?.length>1);
      if(!state.routes.length)throw Error('O serviço não retornou uma geometria de trajeto válida.');
      showRoute(0);
    }catch(err){clearRoute();status('Não foi possível traçar rota: '+err.message,'error');}
    finally{state.busy=false;buttonState();$('nav-route').textContent='Traçar rota';}
  }
  function clearAll(){
    for(const w of ['origin','dest']){state[w]=null;state.requests[w]++;$('nav-'+w).value='';$('nav-'+w+'-results').replaceChildren();$('nav-'+w+'-results').hidden=true;}
    stopMapSelection();clearRoute();drawMarkers();buttonState();status('Informe uma origem e um destino para começar.');
  }
  // O CSV contém velocidades de equipamentos, não o limite atual da via.
  // Só destacamos excesso em relação ao limite de placa informado voluntariamente.
  function renderSpeed(){
    const value=$('speed-value'),caption=$('speed-limit-caption'),hud=$('speed-hud');
    const speed=state.sim.active?state.sim.speed:state.speedKmh;
    value.textContent=Number.isFinite(speed)?String(Math.round(Math.max(0,speed))):'—';
    const limit=state.speedLimit;
    const excess=Number.isFinite(speed)&&Number.isFinite(limit)&&speed>limit;
    hud.classList.toggle('over-limit',excess);
    hud.setAttribute('aria-label',state.sim.active?'Velocidade simulada — teste virtual':'Velocidade aproximada por GPS');
    const suffix=Number.isFinite(limit)?`limite de placa informado: ${limit} km/h`:'limite não informado';
    const prefix=state.sim.active?'SIMULAÇÃO · NÃO É GPS':state.gpsAvailability==='denied'?'Localização bloqueada':state.gpsAvailability==='unavailable'?'GPS indisponível':state.gpsAvailability==='pending'?'Aguardando GPS':'Velocidade aproximada';
    caption.textContent=prefix+' · '+suffix;
  }
  function haversineMeters(a,b){
    const rad=Math.PI/180,lat1=a[1]*rad,lat2=b[1]*rad,dlat=(b[1]-a[1])*rad,dlon=(b[0]-a[0])*rad;
    const q=Math.sin(dlat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dlon/2)**2;
    return 12742000*Math.asin(Math.min(1,Math.sqrt(q)));
  }

  // Simulador reproduz apenas a geometria devolvida pelo OSRM; não acessa GPS.
  // "Velocidade" é virtual; fator 1x/10x/30x acelera somente o relógio da demonstração.
  function simulationTrack(route){
    const coords=route.geometry?.coordinates||[];
    if(coords.length<2)return null;
    const cumulative=[0];
    for(let i=1;i<coords.length;i++)cumulative.push(cumulative[i-1]+haversineMeters(coords[i-1],coords[i]));
    const total=cumulative[cumulative.length-1];
    if(total<1)return null;
    return {coordinates:coords,cumulative,total};
  }
  function simulationPoint(progress){
    const sim=state.sim, cs=sim.cumulative,pts=sim.coordinates;
    if(progress<=0)return pts[0].slice();
    if(progress>=sim.total)return pts[pts.length-1].slice();
    let lo=1,hi=cs.length-1;
    while(lo<hi){const mid=(lo+hi)>>1;if(cs[mid]<progress)lo=mid+1;else hi=mid;}
    const a=lo-1,b=lo,den=cs[b]-cs[a],t=den>0?(progress-cs[a])/den:0;
    return [pts[a][0]+(pts[b][0]-pts[a][0])*t,pts[a][1]+(pts[b][1]-pts[a][1])*t];
  }
  function recenterSimulation(animated=true){
    const sim=state.sim;
    if(!sim.active||!sim.position||!state.map)return;
    sim.follow=true;
    const config={center:sim.position,zoom:Math.max(13,state.map.getZoom()),duration:animated?400:0,essential:true};
    if(animated)state.map.easeTo(config);else state.map.jumpTo(config);
    renderRecenter();
  }
  function updateSimulationView(forceCenter=false){
    const sim=state.sim;
    if(!sim.active)return;
    sim.position=simulationPoint(sim.progress);
    if(state.map&&state.lib){
      if(!sim.marker){const el=document.createElement('div');el.className='sim-map-pin';
        el.setAttribute('aria-label','Posição virtual do teste');
        sim.marker=new state.lib.Marker({element:el,anchor:'center'}).setLngLat(sim.position).addTo(state.map);
      }else sim.marker.setLngLat(sim.position);
      if(sim.follow){if(forceCenter)recenterSimulation(false);
        else state.map.jumpTo({center:sim.position});}
    }
    const fraction=Math.min(1,sim.progress/sim.total);
    const route=state.routes[state.selectedRoute];
    const remaining=route?route.distance*(1-fraction):sim.total-sim.progress;
    $('sim-progress').textContent=`${Math.round(fraction*100)}% · faltam ${formatKm(remaining)}`;
    renderRecenter();
  }
  function updateSimulationControls(){
    const sim=state.sim;
    $('sim-panel').hidden=!sim.active;
    $('route-hud-sim').textContent=sim.active?'Simulando':'Simular';
    $('route-hud-sim').disabled=sim.active;
    $('sim-speed').value=String(sim.speed);
    $('sim-speed-value').textContent=sim.speed+' km/h';
    $('sim-rate').value=String(sim.rate);
    const ended=sim.active&&sim.progress>=sim.total;
    $('sim-play').textContent=ended?'Concluído':sim.playing?'Pausar':'Continuar';
    $('sim-play').disabled=ended;
    $('sim-status').textContent=ended?'Trajeto concluído':sim.playing?(sim.speed===0?'Parado · 0 km/h':'Reproduzindo'):'Pausado';
    renderSpeed();
  }
  function pauseSimulation(){
    const sim=state.sim;
    if(!sim.active)return;
    sim.playing=false;sim.lastFrame=null;
    if(sim.raf!=null){cancelAnimationFrame(sim.raf);sim.raf=null;}
    updateSimulationControls();
  }
  function stopSimulation(){
    const sim=state.sim;
    if(sim.raf!=null){cancelAnimationFrame(sim.raf);sim.raf=null;}
    if(sim.marker){sim.marker.remove();sim.marker=null;}
    sim.active=false;sim.playing=false;sim.position=null;sim.progress=0;sim.total=0;
    sim.cumulative=[];sim.coordinates=[];sim.follow=true;sim.lastFrame=null;sim.lastPaint=0;
    updateSimulationControls();
    renderRecenter();
  }
  function simulationFrame(now){
    const sim=state.sim;
    if(!sim.active||!sim.playing)return;
    if(sim.lastFrame!=null){
      const seconds=Math.min(.2,Math.max(0,(now-sim.lastFrame)/1000));
      sim.progress=Math.min(sim.total,sim.progress+(sim.speed/3.6)*seconds*sim.rate);
    }
    sim.lastFrame=now;
    const ended=sim.progress>=sim.total;
    if(ended||now-sim.lastPaint>75){sim.lastPaint=now;updateSimulationView();}
    if(ended){pauseSimulation();return;}
    sim.raf=requestAnimationFrame(simulationFrame);
  }
  function playSimulation(){
    const sim=state.sim;
    if(!sim.active||sim.playing||sim.progress>=sim.total)return;
    sim.playing=true;sim.lastFrame=null;sim.lastPaint=0;
    updateSimulationControls();
    sim.raf=requestAnimationFrame(simulationFrame);
  }
  function startSimulation(){
    const route=state.routes[state.selectedRoute];
    if(!route){status('Calcule uma rota para iniciar a simulação.','warning');return;}
    const track=simulationTrack(route);
    if(!track){status('Rota sem pontos suficientes para simular.','warning');return;}
    stopFollow();stopSimulation();
    Object.assign(state.sim,track,{active:true,playing:false,progress:0,follow:true});
    updateSimulationControls();
    updateSimulationView(true);
    playSimulation();
    status('Simulação virtual iniciada. Nenhum dado do GPS será utilizado.');
  }
  function restartSimulation(){
    if(!state.sim.active)return;
    pauseSimulation();state.sim.progress=0;state.sim.follow=true;
    updateSimulationView(true);playSimulation();
  }

  function speedFromFix(fix){
    const p=fix.coords,coords=[p.longitude,p.latitude],t=Number(fix.timestamp)||Date.now();
    const raw=Number.isFinite(p.speed)&&p.speed>=0 ? p.speed*3.6 : null;
    let estimate=null;
    if(raw!==null) estimate=raw;
    else if(state.gpsPrev){
      const delta=(t-state.gpsPrev.time)/1000;
      if(delta>=3&&delta<=30&&p.accuracy<=50&&state.gpsPrev.accuracy<=50){
        const d=haversineMeters(coords,state.gpsPrev.coords);
        if(d>=12) estimate=d/delta*3.6;
        else if(d<8&&delta>=5)estimate=0;
      }
    }
    state.gpsPrev={coords,time:t,accuracy:p.accuracy};
    // Não apresentar valores derivados de posições pouco confiáveis.
    if(p.accuracy>85)estimate=null;
    state.speedKmh=estimate;
    state.gpsAvailability='ready';
    renderSpeed();
    return coords;
  }
  function renderRecenter(){
    const btn=$('map-recenter');
    if(state.sim.active){
      btn.title=state.sim.follow?'Acompanhando ponto virtual':'Voltar ao ponto virtual';
      btn.hidden=state.sim.follow;
    }else{
      btn.title=state.gpsPosition?(state.followMap?'Centralizado na localização':'Voltar à minha localização'):'Ativar localização';
      btn.hidden=!!state.gpsPosition&&state.followMap;
    }
    btn.setAttribute('aria-label',btn.title);
  }
  function centerOnUser(animate=true){
    if(!state.map||!state.gpsPosition)return;
    state.followMap=true;
    state.map.easeTo({center:state.gpsPosition,zoom:Math.max(14,state.map.getZoom()),duration:animate?480:0,essential:true});
    renderRecenter();
  }
  function pauseAutoFollow(){
    if(state.sim.active){state.sim.follow=false;renderRecenter();return;}
    if(!state.followMap)return;
    state.followMap=false;
    renderRecenter();
  }
  function drawGps(pos){
    state.gpsPosition=pos;
    if(!state.map||!state.lib)return;
    if(!state.gpsMarker){state.gpsMarker=new state.lib.Marker({element:makePin('#62a9ff','●'),anchor:'center'}).setLngLat(pos).addTo(state.map);}
    else state.gpsMarker.setLngLat(pos);
    if(state.followMap)centerOnUser(false);
    else renderRecenter();
  }
  function stopFollow(){
    if(state.watchId!=null&&navigator.geolocation){navigator.geolocation.clearWatch(state.watchId);state.watchId=null;}
    if(state.gpsMarker){state.gpsMarker.remove();state.gpsMarker=null;}
    state.gpsPosition=null;state.gpsPrev=null;state.speedKmh=null;state.followMap=false;
    state.gpsAvailability='pending';
    $('nav-follow').textContent='Acompanhar meu GPS';$('nav-follow').classList.remove('active');
    renderSpeed();renderRecenter();
  }
  function startTracking(){
    if(state.sim.active)stopSimulation();
    if(state.watchId!=null){centerOnUser();return;}
    if(!navigator.geolocation){state.gpsAvailability='unavailable';renderSpeed();renderRecenter();return;}
    state.followMap=true;state.gpsAvailability='pending';renderSpeed();
    state.watchId=navigator.geolocation.watchPosition(fix=>{
      const coords=speedFromFix(fix);
      drawGps(coords);
      $('nav-follow').textContent='Desligar GPS';$('nav-follow').classList.add('active');
    },err=>{
      stopFollow();state.gpsAvailability=err.code===1?'denied':'unavailable';renderSpeed();
      status('Não foi possível acompanhar a localização: '+err.message,'warning');
    },{enableHighAccuracy:true,maximumAge:2000,timeout:15000});
    $('nav-follow').textContent='Desligar GPS';$('nav-follow').classList.add('active');
  }
  function toggleFollow(){
    if(state.watchId!=null){stopFollow();status('GPS desligado.');return;}
    status('Solicitando permissão para usar o GPS…');startTracking();
  }
  async function startIfAllowed(){
    if(state.sim.active||state.watchId!=null)return;
    // Não mostrar um pedido de permissão inesperado: quando necessário,
    // o usuário toca no botão de centralizar.
    if(!navigator.permissions?.query){renderRecenter();return;}
    try{const p=await navigator.permissions.query({name:'geolocation'});
      if(p.state==='granted'&&document.querySelector('.shell')?.classList.contains('nav-active'))startTracking();
      else {if(p.state==='denied')state.gpsAvailability='denied';renderRecenter();renderSpeed();}
    }catch(e){renderRecenter();}
  }
  function mountMap(map,lib){
    state.map=map;state.lib=lib;
    if(!map.getSource('ultron-nav-route')){
      map.addSource('ultron-nav-route',{type:'geojson',data:emptyFeature()});
      map.addLayer({id:'ultron-nav-shadow',type:'line',source:'ultron-nav-route',layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':'#061f2c','line-width':11,'line-opacity':.8}});
      map.addLayer({id:'ultron-nav-line',type:'line',source:'ultron-nav-route',layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':'#6de1ce','line-width':6,'line-opacity':.98}});
    }
    map.on('click',evt=>{if(!state.choosing)return;const which=state.choosing;
      setEndpoint(which,[evt.lngLat.lng,evt.lngLat.lat],`Ponto marcado (${evt.lngLat.lat.toFixed(5)}, ${evt.lngLat.lng.toFixed(5)})`);stopMapSelection();});
    map.on('dragstart',pauseAutoFollow);
    map.on('zoomstart',evt=>{if(evt?.originalEvent)pauseAutoFollow();});
    map.on('rotatestart',evt=>{if(evt?.originalEvent)pauseAutoFollow();});
    drawMarkers();toggleMunicipalLayers(false);renderRecenter();startIfAllowed();
    if(state.sim.active)updateSimulationView(true);
    if(state.routes.length)enterRouteView();
  }
  function toggleMunicipalLayers(visible){
    if(!state.map)return;
    for(const name of ['city-halos','city-circles','city-counts']){
      if(state.map.getLayer(name))state.map.setLayoutProperty(name,'visibility',visible?'visible':'none');
    }
  }
  function resizeMap(){if(state.map){requestAnimationFrame(()=>state.map.resize());}}
  function openDrawer(which='navigate'){
    if(state.sim.active)pauseSimulation();
    const shell=document.querySelector('.shell'),panel=$('app-panel');
    if(!shell||!panel)return;
    setMode(which);
    shell.classList.add('drawer-open');
    panel.inert=false;panel.setAttribute('aria-hidden','false');
    resizeMap();
  }
  function closeDrawer(){
    const shell=document.querySelector('.shell'),panel=$('app-panel');
    shell?.classList.remove('drawer-open');
    if(panel){panel.inert=true;panel.setAttribute('aria-hidden','true');}
    stopMapSelection();resizeMap();
  }
  function enterRouteView(){
    const route=state.routes[state.selectedRoute];
    if(!route)return;
    const shell=document.querySelector('.shell');shell?.classList.add('route-active');
    $('route-hud').hidden=false;
    $('route-hud-dest').textContent=short(state.dest?.label||'Destino',75);
    $('route-hud-metrics').textContent=`${formatKm(route.distance)} · ${formatDur(route.duration)} · estimativa sem trânsito`;
    closeDrawer();
    if(state.map){requestAnimationFrame(()=>{
      state.map.resize();
      if(state.sim.active&&state.sim.follow){recenterSimulation();return;}
      if(state.gpsPosition&&state.followMap){centerOnUser();return;}
      const b=new state.lib.LngLatBounds();for(const c of route.geometry.coordinates)b.extend(c);
      state.map.fitBounds(b,{padding:{top:105,bottom:80,left:35,right:35},maxZoom:14,duration:650});
      renderRecenter();
    });}
  }
  function leaveRouteView(){
    document.querySelector('.shell')?.classList.remove('route-active');
    $('route-hud').hidden=true;
  }
  function init(){
    $('mode-explore').addEventListener('click',()=>setMode('explore'));
    $('mode-navigate').addEventListener('click',()=>setMode('navigate'));
    $('dock-destination').addEventListener('click',()=>openDrawer('navigate'));
    $('dock-about').addEventListener('click',()=>openDrawer('explore'));
    $('close-panel').addEventListener('click',closeDrawer);
    $('route-hud-edit').addEventListener('click',()=>openDrawer('navigate'));
    $('route-hud-close').addEventListener('click',()=>{clearAll();closeDrawer();});
    $('route-hud-sim').addEventListener('click',startSimulation);
    $('sim-play').addEventListener('click',()=>state.sim.playing?pauseSimulation():playSimulation());
    $('sim-restart').addEventListener('click',restartSimulation);
    $('sim-stop').addEventListener('click',stopSimulation);
    $('sim-speed').addEventListener('input',ev=>{state.sim.speed=Math.max(0,Math.min(200,Number(ev.target.value)||0));updateSimulationControls();});
    $('sim-rate').addEventListener('change',ev=>{state.sim.rate=[1,10,30].includes(Number(ev.target.value))?Number(ev.target.value):1;updateSimulationControls();});
    document.addEventListener('visibilitychange',()=>{if(document.hidden&&state.sim.playing)pauseSimulation();});
    document.addEventListener('keydown',ev=>{if(ev.key==='Escape'&&document.querySelector('.shell')?.classList.contains('drawer-open'))closeDrawer();});
    $('nav-origin-search').addEventListener('click',()=>search('origin'));
    $('nav-dest-search').addEventListener('click',()=>search('dest'));
    for(const which of ['origin','dest']){
      $('nav-'+which).addEventListener('keydown',ev=>{if(ev.key==='Enter'){ev.preventDefault();search(which);}});
      $('nav-'+which).addEventListener('input',()=>{state.requests[which]++;if(state[which])resetEndpoint(which);$('nav-'+which+'-results').hidden=true;});
      $('nav-'+which+'-pick').addEventListener('click',()=>{
        if(state.choosing===which){stopMapSelection();status('Marcação no mapa cancelada.');}
        else setMapSelection(which);
      });
    }
    $('nav-gps').addEventListener('click',gpsOrigin);
    $('nav-route').addEventListener('click',route);
    $('nav-clear').addEventListener('click',clearAll);
    $('nav-follow').addEventListener('click',toggleFollow);
    $('map-recenter').addEventListener('click',()=>{
      if(state.sim.active){recenterSimulation();return;}
      if(state.gpsPosition)centerOnUser();
      else {startTracking();status('Aguardando sua localização para centralizar…');}
    });
    $('nav-posted-limit').addEventListener('change',ev=>{
      const v=Number(ev.target.value);
      state.speedLimit=ev.target.value&&Number.isFinite(v)?v:null;
      renderSpeed();
    });
    $('nav-recenter').addEventListener('click',()=>{if(state.routes.length)showRoute(state.selectedRoute);});
    window.addEventListener('ultron:mapready',evt=>mountMap(evt.detail.map,evt.detail.maplibregl));
    window.addEventListener('pagehide',()=>{stopSimulation();stopFollow();});
    buttonState();updateSimulationControls();renderRecenter();
    setMode('navigate');
  }
  function setMode(which){
    const on=which==='navigate';
    const shell=document.querySelector('.shell');
    shell?.classList.toggle('nav-active',on);
    shell?.classList.toggle('explore-mode',!on);
    $('explore-panel').hidden=on;
    $('navigation-panel').hidden=!on;
    $('info-footer').hidden=on;
    toggleMunicipalLayers(!on);
    $('mode-explore').classList.toggle('active',!on);
    $('mode-navigate').classList.toggle('active',on);
    $('mode-explore').setAttribute('aria-pressed',String(!on));
    $('mode-navigate').setAttribute('aria-pressed',String(on));
    resizeMap();
    if(!on){stopMapSelection();stopFollow();pauseSimulation();}
    else if(state.map)startIfAllowed();
  }
  init();
})();
