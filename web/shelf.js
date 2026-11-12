'use strict';
(() => {
  const drawer=$('#file-shelf');const backdrop=$('#shelf-backdrop');
  const drafts=new Map();const uploadingFiles=new Map();const analyzing=new Set();let open=false,lastFocus,dragTimer;
  const categories={inbox:'待整理',reference:'参考资料',receipt:'提交回执',other:'其他文件',material:'待办材料'};
  const gb=value=>`${(value/1073741824).toFixed(value%1073741824===0?0:1).replace(/\.0$/,'')} GB`;
  async function refreshStorage(){
    const chip=$('#storage-usage');if(!chip)return;
    if(!state.session||state.session.mode==='offline'){chip.hidden=true;return;}
    try{
      const info=await api('/api/storage');
      chip.textContent=info.unlimited?`${gb(Number(info.used))} · 不限量`:`${gb(Number(info.used))} / ${gb(Number(info.quota))}`;
      chip.hidden=false;
    }catch{chip.hidden=true;}
  }
  function files(){return state.snapshot.shelf||[];}
  function show(){
    if(!state.session){toast('登录后即可收纳文件');return;}
    if(open)return;
    lastFocus=document.activeElement;open=true;drawer.hidden=false;backdrop.hidden=false;requestAnimationFrame(()=>{drawer.classList.add('show');backdrop.classList.add('show');});document.body.classList.add('shelf-open');renderShelf();
  }
  function hide(){open=false;drawer.classList.remove('show');backdrop.classList.remove('show');setTimeout(()=>{if(!open){drawer.hidden=true;backdrop.hidden=true;}},220);document.body.classList.remove('shelf-open');lastFocus?.focus?.();}
  function updateFile(file){const current=files().filter(x=>x.id!==file.id);state.snapshot.shelf=[file,...current].sort((a,b)=>b.created_at.localeCompare(a.created_at));cacheSoon();renderShelf();}
  function controls(file){
    const draft=drafts.get(file.id);const taskId=draft?.taskId??file.task_id??'';
    const kind=draft?.kind??(file.task_id?file.kind:file.category);
    const tasks=state.snapshot.tasks.filter(t=>t.status!=='archived'||t.id===file.task_id);
    const options=[['','暂不关联待办'],...tasks.map(t=>[t.id,t.title+(t.status==='archived'?'（已归档）':t.status==='submitted'?'（已提交）':'')])];
    if(taskId&&!tasks.some(t=>t.id===taskId))options.push([taskId,'当前关联待办（未加载）']);
    const kinds=taskId?[['material','待办材料'],['receipt','提交回执']]:[['inbox','待整理'],['reference','参考资料'],['receipt','未关联回执'],['other','其他文件']];
    return `<div class="shelf-placement"><label class="shelf-select-label">归属待办<select data-shelf-task="${file.id}" data-segment-wrap="wrap" aria-label="${esc(file.name)}的归属待办">${options.map(([id,title])=>`<option value="${esc(id)}" ${id===taskId?'selected':''}>${esc(title)}</option>`).join('')}</select></label><label class="shelf-select-label">文件用途<select data-shelf-kind="${file.id}" data-segment-wrap="wrap" aria-label="${esc(file.name)}的文件用途">${kinds.map(([id,title])=>`<option value="${id}" ${id===kind?'selected':''}>${title}</option>`).join('')}</select></label></div>${draft?'<p class="helper shelf-draft-note">选择尚未应用，点击“应用”后才会改变实际归属。</p>':''}`;
  }
  function renderShelf(){
    const list=document.querySelector('#files-page-list');if(list)list.innerHTML=fileRows();
    const pending=files().filter(f=>!f.task_id&&f.category==='inbox').length;
    const count=$('#shelf-count'),handle=$('#shelf-handle');
    count.textContent=pending;count.hidden=!pending;
    const label=pending?`打开文件收纳，${pending} 条待整理`:'打开文件收纳';
    handle.title=label;handle.setAttribute('aria-label',label);
    if(!open)return;
    const pendingUploads=[...uploadingFiles.values()].map(f=>`<article class="shelf-file"><strong>${esc(f.name)}</strong><p class="helper">${esc(f.status)}</p></article>`).join('');
    $('#shelf-files').innerHTML=pendingUploads+files().map(file=>{
      const task=state.snapshot.tasks.find(t=>t.id===file.task_id);const suggestion=file.suggestion;
      const draft=drafts.get(file.id);
return `<article class="shelf-file"><div class="shelf-file-title"><span class="file-icon" data-ext="${esc(file.name.split('.').pop().toLowerCase().slice(0,5))}">${esc(file.name.split('.').pop().slice(0,5))}</span><div><strong>${esc(file.name)}</strong><small>${bytes(file.size)} · ${task?'已放入待办':esc(categories[file.category]||'待整理')}</small></div><button class="icon-button" data-shelf-preview="${file.id}" data-name="${esc(file.name)}" aria-label="预览 ${esc(file.name)}">◫</button><button class="icon-button" data-shelf-download="${file.id}" aria-label="下载 ${esc(file.name)}">↓</button></div>${task?`<div class="shelf-task-label">${icon('check')}<span>${esc(task.title)} · ${file.kind==='receipt'?'提交回执':'待办材料'}</span></div>`:''}${analyzing.has(file.id)?window.liveAnalysis?.markup('file:'+file.id)||'<p class="helper">AI 正在匹配待办…</p>':suggestion?`<p class="shelf-reason">${esc(suggestion.reason)}</p>${window.liveAnalysis?.performance(suggestion)||''}${suggestion.task_id||suggestion.evidence?`<button class="shelf-badge" data-shelf-why="${file.id}">${icon('search')}依据原文 · 点击展开</button><div class="shelf-evidence" data-evidence="${file.id}">${esc(suggestion.evidence||'模型未返回原文依据')}</div><p class="helper">${suggestion.image_analyzed?'图片内容参与分析':suggestion.extracted_characters+' 字'} · 置信度 ${Math.round((suggestion.confidence||0)*100)}%</p>`:`<p class="helper">${esc(suggestion.extraction)}${suggestion.image_analyzed?'':' · '+suggestion.extracted_characters+' 字'}</p>`}`:'<p class="helper">可以交给 AI 判断，也可以直接选择归属。</p>'}${controls(file)}<div class="detail-actions"><button class="secondary" data-shelf-assign="${file.id}" ${draft?'':'disabled'}>应用</button><button class="plain-button" data-shelf-analyze="${file.id}" ${analyzing.has(file.id)||draft?'disabled':''}>${suggestion?'重新判断':'AI 整理'}</button>${draft?`<button class="plain-button" data-shelf-cancel="${file.id}">取消修改</button>`:''}${file.task_id?`<button class="plain-button" data-shelf-undo="${file.id}">取消关联</button>`:''}<button class="plain-button" data-shelf-delete="${file.id}">移入回收站</button></div></article>`;
    }).join('')+(!files().length&&!uploadingFiles.size?`<div class="empty">${icon('file')}<strong>把文件放在这里</strong><div>不用先想分类。AI 会结合你的待办，寻找合适的归属。</div></div>`:'');
  }
  async function analyzeFile(id){
    const generation=state.generation;const previousTask=files().find(f=>f.id===id)?.task_id;
    analyzing.add(id);renderShelf();
    try{const file=await liveAnalysis.run('/api/shelf/'+id+'/suggest',{auto_assign:$('#shelf-auto-assign').checked},'file:'+id);if(generation!==state.generation)return;updateFile(file);await refresh({renderPage:false});toast(previousTask?'已更新分析建议，现有归属保持不变':file.task_id?'已自动放入对应待办':'已给出分类建议，可以手动调整');}
    catch(error){toast(error.message);}finally{analyzing.delete(id);renderShelf();}
  }
  async function addFiles(incoming){
    if(state.page!=='files')show();if(!state.session)return;const generation=state.generation;
    for(const file of incoming){
      if(generation!==state.generation)return;const key=crypto.randomUUID();uploadingFiles.set(key,{name:file.name,status:'正在放入收纳框…'});renderShelf();
      try{const form=new FormData();form.append('file',file);const saved=await apiUpload('/api/shelf',form,uploadTracker(file.name));if(generation!==state.generation)return;uploadingFiles.delete(key);hideUploadProgress();updateFile(saved);analyzeFile(saved.id);refreshStorage();}
      catch(error){hideUploadProgress();uploadingFiles.set(key,{name:file.name,status:error.message+'，请重新拖入。'});renderShelf();}
    }
  }
  $('#shelf-handle').addEventListener('click',show);$('#close-shelf').addEventListener('click',hide);backdrop.addEventListener('click',hide);
  $('#shelf-file-input').addEventListener('change',event=>{const list=[...event.target.files];event.target.value='';addFiles(list);});
  const isFileDrag=event=>[...event.dataTransfer?.types||[]].includes('Files');
  const explicitTarget=target=>target instanceof Element?target.closest('.drop-zone,input[type="file"],.shelf-drop,[data-task]'):null;
  function clearDrag(){clearTimeout(dragTimer);document.body.classList.remove('dragging-files');document.querySelectorAll('.drag-target').forEach(el=>el.classList.remove('drag-target'));}
  function markTarget(target){document.querySelectorAll('.drag-target').forEach(el=>{if(el!==target)el.classList.remove('drag-target');});target?.classList.add('drag-target');}
  document.addEventListener('dragenter',event=>{if(isFileDrag(event)){clearTimeout(dragTimer);markTarget(event.target instanceof Element?event.target.closest('.drop-zone,[data-task]'):null);}});
  document.addEventListener('dragover',event=>{if(!isFileDrag(event))return;event.preventDefault();event.dataTransfer.dropEffect='copy';markTarget(event.target instanceof Element?event.target.closest('.drop-zone,[data-task]'):null);});
  document.addEventListener('drop',async event=>{
    if(window.desktop?.nativeFileDrop){clearDrag();return;}
    if(!event.dataTransfer?.files.length)return;
    const incoming=[...event.dataTransfer.files];const target=explicitTarget(event.target);clearDrag();
    if(target){
      if(target.dataset.task){event.preventDefault();event.stopPropagation();if(uploading){toast('正在上传，请稍候再放入文件');return;}try{await uploadFiles({files:incoming,value:''},'material',target.dataset.task);}catch(error){toast(error.message);}return;}
      const input=target.matches('input[type="file"]')?target:target.querySelector('input[type="file"]');
      if(!input||input.id==='shelf-file-input')return; // Text inputs and the shelf picker keep their own handlers.
      if(!['material-upload','receipt-upload'].includes(input.id))return;
      event.preventDefault();event.stopPropagation();
      if(input.disabled||uploading){toast(input.disabled?'请先同步待办后添加文件':'正在上传，请稍候再放入文件');return;}
      try{await uploadFiles({files:incoming,value:''},input.id==='receipt-upload'?'receipt':'material');}catch(error){toast(error.message);}return;
    }
    event.preventDefault();
    const blank=event.target instanceof Element&&event.target.closest('#workspace .main')&&!event.target.closest('button,a,input,textarea,select,[contenteditable],dialog');
    if(blank)addFiles(incoming);
  });
  document.addEventListener('dragleave',event=>{if(!event.relatedTarget)dragTimer=setTimeout(clearDrag,60);});
  document.addEventListener('dragend',clearDrag);
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
  drawer.addEventListener('change',event=>{
    const id=event.target.dataset.shelfTask||event.target.dataset.shelfKind;if(!id)return;
    const file=files().find(f=>f.id===id);if(!file)return;
    const taskId=drawer.querySelector('[data-shelf-task="'+id+'"]').value;
    let kind=drawer.querySelector('[data-shelf-kind="'+id+'"]').value;
    if(taskId&&!['material','receipt'].includes(kind))kind='material';if(!taskId&&kind==='material')kind='inbox';
    drafts.set(id,{taskId,kind,version:drafts.get(id)?.version??file.version});
    if(analyzing.has(id))window.liveAnalysis?.cancel('file:'+id);
    renderShelf();drawer.querySelector('[data-shelf-'+(event.target.dataset.shelfTask?'task':'kind')+'="'+id+'"]').focus();
  });
  drawer.addEventListener('click',async event=>{
    const badge=event.target.closest('[data-shelf-why]');
    if(badge){const panel=drawer.querySelector(`[data-evidence="${badge.dataset.shelfWhy}"]`);if(panel)panel.classList.toggle('open');return;}
    const button=event.target.closest('button');if(!button)return;
    if(button.dataset.shelfCancel){drafts.delete(button.dataset.shelfCancel);renderShelf();return;}
    const id=button.dataset.shelfAssign||button.dataset.shelfUndo||button.dataset.shelfAnalyze||button.dataset.shelfDelete||button.dataset.shelfDownload;
    const file=files().find(x=>x.id===id);if(!file)return;
    try{
      if(button.dataset.shelfAnalyze)return analyzeFile(id);
      if(button.dataset.shelfDownload)return saveDownload('/api/files/'+id,file.name);
      if(button.dataset.shelfDelete){if(!confirm('把这份云端文件移入回收站？本机原文件会保留，30 天内可恢复。'))return;await api('/api/shelf/'+id+'?version='+file.version,'DELETE');state.snapshot.shelf=files().filter(f=>f.id!==id);cacheSoon();renderShelf();await refresh({renderPage:false});toast('已移入回收站，原文件仍保留在电脑中');return;}
      const draft=drafts.get(id);
      if(!button.dataset.shelfUndo&&!draft)return;
      const result=await api('/api/shelf/'+id,'PUT',{task_id:button.dataset.shelfUndo?null:draft.taskId||null,category:button.dataset.shelfUndo?'inbox':draft.kind,version:button.dataset.shelfUndo?file.version:draft.version});drafts.delete(id);updateFile(result);await refresh({renderPage:false});toast(result.task_id?'已更新待办归属和文件用途':'已更新文件用途，当前未关联待办');
    }catch(error){if(error.status===409){await refresh({renderPage:false});const current=files().find(f=>f.id===id);if(current&&drafts.has(id))drafts.get(id).version=current.version;else drafts.delete(id);renderShelf();toast('实际归属已更新，请核对后再次应用你的选择');}else toast(error.message);}
  });
  window.addEventListener('snapshot-updated',()=>{document.body.classList.remove('dragging-files');renderShelf();});
  function fileRows(){
    const rows=files();
    const pending=[...uploadingFiles.values()].map(file=>`<tr><td colspan="4"><strong>${esc(file.name)}</strong><small>${esc(file.status)}</small></td></tr>`).join('');
    if(!rows.length&&!pending)return empty('暂无文件','拖入文件，或点击“添加文件”开始整理。');
    return `<div class="files-table-wrap"><table class="files-table"><thead><tr><th>文件</th><th>用途</th><th class="file-place">关联待办</th><th></th></tr></thead><tbody>${pending}${rows.map(file=>{const task=state.snapshot.tasks.find(t=>t.id===file.task_id);return `<tr><td><div class="file-name-cell"><span class="file-icon">${esc(file.name.split('.').pop().slice(0,4).toUpperCase())}</span><div><span class="file-title" title="${esc(file.name)}">${esc(file.name)}</span><small>${bytes(file.size)} · ${formatDate(file.created_at)}</small></div></div></td><td>${tag(categories[file.task_id?file.kind:file.category]||'待整理')}</td><td class="file-place">${task?`<button class="link" data-files-task="${esc(task.id)}">${esc(task.title)}</button>`:'—'}</td><td class="file-controls"><button class="plain-button" data-preview-file="${file.id}" data-name="${esc(file.name)}">预览</button><button class="plain-button" data-files-download="${file.id}">下载</button><button class="secondary" data-files-edit="${file.id}">整理</button></td></tr>`;}).join('')}</tbody></table></div>`;
  }
  function page(){return heading('文件','集中查看材料、参考资料与提交回执。', '<span id="storage-usage" class="storage-usage" hidden></span><button class="primary" data-files-add>添加文件</button>')+`<div class="files-drop" data-file-drop-target>拖入文件，AI 会结合内容与待办建议归属</div><section class="panel" id="files-page-list">${fileRows()}</section>`;}
  document.addEventListener('click',async event=>{
    const button=event.target.closest('[data-files-add],[data-files-edit],[data-files-download],[data-files-task]');if(!button)return;
    if(button.hasAttribute('data-files-add'))return $('#shelf-file-input').click();
    if(button.dataset.filesDownload){const file=files().find(f=>f.id===button.dataset.filesDownload);if(file)return saveDownload('/api/files/'+file.id,file.name);}
    if(button.dataset.filesEdit){show();drawer.querySelector(`[data-shelf-assign="${button.dataset.filesEdit}"]`)?.closest('.shelf-file')?.scrollIntoView({block:'start'});}
    if(button.dataset.filesTask){await navigate('tasks');state.taskId=button.dataset.filesTask;render();}
  });
  window.shelf={page,show,hide,addFiles,refresh:renderShelf,refreshStorage,reset:()=>{drafts.clear();uploadingFiles.clear();analyzing.clear();hide();}};
  window.desktop?.onEdgeFiles?.(async items=>{
    show();if(!state.session)return;
    try{const saved=await desktop.importEdgeFiles(items);for(const file of saved){updateFile(file);analyzeFile(file.id);}}catch(error){toast(error.message);}
  });
})();
