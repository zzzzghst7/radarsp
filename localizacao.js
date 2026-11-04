// Utilitários puros de geolocalização do RadarSP v0.3.
// Coordenadas no formato GeoJSON [longitude, latitude].
const R = 6371008.8;
const toRad = degrees => degrees * Math.PI / 180;
const toDeg = radians => radians * 180 / Math.PI;
export function validCoords(coords) {
  return Array.isArray(coords) && coords.length >= 2 && coords.every((n,i) => i>1 || Number.isFinite(n)) &&
    coords[0]>=-180 && coords[0]<=180 && coords[1]>=-90 && coords[1]<=90;
}
export function distanceMeters(a,b){
  if(!validCoords(a)||!validCoords(b))return NaN;
  const lat1=toRad(a[1]),lat2=toRad(b[1]);
  const dLat=toRad(b[1]-a[1]),dLon=toRad(b[0]-a[0]);
  const h=Math.sin(dLat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));
}
export function bearingDegrees(a,b){
  if(!validCoords(a)||!validCoords(b))return null;
  const lat1=toRad(a[1]),lat2=toRad(b[1]),dlon=toRad(b[0]-a[0]);
  const y=Math.sin(dlon)*Math.cos(lat2);
  const x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(dlon);
  if(Math.abs(x)<1e-12&&Math.abs(y)<1e-12)return null;
  return (toDeg(Math.atan2(y,x))+360)%360;
}
export function cardinal(degrees){
  if(!Number.isFinite(degrees))return '—';
  return ['N','NE','L','SE','S','SO','O','NO'][Math.round(((degrees%360)+360)%360/45)%8];
}
// O raio de precisão é desenhado em metros, e não em pixels da tela.
export function accuracyGeometry(coords, accuracy, steps=48){
  if(!validCoords(coords)||!Number.isFinite(accuracy)||accuracy<=0)return null;
  const lat1=toRad(coords[1]),lon1=toRad(coords[0]),angular=Math.min(accuracy,100000)/R;
  const ring=[];
  for(let i=0;i<=steps;i++){
    const heading=2*Math.PI*i/steps;
    const lat2=Math.asin(Math.sin(lat1)*Math.cos(angular)+Math.cos(lat1)*Math.sin(angular)*Math.cos(heading));
    const lon2=lon1+Math.atan2(Math.sin(heading)*Math.sin(angular)*Math.cos(lat1),Math.cos(angular)-Math.sin(lat1)*Math.sin(lat2));
    ring.push([toDeg(lon2),toDeg(lat2)]);
  }
  return {type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[ring]}}]};
}
export const DEMO_ROUTE = [
  [-46.6561,-23.5660],[-46.65555,-23.56578],[-46.65494,-23.56551],
  [-46.65433,-23.56524],[-46.65371,-23.56497],[-46.65299,-23.56465]
];
export function sampleRoute(points, fraction){
  if(!Array.isArray(points)||points.length<2||points.some(p=>!validCoords(p)))throw new Error('Trajeto inválido');
  const segmentLengths=points.slice(1).map((p,i)=>distanceMeters(points[i],p));
  const total=segmentLengths.reduce((a,b)=>a+b,0);
  const t=Math.max(0,Math.min(1,Number.isFinite(fraction)?fraction:0));
  if(t>=1)return {coords:points.at(-1).slice(), heading:bearingDegrees(points.at(-2),points.at(-1)), fraction:1};
  let remaining=t*total;
  for(let i=0;i<segmentLengths.length;i++){
    const len=segmentLengths[i];
    if(remaining<=len||i===segmentLengths.length-1){
      const part=len>0?remaining/len:0;
      return {coords:[points[i][0]+(points[i+1][0]-points[i][0])*part,points[i][1]+(points[i+1][1]-points[i][1])*part],heading:bearingDegrees(points[i],points[i+1]),fraction:t};
    }
    remaining-=len;
  }
}
export function geolocationMessage(error){
  switch(error?.code){
    case 1:return 'Permissão de localização negada. Habilite nas configurações do navegador e tente novamente.';
    case 2:return 'Posição indisponível. Confira GPS, sinal e permissões do aparelho.';
    case 3:return 'O GPS demorou para responder. Tente novamente em um local com melhor sinal.';
    default:return 'Não foi possível obter sua localização. Verifique o navegador e tente novamente.';
  }
}
