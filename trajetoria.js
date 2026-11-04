// RadarSP v0.4 — utilitários de rumo, trilha e proximidade geral.
// Não identifica a pista de equipamentos de fiscalização e não envia GPS.
import {bearingDegrees,distanceMeters,validCoords} from './localizacao.js';
const RAD=Math.PI/180;
export const EMPTY_GEOJSON={type:'FeatureCollection',features:[]};
export function normalAngle(deg){return ((deg%360)+360)%360;}
export function pointAtDistance(coords,heading,meters){
  if(!validCoords(coords)||!Number.isFinite(heading)||!Number.isFinite(meters))return null;
  const a=normalAngle(heading)*RAD;
  return [coords[0]+Math.sin(a)*meters/(111195*Math.max(.01,Math.cos(coords[1]*RAD))),coords[1]+Math.cos(a)*meters/111195];
}
export function headingFromTrail(positions){
  if(!Array.isArray(positions)||positions.length<2)return null;
  const current=positions.at(-1);
  if(!validCoords(current.coords)||Number.isFinite(current.accuracy)&&current.accuracy>60)return null;
  for(let i=positions.length-2;i>=0;i--){
    const p=positions[i];if(current.time-p.time>35000)break;
    const d=distanceMeters(p.coords,current.coords);
    const minDist=Math.max(20,1.5*Math.max(current.accuracy||0,p.accuracy||0));
    if(d>=minDist&&d<=300)return bearingDegrees(p.coords,current.coords);
  }
  return null;
}
export function positionConfidence(location){
  if(!location||!validCoords(location.coords))return {ok:false,reason:'Posição indisponível'};
  if(location.mode==='demo')return {ok:true,reason:'Trajeto simulado'};
  if(!Number.isFinite(location.accuracy))return {ok:false,reason:'Precisão GPS desconhecida'};
  if(location.accuracy>60)return {ok:false,reason:'Precisão GPS insuficiente'};
  if(!Number.isFinite(location.heading))return {ok:false,reason:'Direção ainda desconhecida'};
  if(Date.now()-location.time>30000)return {ok:false,reason:'Posição antiga'};
  return {ok:true,reason:'Direção aproximada'};
}
export function nearbySummary(location,features,radiusMeters=350){
  if(!location||!validCoords(location.coords)||!Array.isArray(features))return {count:0,closest:null};
  let count=0,closest=null;
  for(const feature of features){
    const coords=feature?.geometry?.coordinates;
    if(feature?.geometry?.type!=='Point'||!validCoords(coords))continue;
    const d=distanceMeters(location.coords,coords);
    if(Number.isFinite(d)&&d<=radiusMeters){count++;if(!closest||d<closest.distance)closest={distance:d,feature};}
  }
  return {count,closest};
}
export function forwardLine(location,meters=200){
  if(!location||!validCoords(location.coords)||!Number.isFinite(location.heading))return EMPTY_GEOJSON;
  return {type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[location.coords,pointAtDistance(location.coords,location.heading,meters)]}}]};
}
