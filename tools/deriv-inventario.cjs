const fs=require("node:fs");
(async()=>{
  const out=[];
  for(const f of ["native/pka_tap_14784.jsonl","native/pka_tap_17748.jsonl","native/pka_tap_19228.jsonl","native/pka_tap_8036.jsonl","native/pka_tap_33524.jsonl"]){
    if(!fs.existsSync(f)){ out.push({file:f,exists:false}); continue; }
    const rl=require("node:readline").createInterface({input:fs.createReadStream(f),crlfDelay:Infinity});
    const kinds={}; let n=0; let tMin=Infinity,tMax=-Infinity; let dirs={};
    let firstK6Ts=null,lastK6Ts=null,k6count=0;
    for await (const l of rl){
      let o; try{o=JSON.parse(l);}catch{continue;}
      n++; kinds[o.kind]=(kinds[o.kind]||0)+1; dirs[o.dir]=(dirs[o.dir]||0)+1;
      if(typeof o.t==="number"){ if(o.t<tMin)tMin=o.t; if(o.t>tMax)tMax=o.t; }
      if(o.kind===6){ k6count++; if(firstK6Ts==null)firstK6Ts=o.t; lastK6Ts=o.t; }
    }
    out.push({file:f,exists:true,records:n,kinds,dirs,tMin,tMax,spanMs:tMax-tMin,k6count,firstK6Ts,lastK6Ts,
      mb:Math.round(fs.statSync(f).size/1048576*10)/10});
  }
  fs.writeFileSync("analysis/lure-stop-rule/passo0-inventario.json",JSON.stringify(out,null,1));
  for(const r of out){
    if(!r.exists){ console.log(r.file,"AUSENTE"); continue; }
    console.log(`\n=== ${r.file}  (${r.mb} MB)`);
    console.log(`  registros=${r.records}  kinds=${JSON.stringify(r.kinds)}`);
    console.log(`  dirs=${JSON.stringify(r.dirs)}`);
    console.log(`  t: ${r.tMin}..${r.tMax}  span=${r.spanMs} ms (${(r.spanMs/1000/60).toFixed(1)} min)`);
    console.log(`  kind6=${r.k6count}`);
  }
})();
