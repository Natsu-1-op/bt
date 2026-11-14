const kinds = new Set(['人在动','噪声','真值']);

function validRegion(region,duration){
  return region && kinds.has(region.kind) && Number.isInteger(region.start_ms) && Number.isInteger(region.end_ms) &&
    region.start_ms>=0 && region.end_ms>region.start_ms && region.end_ms<=duration;
}

function dynamicIntervals(regions=[]){
  const ranges=regions.filter(region=>region.kind==='人在动'||region.kind==='噪声')
    .map(region=>[region.start_ms,region.end_ms]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const merged=[];
  for(const [start,end] of ranges){
    const last=merged.at(-1);
    if(last&&start<=last[1])last[1]=Math.max(end,last[1]);
    else merged.push([start,end]);
  }
  return merged;
}

module.exports={validRegion,dynamicIntervals};
