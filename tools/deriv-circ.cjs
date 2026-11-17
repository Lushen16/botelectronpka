const fs=require("node:fs");
(async()=>{
  // Verificacao critica: holding e phase concordam? Se sim, C e' circular.
  for(const f of ["native/pka_tap_17748.jsonl","native/pka_tap_8036.jsonl"]){
    const rl=require("node:readline").createInterface({input:fs.createReadStream(f),crlfDelay:Infinity});
    const tab={};
    for await (const l of rl){
      let o; try{o=JSON.parse(l);}catch{continue;}
      if(o.kind!==6||!o.d) continue;
      let obj; try{obj=JSON.parse(Buffer.from(o.d,"hex").toString("utf8"));}catch{continue;}
      const lu=obj.luring||{};
      if(lu.mode==="off"||lu.mode==null) continue;
      const k=`phase=${lu.phase} holding=${lu.holding}`;
      tab[k]=(tab[k]||0)+1;
    }
    console.log(`\n=== ${f}: phase x holding (lure ligado)`);
    Object.entries(tab).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`  ${String(v).padStart(6)}  ${k}`));
  }
})();
