const fs=require("node:fs");
(async()=>{
  const f="native/pka_tap_17748.jsonl";
  const rl=require("node:readline").createInterface({input:fs.createReadStream(f),crlfDelay:Infinity});
  const k6=[];
  for await (const l of rl){
    let o; try{o=JSON.parse(l);}catch{continue;}
    if(o.kind!==6||!o.d) continue;
    let obj; try{obj=JSON.parse(Buffer.from(o.d,"hex").toString("utf8"));}catch{continue;}
    k6.push({t:o.t,phase:obj.phase,luring:obj.luring,phases:obj.phases,core:obj.core,
      paused:obj.paused,tick:obj.tick,pid:obj.pid});
  }
  console.log("kind6 analisados:",k6.length);
  const gaps=[]; for(let i=1;i<k6.length;i++){ const d=k6[i].t-k6[i-1].t; if(d>0&&d<60000) gaps.push(d); }
  const s=gaps.slice().sort((a,b)=>a-b);
  const q=p=>s.length?s[Math.min(s.length-1,Math.floor(s.length*p))]:null;
  console.log("intervalo kind6 (ms): n="+s.length,"mediana="+q(0.5),"p90="+q(0.9),"p95="+q(0.95),"p99="+q(0.99),"max="+s[s.length-1]);
  // campos presentes
  const fields=new Set(); for(const r of k6){ for(const k of Object.keys(r.luring||{})) fields.add("luring."+k); for(const k of Object.keys(r)) fields.add(k); }
  console.log("\ncampos disponiveis:",[...fields].join(", "));
  // fases
  const ph={}; for(const r of k6){ ph[r.phase||"(vazio)"]=(ph[r.phase||"(vazio)"]||0)+1; }
  const norm=s=>s.replace(/\d+\/\d+/g,"n/m").replace(/WP \d+\/\d+/g,"WP n").replace(/\bm\d\b/g,"mX").slice(0,60);
  const phn={}; for(const [k,v] of Object.entries(ph)){ const nk=norm(k); phn[nk]=(phn[nk]||0)+v; }
  console.log("\n=== fases (normalizadas):");
  Object.entries(phn).sort((a,b)=>b[1]-a[1]).slice(0,18).forEach(([k,v])=>console.log(`  ${String(v).padStart(6)}  ${k||"(vazio)"}`));
  fs.writeFileSync("analysis/lure-stop-rule/passo0-kind6-fases.json",JSON.stringify({sessions:{file:f,frames:k6.length,gaps:{median:q(0.5),p90:q(0.9),p95:q(0.95),max:s[s.length-1]}},phases:phn},null,1));
})();
