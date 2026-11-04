// Consulta OPCIONAL a um serviço de terceiros: somente após opt-in separado.
// O servidor público de demonstração OSRM pode limitar, rejeitar ou não responder.
import {distanceMeters,validCoords} from './localizacao.js';
export function buildMatchUrl(points){
  const valid=points.filter(p=>validCoords(p.coords)&&Number.isFinite(p.accuracy)&&p.accuracy<=60);
  if(valid.length<3)return null;
  const sample=valid.slice(-12);
  const coords=sample.map(p=>p.coords.join(',')).join(';');
  const radiuses=sample.map(p=>Math.ceil(Math.max(5,Math.min(60,p.accuracy)))).join(';');
  const timestamps=sample.map(p=>Math.floor(p.time/1000)).join(';');
  return `https://router.project-osrm.org/match/v1/driving/${coords}?geometries=geojson&overview=full&steps=false&tidy=true&radiuses=${radiuses}&timestamps=${timestamps}`;
}
export function interpretMatch(response,rawCoords){
  if(response?.code!=='Ok'||!Array.isArray(response.matchings)||!response.matchings.length)return null;
  const m=response.matchings[0];
  const line=m?.geometry?.coordinates;
  if(!Array.isArray(line)||line.length<2||line.some(c=>!validCoords(c)))return null;
  const snaps=(response.tracepoints||[]).filter(Boolean);
  const last=snaps.at(-1)?.location;
  if(!validCoords(last)||distanceMeters(last,rawCoords)>80)return null;
  return {line,coords:last,confidence:Number(m.confidence)||0};
}
export async function requestMatch(points,{signal,fetchImpl=fetch}={}){
  const url=buildMatchUrl(points);
  if(!url)return null;
  const result=await fetchImpl(url,{signal,headers:{Accept:'application/json'}});
  if(!result.ok)throw new Error(`OSRM respondeu HTTP ${result.status}`);
  const body=await result.json();
  return interpretMatch(body,points.at(-1).coords);
}
