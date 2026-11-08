const {BrowserWindow,ipcMain,screen,Tray,Menu,nativeImage,globalShortcut,app,dialog}=require('electron');
const {readEvents}=require('./read-events.cjs');
const path=require('node:path');const fs=require('node:fs/promises');const {openAsBlob}=require('node:fs');const {spawn}=require('node:child_process');
class EdgeWindow{
 constructor({root,main,get,put,resources}){this.root=root;this.main=main;this.get=get;this.resources=resources;this.put=put;this.preferences={enabled:true,drop:true,note:true,files:true};this.sessionGeneration=0;this.busy=false;this.expanded=false;this.stopping=false;}
 async api(route,method='GET',body){const generation=this.sessionGeneration;const s=await this.get('session');if(!s?.token)throw Error('请先打开主窗口登录');const r=await fetch(s.server.replace(/\/$/,'')+route+(route.endsWith('/suggest')?'?stream=true':''),{method,redirect:'error',headers:{Authorization:'Bearer '+s.token,...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},body:body instanceof FormData?body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(route.endsWith('/suggest')?190000:45000)});if(r.ok&&r.headers.get('content-type')?.includes('text/event-stream')){const result=await readEvents(r,value=>{if(generation!==this.sessionGeneration)return;const phase={extracting:'正在提取文件正文',request:'正在等待模型首字',receiving:'正在接收 AI 分类',validating:'正在校验归类结果',waiting:'模型仍在处理'}[value.stage]||'正在分析文件';this.send('edge-status',phase+(value.received_chars?' · '+value.received_chars+' 字':''));});if(generation!==this.sessionGeneration)throw Error('登录状态已变化');return result;}const data=await r.json();if(generation!==this.sessionGeneration)throw Error('登录状态已变化');if(!r.ok)throw Error(typeof data.detail==='string'?data.detail:'操作失败');return data;}
 async configure(value){this.preferences=Object.fromEntries(["enabled","drop","note","files"].map(k=>[k,value?.[k]!==false]));await this.put("quick-collection",this.preferences);this.send("edge-preferences",this.preferences);if(!this.preferences.enabled)this.show(false);return this.preferences;}
 async start(){
  this.preferences={...this.preferences,...await this.get("quick-collection")};this.position=await this.get("quick-position");
  this.win=new BrowserWindow({width:38,height:128,frame:false,resizable:false,skipTaskbar:true,alwaysOnTop:true,show:false,backgroundColor:'#19251e',webPreferences:{preload:path.join(__dirname,'edge-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  this.win.on('close',e=>{if(!this.stopping){e.preventDefault();this.show(false);}});
  this.win.setAlwaysOnTop(true,'floating');this.win.webContents.setWindowOpenHandler(()=>({action:'deny'}));this.win.webContents.on('will-navigate',e=>e.preventDefault());this.win.webContents.session.setPermissionRequestHandler((w,p,cb)=>cb(false));
  const handle=(name,fn)=>ipcMain.handle(name,(e,...args)=>{if(e.senderFrame!==this.win.webContents.mainFrame||e.senderFrame.url!=='app://jiaojianbox/edge.html')throw Error('请求来源无效');return fn(...args);});
  handle('edge-expand',v=>{this.auto=false;this.dragging=false;clearTimeout(this.releaseTimer);return this.show(!!v);});handle('edge-state',()=>this.snapshot());
  handle('edge-upload',paths=>this.upload(paths));
  handle('edge-choose',async()=>{const r=await dialog.showOpenDialog(this.win,{properties:['openFile','multiSelections']});return r.canceled?[]:this.upload(r.filePaths);});
  handle('edge-note',async({text,kind})=>{text=String(text||'').trim();if(!text||text.length>2000)throw Error('请填写内容（最多2000字）');if(kind==='task')await this.api('/api/tasks','POST',{title:text.slice(0,200),description:text});else{const s=await this.get('session');await this.api('/api/messages','POST',{source:'manual',account_id:s.user_id,conversation_id:'quick',conversation_name:'快捷收集',external_id:require('node:crypto').randomUUID(),sender_name:s.username,text,sent_at:new Date().toISOString()});}return this.snapshot();});
  handle('edge-main',()=>{this.main.show();this.main.focus();});
  this.win.on('moved',()=>{if(this.expanded&&process.env.JJB_TEST_OFFSCREEN!=='1'){const {x,y}=this.win.getBounds();this.position={x,y};clearTimeout(this.positionTimer);this.positionTimer=setTimeout(()=>this.put('quick-position',this.position).catch(()=>{}),250);}});
  await this.win.loadURL('app://jiaojianbox/edge.html');this.show(false);
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#2b634a"/><path d="M7 8h18v17H7zM7 17h6l3 4 3-4h6" fill="none" stroke="white" stroke-width="2"/></svg>';
  // Electron uses a PNG tray icon on Windows.
  const icon=nativeImage.createFromPath(path.join(this.resources,'tray.png'));
  this.tray=new Tray(icon.isEmpty()?nativeImage.createFromDataURL('data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64')):icon);
  this.tray.setToolTip('交件箱 · Ctrl+Alt+Space 快捷收集');this.tray.setContextMenu(Menu.buildFromTemplate([{label:'快捷收集',click:()=>this.show(true)},{label:'打开交件箱',click:()=>{this.main.show();this.main.focus();}},{type:'separator'},{label:'退出',click:()=>app.quit()}]));this.tray.on('double-click',()=>this.show(true));
  globalShortcut.register('CommandOrControl+Alt+Space',()=>{this.auto=false;clearTimeout(this.releaseTimer);this.show(!this.expanded);if(this.expanded)this.win.focus();});
  this.main.on('show',()=>{if(this.auto&&!this.busy)this.show(false);});
  this.main.on('restore',()=>{if(this.auto&&!this.busy)this.show(false);});
  this.main.on('close',e=>{if(!this.stopping){e.preventDefault();this.main.hide();}});
  if(process.platform==='win32'){
   this.watcher=spawn(path.join(this.resources,'drag-watch.exe'),[],{windowsHide:true,stdio:['ignore','pipe','ignore']});
   let pending='';
   this.watcher.stdout.on('data',chunk=>{pending+=chunk;let n;while((n=pending.indexOf('\n'))>=0){const event=pending.slice(0,n).trim();pending=pending.slice(n+1);
    if(event==='drag'){
      this.dragging=true;
      clearTimeout(this.releaseTimer);
      // 系统级拖动开始：始终弹出快捷窗（无论主窗口是否可见），由 hook 决定时机。
      if(!this.expanded&&!this.win.isDestroyed()){this.show(true);this.auto=true;}
    }else if(event==='release'&&this.auto){
      this.dragging=false;
      // 松开鼠标：光标在窗口上或窗口在前台时不关（用户可能正要拖入/在操作）；未放入文件才收起。
      clearTimeout(this.releaseTimer);
      this.releaseTimer=setTimeout(()=>{
        if(this.busy||!this.auto)return;
        const onWindow=this.isCursorOver()||this.win.isFocused();
        if(!onWindow){this.show(false);this.auto=false;}
      },900);
    }
   }});
   this.watcher.on('error',()=>{});
  }
 }
 show(expand){if(expand&&!this.preferences.enabled)return;if(!this.win||this.win.isDestroyed())return;const wasExpanded=this.expanded;this.expanded=expand;if(!expand){this.auto=false;this.dragging=false;clearTimeout(this.releaseTimer);this.send('edge-expanded',false);this.win.hide();return;}if(wasExpanded&&(this.dragging||(typeof this.win.isVisible==='function'&&this.win.isVisible()))){this.send('edge-preferences',this.preferences);this.send('edge-expanded',true);this.win.showInactive();this.win.moveTop();return;}const point=this.position&&Number.isFinite(this.position.x)&&Number.isFinite(this.position.y)?this.position:screen.getCursorScreenPoint();const a=screen.getDisplayNearestPoint(point).workArea;const width=360;const height=Math.min(a.height,460);const x=process.env.JJB_TEST_OFFSCREEN==='1'?-10000:this.position&&Number.isFinite(this.position.x)?Math.max(a.x,Math.min(a.x+a.width-width,this.position.x)):Math.max(a.x,Math.min(a.x+a.width-width,point.x));const y=process.env.JJB_TEST_OFFSCREEN==='1'?-10000:this.position&&Number.isFinite(this.position.y)?Math.max(a.y,Math.min(a.y+a.height-height,this.position.y)):Math.max(a.y,Math.min(a.y+a.height-height,point.y));this.win.setBounds({x,y,width,height},false);this.send('edge-preferences',this.preferences);this.send('edge-expanded',true);this.win.showInactive();this.win.moveTop();}
 isCursorOver(){if(!this.win||this.win.isDestroyed())return false;const b=this.win.getBounds();const p=screen.getCursorScreenPoint();return p.x>=b.x&&p.x<=b.x+b.width&&p.y>=b.y&&p.y<=b.y+b.height;}
 send(...args){if(this.win&&!this.win.isDestroyed()&&!this.win.webContents.isDestroyed())this.win.webContents.send(...args);}
 async snapshot(){try{const s=await this.api('/api/snapshot');return{files:(s.shelf||[]).slice(0,15).map(f=>({name:f.name,reason:f.suggestion?.reason||'',task:s.tasks.find(t=>t.id===f.task_id)?.title||''})),tasks:s.tasks.filter(t=>!['submitted','archived'].includes(t.status)).slice(0,8).map(t=>({title:t.title,due:t.due_at}))};}catch(e){return{error:e.message,files:[],tasks:[]};}}
 async upload(paths){if(this.busy)throw Error('正在收纳，请稍候');if(!Array.isArray(paths)||paths.length>30)throw Error('每次最多30个文件');this.busy=true;this.auto=false;clearTimeout(this.releaseTimer);this.show(true);const results=[];
 try{for(const p of paths){if(typeof p!=='string'||!path.isAbsolute(p))throw Error('文件路径无效');const stat=await fs.stat(p);if(!stat.isFile()||stat.size>50*1024**2)throw Error('仅支持50MB以内的文件');const form=new FormData();form.append('file',await openAsBlob(p),path.basename(p));const f=await this.api('/api/shelf','POST',form);results.push({name:f.name});this.send('edge-status','已收纳 '+f.name+'，正在匹配待办…');this.api('/api/shelf/'+f.id+'/suggest','POST',{auto_assign:true}).then(()=>this.send('edge-refresh')).catch(e=>this.send('edge-status','文件已保存；'+e.message));}return results;}finally{this.busy=false;this.send('edge-refresh');}}
 resetSession(){this.sessionGeneration++;this.show(false);}
 stop(){this.stopping=true;clearTimeout(this.releaseTimer);clearTimeout(this.positionTimer);this.watcher?.kill();this.tray?.destroy();globalShortcut.unregisterAll();this.win?.destroy();}
}
module.exports={EdgeWindow};
