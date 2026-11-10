import {createInterface} from 'node:readline';
const READ_ACTIONS=new Set(['get_login_info','get_group_list','get_friend_list','get_group_msg_history','get_friend_msg_history','get_msg','get_status','get_version_info']);
export async function start({hookManager,oneBotManager}){
  const subscriptions=new Map();
  const stdio=process.env.JJB_SNOW_STDIO==='1';
  let closing=false, parentTimer;
  // Only stop this bridge. QQ is an external application, not an owned child.
  const shutdown=()=>{
    if(closing)return;closing=true;
    clearInterval(timer);clearInterval(parentTimer);
    for(const unsubscribe of subscriptions.values())try{unsubscribe?.();}catch{}
    subscriptions.clear();process.exit(0);
  };
  const send=value=>{
    if(closing)return;
    if(stdio)process.stdout.write(JSON.stringify(value)+'\n',error=>{if(error)shutdown();});
    else if(process.connected)process.send(value,error=>{if(error)shutdown();});
  };
  const timer=setInterval(()=>{
    for(const instance of oneBotManager.getInstances())if(!subscriptions.has(instance.uin)){
      subscriptions.set(instance.uin,instance.subscribeDebugEvents(event=>send({kind:'event',uin:instance.uin,event})));
    }
  },250);timer.unref();
  const receive=async request=>{
    if(!request?.id)return;
    try{
      let data;
      if(request.method==='processes')data=await hookManager.listProcesses();
      else if(request.method==='attach'){
        const pid=Number(request.pid);
        const discovered=await hookManager.listProcesses();
        if(!Number.isSafeInteger(pid)||!discovered.some(p=>p.pid===pid))throw new Error('所选 QQ 实例已退出，请重新检测');
        await hookManager.loadProcess(pid);
        const deadline=Date.now()+45000;
        while(Date.now()<deadline){
          const item=(await hookManager.listProcesses()).find(p=>p.pid===pid);
          const uin=item?.uin;
          if(uin&&oneBotManager.getInstance(String(uin))){data={pid,uin:String(uin),nickname:oneBotManager.getInstance(String(uin)).nickname};break;}
          await new Promise(resolve=>setTimeout(resolve,400));
        }
        if(!data)throw new Error('QQ 尚未完成登录或实例连接超时');
      }else if(request.method==='action'){
        if(!READ_ACTIONS.has(request.action))throw new Error('调试只允许读取动作');
        const instance=oneBotManager.getInstance(String(request.uin));
        if(!instance)throw new Error('QQ 账号尚未连接');
        data=await instance.invokeAction(request.action,request.params||{});
      }else throw new Error('不支持的运行时操作');
      send({kind:'reply',id:request.id,ok:true,data});
    }catch(error){send({kind:'reply',id:request.id,ok:false,error:String(error.message||'QQ 连接失败')});}
  };
  if(stdio){
    createInterface({input:process.stdin}).on('line',line=>{try{receive(JSON.parse(line));}catch{}}).once('close',shutdown);
    process.stdin.once('end',shutdown);process.stdin.once('close',shutdown);process.stdin.once('error',shutdown);
    process.stdout.once('error',shutdown);
  }else{process.on('message',receive);process.once('disconnect',shutdown);}
  process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
  // Pipe closure is primary; parent liveness also covers accidentally inherited pipes.
  const parent=Number(process.env.JJB_SNOW_PARENT_PID||process.ppid);
  if(Number.isSafeInteger(parent)&&parent>0&&parent!==process.pid){
    parentTimer=setInterval(()=>{try{process.kill(parent,0);}catch(error){if(error.code==='ESRCH')shutdown();}},1000);
    parentTimer.unref();
  }
  send({kind:'ready'});
}
