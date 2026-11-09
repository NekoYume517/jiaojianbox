import * as runtime from '/wails/runtime.js';

const call=(method,...args)=>runtime.Call.ByName('github.com/NekoYume517/jiaojianbox/internal/setup.Installer.'+method,...args);
const $=id=>document.getElementById(id);
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const views={welcome:$('welcome-view'),options:$('options-view'),status:$('status-view'),complete:$('complete-view')};
const steps=[views.welcome,views.options,views.status,views.complete];
let stage=0;
let currentView=views.welcome,viewAnimation,busy=false,finished=false,activeInfo=null,keyboard=true;
document.addEventListener("pointerdown",()=>{keyboard=false;document.documentElement.dataset.input='pointer'},{capture:true});
document.addEventListener("keydown",()=>{keyboard=true;document.documentElement.dataset.input='keyboard'},{capture:true});
reduced.addEventListener("change",()=>{if(reduced.matches)viewAnimation?.cancel()});

function play(element,frames,options){
  try{return element.animate(frames,options)}catch{return null}
}
function setChip(text){$('state-chip').textContent=text}
function setError(text){$('error').textContent=text||''}
function setProgress(percent,message){
  const value=Math.max(0,Math.min(100,Number(percent)||0));
  document.querySelector('[role=progressbar]').setAttribute('aria-valuenow',String(value));
  $('progress-fill').style.transform=`scaleX(${value/100})`;
  $('progress-percent').textContent=`${Math.round(value)}%`;
  if(message)$('progress-text').textContent=message;
}
async function showView(next){
  const previous=currentView;
  if(previous===next)return;
  currentView=next;
  viewAnimation?.cancel();
  const swap=()=>{
    for(const view of Object.values(views))view.hidden=view!==next;
  };
  if(!previous.getClientRects().length||keyboard||reduced.matches||document.hidden){swap();return}
  viewAnimation=play(previous,[{opacity:1,transform:'none'},{opacity:0,transform:'translateY(-4px)'}],{duration:140,easing:'cubic-bezier(.23,1,.32,1)',fill:'forwards'});
  try{await Promise.race([viewAnimation?.finished,new Promise(resolve=>setTimeout(resolve,180))])}catch{}
  if(currentView!==next)return;
  viewAnimation?.cancel();swap();
  viewAnimation=play(next,[{opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'none'}],{duration:240,easing:'cubic-bezier(.2,.8,.2,1)'});
}
function goStep(index){
  stage=index;
  document.querySelector('.step-highlight').style.transform=`translateX(${index*100}%)`;
  document.querySelectorAll('.stepper li').forEach((item,i)=>{if(i===index)item.setAttribute('aria-current','step');else item.removeAttribute('aria-current')});
  $('previous').hidden=index!==1;
  $('install').textContent=index===0?'下一步':index===1?(activeInfo?.uninstall?'确认卸载':activeInfo?.update?'确认更新':'开始安装'):index===2?(activeInfo?.uninstall?'正在卸载…':activeInfo?.update?'正在更新…':'正在安装…'):'完成';
  showView(steps[index]);
}
async function applyDirectory(value,{announce=true}={}){
  try{
    const result=await call('ResolveDirectory',value||activeInfo?.directory||'');
    const target=result?.directory;
    if(!target)throw new Error('请选择安装位置');
    $('directory').value=target;
    $('path-hint').classList.remove('error');
    if(announce){
      $('path-hint').textContent=result.directory===activeInfo?.directory&&activeInfo?.update
        ?'已检测到现有安装，将保留数据并原地更新。'
        :'已选择可用的安装位置。';
      $('path-hint').classList.add('result');
    }
    return target;
  }catch(error){
    $('path-hint').textContent=error.message;
    $('path-hint').classList.add('error');
    return null;
  }
}
async function startInstall(){
  if(busy||finished)return;
  busy=true;setError('');
  const controls=[$('install'),$('previous'),$('close'),$('choose'),$('directory'),$('desktop'),$('start-menu')];
  controls.forEach(el=>el.disabled=true);
  setChip(activeInfo?.update?'正在更新':'安装中');$('progress-title').textContent=activeInfo?.update?'正在更新':'正在安装';
  $('progress-wrap').classList.remove('completed');setProgress(1,'正在检查安装位置…');
  try{
    const target=activeInfo?.uninstall?activeInfo.directory:await applyDirectory($('directory').value,{announce:false});
    if(!target)throw new Error($('path-hint').textContent);
    goStep(2);
    if(activeInfo?.uninstall){setChip('正在卸载');$('progress-title').textContent='正在卸载';$('operation-heading').textContent='正在卸载交件箱'}
    const result=activeInfo?.uninstall?await call('Uninstall'):await call('Install',{directory:target,desktop:$('desktop').checked,startMenu:$('start-menu').checked});
    finished=true;
    $('directory').value=result.directory;
    $('progress-wrap').classList.add('completed');
    $('progress-title').textContent='安装完成';
    setProgress(100,result.directory);
    $('heading').textContent='交件箱已准备好';
    $('intro').textContent='账号、通知、待办和本机数据会在更新时保留。';
    $('footnote').textContent=activeInfo?.uninstall?'本机工作空间和账号数据已保留':'账号与本机数据会在更新时保留';
    $('complete-heading').textContent=activeInfo?.uninstall?'交件箱已卸载':'交件箱已准备好';
    $('complete-intro').textContent=activeInfo?.uninstall?'程序已移除，本机工作空间和账号数据已保留。':'安装已完成，可以打开交件箱。';
    $('complete-path').textContent=result.directory;
    goStep(3);
    setChip('已完成');
    if(result.warning)setError(result.warning);
  }catch(error){
    $('progress-text').textContent='安装未完成，可调整后重试。';
    setError(error.message);
    setChip('未完成');
    goStep(1);
  }finally{
    busy=false;controls.forEach(el=>el.disabled=false);$('close').disabled=false;
  }
}

try{
  activeInfo=await call('Info');
  $('directory').value=activeInfo.directory;
  $('welcome-version').textContent='交件箱 '+activeInfo.version;
  if(activeInfo.uninstall){
    $('launch-option').hidden=true;
    document.title='卸载交件箱';$('window-label').textContent='交件箱卸载';
    $('welcome-heading').textContent='卸载交件箱';$('welcome-intro').textContent='仅移除程序文件，保留本机工作空间和账号数据。';
    $('welcome-features').innerHTML='<li>移除安装清单中的程序和采集组件</li><li>移除交件箱快捷方式和开机启动项</li><li>保留通知、待办、文件和账号数据</li>';
    $('heading').textContent='确认卸载';$('intro').textContent='确认要移除的程序位置。此操作不会删除本机数据。';
    $('directory').readOnly=true;$('choose').hidden=true;document.querySelector('.switches').hidden=true;
    $('path-hint').textContent='本机工作空间和账号数据会保留。';$('footnote').textContent='卸载只移除程序文件';
    document.querySelector('.stepper').setAttribute('aria-label','卸载步骤（仅显示进度）');
    ['卸载说明','确认','卸载','完成'].forEach((label,i)=>document.querySelectorAll('.step-label')[i].textContent=label);
  }
  $('desktop').checked=Boolean(activeInfo.desktop);
  $('start-menu').checked=Boolean(activeInfo.startMenu);
  if(activeInfo.update){

    $('version-badge').classList.add('update');
    $('version-badge').textContent=activeInfo.installedVersion?`${activeInfo.installedVersion} → ${activeInfo.version}`:`更新到 ${activeInfo.version}`;
    $('heading').textContent='确认更新交件箱';
    $('welcome-heading').textContent='更新交件箱';
    $('welcome-intro').textContent='已检测到现有安装，确认后将在原位置更新。';
    $('intro').textContent=`将更新到 ${activeInfo.version}，账号与本机数据会保留。点击“确认更新”后开始。`;
    $('path-hint').textContent='已检测到现有安装，将保留数据并原地更新。';
    $('path-hint').classList.add('result');
    setChip('准备更新');
  }else{
    $('version-badge').textContent=`交件箱 ${activeInfo.version}`;
    setChip(activeInfo.uninstall?'准备卸载':'准备安装');
  }
  $('install').disabled=false;
}catch(error){
  setError(error.message);
  setChip('初始化失败');
}

runtime.Events.On('install-progress',event=>{
  setProgress(event.data.percent,event.data.message);
});
$('choose').addEventListener('click',async()=>{
  try{
    const directory=await call('ChooseDirectory');
    if(directory){
      $('directory').value=directory;
      await applyDirectory(directory);
    }
  }catch(error){
    $('path-hint').textContent=error.message;
    $('path-hint').classList.add('error');
  }
});
$('directory').addEventListener('change',()=>applyDirectory($('directory').value));
$('install').addEventListener('click',async()=>{if(finished){try{await call('Finish',!activeInfo?.uninstall&&$('launch-app').checked)}catch(error){setError(error.message)}}else if(stage===0)goStep(1);else startInstall()});
$('previous').addEventListener('click',()=>{if(!busy&&!finished)goStep(0)});
$('close').addEventListener('click',()=>{if(!busy)call('Finish',false)});
// Detection prepares a review screen; only an explicit confirmation starts writes.
if(activeInfo?.update&&!activeInfo?.uninstall)goStep(1);
