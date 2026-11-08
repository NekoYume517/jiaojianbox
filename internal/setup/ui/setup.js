import * as runtime from '/wails/runtime.js';
const call=(method,...args)=>runtime.Call.ByName('github.com/NekoYume517/jiaojianbox/internal/setup.Installer.'+method,...args);
const $=id=>document.getElementById(id);let finished=false,busy=false;
try{const info=await call('Info');$('version').textContent='交件箱 / '+info.version;$('directory').value=info.directory;}catch(e){$('error').textContent=e.message;}
runtime.Events.On('install-progress',e=>{$('progress').value=e.data.percent;$('progress-text').textContent=e.data.message;});
$('choose').onclick=async()=>{try{const dir=await call('ChooseDirectory');if(dir)$('directory').value=dir;}catch(e){$('error').textContent=e.message;}};
$('close').onclick=()=>{if(!busy)call('Finish',false);};
$('install').onclick=async()=>{if(finished){await call('Finish',true);return}busy=true;$('error').textContent='';$('install').disabled=true;$('close').disabled=true;$('choose').disabled=true;$('status').hidden=false;
try{const result=await call('Install',{directory:$('directory').value,desktop:$('desktop').checked,startMenu:$('start-menu').checked});finished=true;$('options').hidden=true;$('progress').value=100;$('heading').textContent='交件箱已安装';$('intro').textContent='随时接收通知，整理材料，完成待办。';$('progress-text').textContent=result.directory;$('footnote').textContent='账号与本机数据会在更新时保留';$('install').textContent='打开交件箱';if(result.warning)$('error').textContent=result.warning;}catch(e){$('error').textContent=e.message;$('progress-text').textContent='安装未完成，可调整后重试。';}finally{busy=false;$('install').disabled=false;$('close').disabled=false;$('choose').disabled=false;}};
