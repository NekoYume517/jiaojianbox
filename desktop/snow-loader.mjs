/* 只在子进程内适配用户已安装的运行时；不改原文件，不使用 WebUI/配置接口。 */
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function load(url,context,nextLoad){
  const result=await nextLoad(url,context);
  if(url!==pathToFileURL(process.env.JJB_SNOW_ENTRY||'').href)return result;
  let source=result.source?.toString()||await fs.readFile(new URL(url),'utf8');
  const bridgeUrl=process.env.JJB_SNOW_BRIDGE;
  const checks=[
    [/const hookManager = new HookManager\(\{[\s\S]*?\}\);/g, match=>match+`\nawait (await import(${JSON.stringify(bridgeUrl)})).start({hookManager,oneBotManager});`],
    [/const autoLoadOnDiscovery = resolveAutoLoad\(runtimeConfig\.hookAutoLoad\);/g,()=> 'const autoLoadOnDiscovery = false;'],
    [/return applyOneBotListenPortOverrides\(config\);/g,()=> 'return {...config,networks:{httpServers:[],httpClients:[],wsServers:[],wsClients:[]},statusCommand:{...config.statusCommand,enabled:false},historySync:{enabled:false}};'],
    [/async function initWebUI\([^\n]*\) \{/g,match=>match+'\nif(process.env.JJB_MANAGED_SNOW==="1")return {stop:async()=>{}};'],
  ];
  for(const [pattern,replacement] of checks){
    const hits=[...source.matchAll(pattern)];
    if(hits.length!==1)throw new Error('此 SnowLuma 版本暂不支持免配置接入，原安装未被修改');
    source=source.replace(pattern,replacement);
  }
  return {...result,source};
}
