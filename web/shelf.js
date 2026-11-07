'use strict';
(() => {
  const drawer=$('#file-shelf');const backdrop=$('#shelf-backdrop');
  const uploadingFiles=new Map();const analyzing=new Set();let open=false,lastFocus,dragTimer;
  const categories={inbox:'待整理',reference:'参考资料',receipt:'提交回执',other:'其他文件',material:'交件材料'};
  function files(){return state.snapshot.shelf||[];}
  function show(){
    if(!state.session){toast('登录后即可收纳文件');return;}
    if(!open)lastFocus=document.activeElement;open=true;drawer.hidden=false;backdrop.hidden=false;document.body.classList.add('shelf-open');renderShelf();
  }
  function hide(){open=false;drawer.hidden=true;backdrop.hidden=true;document.body.classList.remove('shelf-open');lastFocus?.focus?.();}
  function updateFile(file){const current=files().filter(x=>x.id!==file.id);state.snapshot.shelf=[file,...current].sort((a,b)=>b.created_at.localeCompare(a.created_at));cacheSoon();renderShelf();}
  function renderShelf(){
    $('#shelf-count').textContent=files().filter(f=>!f.task_id&&f.category==='inbox').length;
    if(!open)return;
    const pending=[...uploadingFiles.values()].map(f=>`<article class="shelf-file"><strong>${esc(f.name)}</strong><p class="helper">${esc(f.status)}</p></article>`).join('');
    $('#shelf-files').innerHTML=pending+files().map(file=>{
      const task=state.snapshot.tasks.find(t=>t.id===file.task_id);const suggestion=file.suggestion;
      const target=file.task_id||'category:'+(['reference','receipt','other'].includes(file.category)?file.category:'inbox');
      return `<article class="shelf-file"><div class="shelf-file-title"><span class="file-icon">${esc(file.name.split('.').pop().slice(0,5))}</span><div><strong>${esc(file.name)}</strong><small>${bytes(file.size)} · ${task?'已归档到待办':esc(categories[file.category]||'待整理')}</small></div><button class="icon-button" data-shelf-download="${file.id}" aria-label="下载 ${esc(file.name)}">↓</button></div>${task?`<div class="shelf-task-label">${icon('check')}<span>${esc(task.title)}</span></div>`:''}${analyzing.has(file.id)?'<p class="helper">AI 正在读取文件并匹配待办…</p>':suggestion?`<p class="shelf-reason">${esc(suggestion.reason)}</p><p class="helper">${esc(suggestion.extraction)} · ${suggestion.extracted_characters} 字</p>`:'<p class="helper">可以交给 AI 判断，也可以直接选择归属。</p>'}<label class="shelf-select-label">归到哪里<select data-shelf-target="${file.id}" aria-label="${esc(file.name)}的分类"><optgroup label="分类">${Object.entries(categories).filter(([key])=>key!=='material').map(([key,label])=>`<option value="category:${key}" ${target==='category:'+key?'selected':''}>${label}</option>`).join('')}</optgroup><optgroup label="我的待办">${state.snapshot.tasks.filter(t=>!['archived','submitted'].includes(t.status)).map(t=>`<option value="${t.id}" ${target===t.id?'selected':''}>${esc(t.title)}</option>`).join('')}</optgroup></select></label><div class="detail-actions"><button class="secondary" data-shelf-assign="${file.id}">应用分类</button><button class="plain-button" data-shelf-analyze="${file.id}" ${analyzing.has(file.id)?'disabled':''}>${suggestion?'重新判断':'AI 整理'}</button>${file.task_id?`<button class="plain-button" data-shelf-undo="${file.id}">撤销归档</button>`:''}<button class="plain-button" data-shelf-delete="${file.id}">删除</button></div></article>`;
    }).join('')+(!files().length&&!uploadingFiles.size?`<div class="empty">${icon('file')}<strong>把文件放在这里</strong><div>不用先想分类。AI 会结合你的待办，寻找合适的归属。</div></div>`:'');
  }
  async function analyzeFile(id){
    analyzing.add(id);renderShelf();
    try{const file=await api('/api/shelf/'+id+'/suggest','POST',{auto_assign:$('#shelf-auto-assign').checked});updateFile(file);await refresh({renderPage:false});toast(file.task_id?'已自动归档到对应待办':'已给出分类建议，可以手动调整');}
    catch(error){toast(error.message);}finally{analyzing.delete(id);renderShelf();}
  }
  async function addFiles(incoming){
    show();if(!state.session)return;
    for(const file of incoming){
      const key=crypto.randomUUID();uploadingFiles.set(key,{name:file.name,status:'正在放入收纳框…'});renderShelf();
      try{const form=new FormData();form.append('file',file);const saved=await api('/api/shelf','POST',form);uploadingFiles.delete(key);updateFile(saved);analyzeFile(saved.id);}
      catch(error){uploadingFiles.set(key,{name:file.name,status:error.message+'，请重新拖入。'});renderShelf();}
    }
  }
  $('#shelf-handle').addEventListener('click',show);$('#close-shelf').addEventListener('click',hide);backdrop.addEventListener('click',hide);
  $('#shelf-file-input').addEventListener('change',event=>{const list=[...event.target.files];event.target.value='';addFiles(list);});
  document.addEventListener('dragenter',event=>{if([...event.dataTransfer?.types||[]].includes('Files')){clearTimeout(dragTimer);show();}});
  document.addEventListener('dragover',event=>{if([...event.dataTransfer?.types||[]].includes('Files')&&!event.target.closest('.drop-zone')){event.preventDefault();event.dataTransfer.dropEffect='copy';}});
  document.addEventListener('drop',event=>{
    if(!event.dataTransfer?.files.length||event.target.closest('.drop-zone'))return;
    event.preventDefault();clearTimeout(dragTimer);addFiles([...event.dataTransfer.files]);
  });
  document.addEventListener('dragleave',event=>{if(!event.relatedTarget&&!files().length&&!uploadingFiles.size)dragTimer=setTimeout(hide,500);});
  document.addEventListener('keydown',event=>{
    if(!open)return;
    if(event.key==='Escape'){event.preventDefault();hide();}
    if(event.key==='Tab'){
      const focusable=[...drawer.querySelectorAll('button:not(:disabled),input,select,[tabindex="0"]')].filter(el=>el.getClientRects().length);
      const first=focusable[0],last=focusable.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
  });
  drawer.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button)return;
    const id=button.dataset.shelfAssign||button.dataset.shelfUndo||button.dataset.shelfAnalyze||button.dataset.shelfDelete||button.dataset.shelfDownload;
    const file=files().find(x=>x.id===id);if(!file)return;
    try{
      if(button.dataset.shelfAnalyze)return analyzeFile(id);
      if(button.dataset.shelfDownload)return saveDownload('/api/files/'+id,file.name);
      if(button.dataset.shelfDelete){if(confirm('删除这份云端文件？对应待办中的材料也会移除，本机原文件保持不变。')){await api('/api/shelf/'+id+'?version='+file.version,'DELETE');state.snapshot.shelf=files().filter(f=>f.id!==id);cacheSoon();renderShelf();await refresh({renderPage:false});}return;}
      const target=button.dataset.shelfUndo?'category:inbox':drawer.querySelector(`[data-shelf-target="${id}"]`).value;
      const category=target.startsWith('category:')?target.slice(9):'material';
      const result=await api('/api/shelf/'+id,'PUT',{task_id:target.startsWith('category:')?null:target,category,version:file.version});updateFile(result);await refresh({renderPage:false});toast('分类已更新');
    }catch(error){toast(error.message);}
  });
  window.addEventListener('snapshot-updated',renderShelf);
  window.shelf={show,hide,addFiles,refresh:renderShelf};
  window.desktop?.onEdgeFiles?.(async items=>{
    show();if(!state.session)return;
    try{const saved=await desktop.importEdgeFiles(items);for(const file of saved){updateFile(file);analyzeFile(file.id);}}catch(error){toast(error.message);}
  });
})();
