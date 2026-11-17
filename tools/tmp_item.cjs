const fs=require("node:fs"),path=require("node:path");
const ROOT=process.cwd();
const {NativeTransport}=require(path.join(ROOT,"botfinal","core","pipe-transport.cjs"));
const pid=1712;
const key=JSON.parse(fs.readFileSync(path.join(ROOT,"captures",`channel-key-${pid}.json`),"utf8")).key;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const t=new NativeTransport({pid,key});
  await t.connect(); await sleep(2000);
  const cases=[
    ["switchPokemon","Dugtrio"],
    ["potion","Alt+f"],
    ["revive","Home"],
    ["useWith","E"],
  ];
  for(const [cmd,arg] of cases){
    try{
      const a=await t.sendCommand(cmd,arg);
      console.log(`${cmd.padEnd(14)} "${arg}" -> status=${a.status} ${a.message||""}`);
    }catch(e){ console.log(`${cmd.padEnd(14)} erro: ${e.message}`); }
    await sleep(900);
  }
  t.close(); process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1)});
