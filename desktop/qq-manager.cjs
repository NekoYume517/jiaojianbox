const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const crypto=require('node:crypto');
const http=require('node:http');
const {WebSocketServer}=require('ws');
const READ_ACTIONS=new Set(['get_login_info','get_group_list','get_friend_list','get_group_msg_history','get_friend_msg_history','get_msg','get_status','get_version_info']);

class QQManager{
  constructor({userData,sourceRoot,onStatus,bridgeRoot,runtimeRoot,acceptConsent}){this.bridgeRoot=bridgeRoot||path.join(sourceRoot,'desktop');this.runtimeRoot=runtimeRoot;this.acceptConsent=acceptConsent;this.userData=userData;this.sourceRoot=sourceRoot;this.onStatus=onStatus;this.pending=new Map();this.gateways=new Map();this.logs=[];}
  record(state,message){const item={at:new Date().toISOString(),state,message};this.logs.push(item);this.logs=this.logs.slice(-80);this.onStatus?.({source:'qq',...item});}
  async locate(preferred){
    const roots=[preferred,this.runtimeRoot,process.env.JJB_SNOWLUMA_HOME, 'D:\\software\\SnowLuma',path.join(process.env.LOCALAPPDATA||'','SnowLuma'),path.join(process.env.USERPROFILE||'','Desktop','SnowLuma')].filter(Boolean);
    for(const root of roots){try{const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));await fs.access(path.join(root,'index.mjs'));if(pkg.name==='@snowluma/runtime')return{root,version:pkg.version};}catch{}}
    throw new Error('尚未找到 SnowLuma 运行时，请在高级设置中选择已安装目录');
  }
  async start(preferred){
    if(this.child&&this.ready)return;
    if(this.starting)return this.starting;
    this.starting=this._start(preferred).finally(()=>{this.starting=null;});return this.starting;
  }
  async _start(preferred){
    const runtime=await this.locate(preferred);this.runtime=runtime;
    const working=path.join(this.userData,'qq-runtime');await fs.mkdir(path.join(working,'config'),{recursive:true});
    await fs.writeFile(path.join(working,'config','runtime.json'),JSON.stringify({hookAutoLoad:false,webuiHost:'127.0.0.1'}));
    const hash=crypto.createHash('sha256');for(const [id,file] of [['eula','EULA.md'],['privacy','PRIVACY.md']]){hash.update(id+'\0');hash.update(await fs.readFile(path.join(runtime.root,file)));hash.update('\0');}const version=hash.digest('hex').slice(0,16);
    let accepted=false;for(const file of [path.join(working,'config','consent.json'),path.join(runtime.root,'config','consent.json'),path.join('D:\\software\\SnowLuma','config','consent.json')]){try{const v=JSON.parse(await fs.readFile(file,'utf8'));if(v.version===version){accepted=true;break;}}catch{}}
    if(!accepted){if(!await this.acceptConsent?.(runtime.root))throw new Error('请先同意 QQ 读取组件的用户协议和隐私政策');}
    await fs.writeFile(path.join(working,'config','consent.json'),JSON.stringify({version,acceptedAt:new Date().toISOString()}));
    const executable=process.platform==='win32'?path.join(runtime.root,'node.exe'):'node';
    const env={...process.env,JJB_MANAGED_SNOW:'1',JJB_SNOW_ENTRY:path.join(runtime.root,'index.mjs'),JJB_SNOW_BRIDGE:pathToFileURL(path.join(this.bridgeRoot,'snow-bridge.mjs')).href,SNOWLUMA_UPDATE_ROOT:runtime.root};delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(executable,['--experimental-loader',pathToFileURL(path.join(this.bridgeRoot,'snow-loader.mjs')).href,path.join(runtime.root,'index.mjs')],{cwd:working,windowsHide:true,env,stdio:['ignore','pipe','pipe','ipc']});this.child=child;
    child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
    child.on('message',message=>{
      if(message.kind==='ready'){this.ready=true;this.record('connected','QQ 读取引擎已就绪');}
      if(message.kind==='reply'){const item=this.pending.get(message.id);if(item){clearTimeout(item.timer);this.pending.delete(message.id);message.ok?item.resolve(message.data):item.reject(new Error(message.error));}}
      if(message.kind==='event'){const gateway=this.gateways.get(String(message.uin));if(gateway){for(const socket of gateway.wss.clients)if(socket.readyState===1)socket.send(JSON.stringify(message.event));}}
    });
    const exited=()=>{if(this.child===child){this.ready=false;this.child=null;this.record('error','QQ 读取引擎已退出，重新检测可恢复');}for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(new Error('QQ 引擎已断开'));}this.pending.clear();};
    child.once('error',exited);child.once('exit',exited);
    this.record('starting','正在启动 QQ 读取引擎');
    const deadline=Date.now()+30000;
    while(Date.now()<deadline&&!this.ready&&this.child)await new Promise(resolve=>setTimeout(resolve,150));
    if(!this.ready)throw new Error('QQ 引擎启动失败，请检查已安装运行时及授权状态');
  }
  call(method,params={}){
    if(!this.ready||!this.child?.connected)return Promise.reject(new Error('QQ 引擎未连接'));
    const id=crypto.randomUUID();return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('QQ 读取超时，请稍后重试'));},60000);
      this.pending.set(id,{resolve,reject,timer});this.child.send({id,method,...params});
    });
  }
  async discover(preferred){await this.start(preferred);const items=await this.call('processes');return{version:this.runtime.version,instances:items.map(p=>({pid:p.pid,uin:p.uin||'',nickname:p.nickname||'',status:p.status||'detected',path:p.path||p.exePath||'',accounts:(p.accounts||[]).map(a=>({uin:a.uin,nickname:a.nickname||''}))}))};}
  async attach(pid,preferred){await this.start(preferred);const account=await this.call('attach',{pid:Number(pid)});await this.gateway(account.uin);return account;}
  async gateway(uin){
    uin=String(uin);if(this.gateways.has(uin))return this.gateways.get(uin).config;
    const token=crypto.randomBytes(32).toString('base64url');
    const server=http.createServer(async(req,res)=>{
      res.setHeader('Content-Type','application/json');
      if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);return res.end('{}');}
      const action=req.url.slice(1);if(req.method!=='POST'||!READ_ACTIONS.has(action)){res.writeHead(404);return res.end('{}');}
      let body='';for await(const chunk of req){body+=chunk;if(body.length>100000){res.writeHead(413);return res.end('{}');}}
      try{const result=await this.call('action',{uin,action,params:JSON.parse(body||'{}')});res.end(JSON.stringify(result));}
      catch{res.writeHead(502);res.end(JSON.stringify({retcode:-1,message:'QQ 读取暂不可用'}));}
    });
    const wss=new WebSocketServer({noServer:true,maxPayload:1024**2});
    server.on('upgrade',(req,socket,head)=>{if(req.headers.authorization!=='Bearer '+token)return socket.destroy();wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const port=server.address().port;
    const config={qq_account:uin,qq_http_url:`http://127.0.0.1:${port}`,qq_ws_url:`ws://127.0.0.1:${port}`,qq_token:token};
    this.gateways.set(uin,{server,wss,config});return config;
  }
  async prepare(config){
    if(config.qq_transport!=='managed'||!(config.qq_chats||[]).length)return config;
    await this.start(config.snowluma_home);
    const {instances}=await this.discover(config.snowluma_home);
    let found=instances.find(p=>p.uin&&p.uin===String(config.qq_account));
    if(!found&&config.qq_pid)found=instances.find(p=>p.pid===Number(config.qq_pid)&&(!p.uin||p.uin===String(config.qq_account)));
    if(!found)throw new Error('未找到已选择的 QQ 实例，请在消息来源重新选择');
    const account=await this.attach(found.pid);return{...config,...await this.gateway(account.uin),qq_pid:found.pid};
  }
  async contacts(uin){
    const groups=await this.call('action',{uin,action:'get_group_list'});const friends=await this.call('action',{uin,action:'get_friend_list'});
    if(groups.retcode!==0||friends.retcode!==0)throw new Error('联系人暂不可读取，请稍后重试');
    return{account:String(uin),conversations:[...(groups.data||[]).map(g=>({id:'group:'+g.group_id,name:g.group_name||String(g.group_id),source:'qq'})),...(friends.data||[]).map(f=>({id:'private:'+f.user_id,name:f.remark||f.nickname||String(f.user_id),source:'qq'}))]};
  }
  diagnostics(){return{ready:!!this.ready,runtime:this.runtime?{root:this.runtime.root,version:this.runtime.version}:null,connected_accounts:[...this.gateways.keys()],logs:this.logs};}
  stop(){this.onStatus=undefined;for(const g of this.gateways.values()){for(const s of g.wss.clients)s.terminate();g.wss.close();g.server.close();}this.gateways.clear();this.child?.kill();}
}
module.exports={QQManager,READ_ACTIONS};
