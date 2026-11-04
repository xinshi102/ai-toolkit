export const STATUS_GLYPH = {pending:'○',active:'●',done:'✓',blocked:'!'};
export function ancestorPath(nodes,id){
  const path=new Set();let node=nodes.find(n=>n.id===id);
  while(node&&!path.has(node.id)){path.add(node.id);node=nodes.find(n=>n.id===node.parent);}
  return path;
}
export function validParent(nodes,id,parent){
  return id!==parent&&nodes.some(n=>n.id===id)&&nodes.some(n=>n.id===parent)&&!ancestorPath(nodes,parent).has(id);
}
export function movedOffset(base,dx,dy,scale){
  const k=Number.isFinite(scale)&&scale>0?scale:1;
  return {dx:Math.round((base?.dx||0)+dx/k),dy:Math.round((base?.dy||0)+dy/k)};
}
export function manualLayout(layout,offsets){
  const positions={};let minX=0,minY=0,maxX=layout.width,maxY=layout.height;
  for(const [id,p]of Object.entries(layout.positions)){
    const o=offsets[id];const q={...p,x:p.x+(Number(o?.dx)||0),y:p.y+(Number(o?.dy)||0)};positions[id]=q;
    minX=Math.min(minX,q.x);minY=Math.min(minY,q.y);maxX=Math.max(maxX,q.x+q.w);maxY=Math.max(maxY,q.y+q.h);
  }
  return {...layout,positions,minX,minY,width:maxX-minX,height:maxY-minY};
}
