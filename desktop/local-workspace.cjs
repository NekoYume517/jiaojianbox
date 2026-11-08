const {spawn} = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
class LocalWorkspace {
  constructor(options) { Object.assign(this,options); }
  async start() {
    if(this.pending)return this.pending;
    if(this.session&&this.child&&this.child.exitCode===null)return this.session;
    this.pending=this.launch().finally(()=>{this.pending=null;});return this.pending;
  }
  async launch() {
    let credentials=await this.get('offline-credentials');
    if(!credentials){credentials={password:crypto.randomBytes(36).toString('base64url')};await this.put('offline-credentials',credentials);}
    const child=spawn(this.python,this.pythonArgs||['-u','-m','server.local'],{cwd:this.root,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});
    this.child=child;child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify({data_dir:path.join(this.userData,'offline-workspace'),password:credentials.password})+'\n');
    try {
      const port=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{child.kill();reject(new Error('离线工作区启动超时'));},30000);let buffer='';
        child.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const event=JSON.parse(line);if(event.port){clearTimeout(timer);resolve(event.port);}}catch{}}});
        child.once('error',()=>{clearTimeout(timer);reject(new Error('内置离线组件不可用，请重新安装完整桌面版'));});
        child.once('exit',()=>{clearTimeout(timer);reject(new Error('离线工作区启动失败，请检查本机存储空间'));});
      });
      const server='http://127.0.0.1:'+port;
      for(let i=0;i<60;i++) {
        if(child.exitCode!==null)throw new Error('离线工作区已停止');
        try {const r=await fetch(server+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'offline',password:credentials.password}),signal:AbortSignal.timeout(1500)});if(r.ok){this.session={...await r.json(),server,mode:'offline'};return this.session;}}catch{}
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      throw new Error('离线工作区尚未就绪，请重试');
    }catch(error){child.kill();this.child=null;throw error;}
  }
  stop(){this.child?.kill();this.child=null;this.session=null;}
}
module.exports={LocalWorkspace};
